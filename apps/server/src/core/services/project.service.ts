import { and, asc, count, desc, eq, gt, inArray, isNull, lt, max, ne } from 'drizzle-orm';
import { projects, tasks, type ProjectRow, type Tx } from '@helm/db';
import {
  CreateProjectInput,
  MoveProjectInput,
  PROJECT_COLORS,
  ProjectListQuery,
  UpdateProjectInput,
  type Project,
} from '@helm/shared';
import { ulid } from 'ulidx';
import { assertGlobalWrite, assertOwner, assertRead, assertWrite, projectScope, type Principal } from '../auth/principal.ts';
import { notFound, parse } from '../errors.ts';
import { mutate, type ServiceContext } from './context.ts';
import { toProject, toTask } from './mappers.ts';
import { keyAfter, keyBetweenNeighbours } from './ordering.ts';

/** Load a live (non-archived) project or throw not_found. Shared with TaskService. */
export function getLiveProject(tx: Tx, id: string): ProjectRow {
  const row = tx.select().from(projects).where(eq(projects.id, id)).get();
  if (!row || row.archivedAt) throw notFound('Project');
  return row;
}

export class ProjectService {
  constructor(private readonly ctx: ServiceContext) {}

  list(p: Principal, query: unknown = {}): Project[] {
    const q = parse(ProjectListQuery, query);
    const scope = projectScope(p);
    return this.ctx.db
      .select()
      .from(projects)
      .where(and(q.includeArchived ? undefined : isNull(projects.archivedAt), scope ? inArray(projects.id, scope) : undefined))
      .orderBy(asc(projects.position), asc(projects.id))
      .all()
      .map(toProject);
  }

  get(p: Principal, id: string): Project {
    const row = getLiveProject(this.ctx.db, id);
    assertRead(p, row.id);
    return toProject(row);
  }

  create(p: Principal, input: unknown): Project {
    const i = parse(CreateProjectInput, input);
    assertGlobalWrite(p);
    return mutate(this.ctx, p, (tx, emit) => {
      const total = tx.select({ n: count() }).from(projects).get()?.n ?? 0;
      const last = tx.select({ v: max(projects.position) }).from(projects).get()?.v ?? null;
      const now = this.ctx.now();
      const row = tx
        .insert(projects)
        .values({
          id: ulid(),
          name: i.name,
          color: i.color ?? PROJECT_COLORS[total % PROJECT_COLORS.length]!,
          icon: i.icon ?? null,
          collapsed: false,
          position: keyAfter(last),
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      const dto = toProject(row);
      emit({ entity: 'project', entityId: row.id, projectId: row.id, action: 'created', data: dto });
      return dto;
    });
  }

  update(p: Principal, id: string, input: unknown): Project {
    const patch = parse(UpdateProjectInput, input);
    return mutate(this.ctx, p, (tx, emit) => {
      const row = getLiveProject(tx, id);
      assertWrite(p, row.id);
      if (Object.keys(patch).length === 0) return toProject(row);
      const updated = tx
        .update(projects)
        .set({ ...patch, updatedAt: this.ctx.now() })
        .where(eq(projects.id, id))
        .returning()
        .get()!;
      const dto = toProject(updated);
      emit({ entity: 'project', entityId: id, projectId: id, action: 'updated', data: dto });
      return dto;
    });
  }

  move(p: Principal, id: string, input: unknown): Project {
    const m = parse(MoveProjectInput, input);
    assertGlobalWrite(p);
    return mutate(this.ctx, p, (tx, emit) => {
      const row = getLiveProject(tx, id);
      if (!m.afterId && !m.beforeId) return toProject(row);

      const others = and(isNull(projects.archivedAt), ne(projects.id, id));
      const adjacent = (dir: 'next' | 'prev') => (pos: string) =>
        tx
          .select({ v: projects.position })
          .from(projects)
          .where(and(others, dir === 'next' ? gt(projects.position, pos) : lt(projects.position, pos)))
          .orderBy(dir === 'next' ? asc(projects.position) : desc(projects.position))
          .limit(1)
          .get()?.v ?? null;

      const position = keyBetweenNeighbours(
        m.afterId ? getLiveProject(tx, m.afterId).position : null,
        m.beforeId ? getLiveProject(tx, m.beforeId).position : null,
        adjacent('next'),
        adjacent('prev'),
      );
      const updated = tx
        .update(projects)
        .set({ position, updatedAt: this.ctx.now() })
        .where(eq(projects.id, id))
        .returning()
        .get()!;
      const dto = toProject(updated);
      emit({ entity: 'project', entityId: id, projectId: id, action: 'moved', data: dto });
      return dto;
    });
  }

  /** Archive (soft delete). Its tasks stay in the DB but drop off the board. Owner only. */
  archive(p: Principal, id: string): Project {
    assertOwner(p);
    return mutate(this.ctx, p, (tx, emit) => {
      getLiveProject(tx, id);
      const now = this.ctx.now();
      const updated = tx
        .update(projects)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(projects.id, id))
        .returning()
        .get()!;
      const dto = toProject(updated);
      emit({ entity: 'project', entityId: id, projectId: id, action: 'archived', data: dto });
      return dto;
    });
  }

  /**
   * Delete for good, archived or not. Its tasks (open and done, with subtasks) go too: they are
   * soft deleted like a deleted task, so they leave the board and the Done log.
   */
  remove(p: Principal, id: string): Project {
    // Owner only: this can't be undone.
    assertOwner(p);
    return mutate(this.ctx, p, (tx, emit) => {
      const row = tx.select().from(projects).where(eq(projects.id, id)).get();
      if (!row) throw notFound('Project');
      const now = this.ctx.now();
      const gone = tx
        .update(tasks)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(tasks.projectId, id), isNull(tasks.deletedAt)))
        .returning()
        .all();
      for (const t of gone) emit({ entity: 'task', entityId: t.id, projectId: id, action: 'deleted', data: toTask(t) });
      // Deleted tasks keep no project: the foreign key clears their project_id.
      tx.delete(projects).where(eq(projects.id, id)).run();
      const dto = toProject({ ...row, updatedAt: now });
      emit({ entity: 'project', entityId: id, projectId: id, action: 'deleted', data: dto });
      return dto;
    });
  }
}
