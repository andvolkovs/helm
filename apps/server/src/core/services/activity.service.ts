import { and, asc, desc, eq, gt, inArray, lt, max, ne, or, sql, type SQL } from 'drizzle-orm';
import { events, projects, tasks, type EventRow, type Tx } from '@helm/db';
import {
  ActivityQuery,
  type ActivityChange,
  type ActivityEntry,
  type ActivityPage,
  type Project,
  type Task,
} from '@helm/shared';
import { assertOwner, type Principal } from '../auth/principal.ts';
import { HelmError, notFound, parse } from '../errors.ts';
import { mutate, type Emit, type ServiceContext } from './context.ts';
import { toProject, toTask } from './mappers.ts';

/** Events from before batches existed stand alone, keyed by their own id. */
const batchKey = sql<string>`coalesce(${events.batchId}, 'e' || ${events.id})`;
const keyOf = (e: EventRow) => e.batchId ?? `e${e.id}`;
const inBatch = (key: string): SQL =>
  /^e\d+$/.test(key) ? and(eq(events.id, Number(key.slice(1))), sql`${events.batchId} is null`)! : eq(events.batchId, key);

/** Key words picked in the background (`keyed`) aren't changes anyone made: left out, never undone. */
const TRACKED = and(inArray(events.entity, ['task', 'project']), ne(events.action, 'keyed'));
const date = (iso: string | null) => (iso ? new Date(iso) : null);

/**
 * The activity log: who changed what, grouped by request, with the state before each change so
 * it can be shown and undone. Built from the append-only events table. Owner only.
 */
export class ActivityService {
  constructor(private readonly ctx: ServiceContext) {}

  list(p: Principal, query: unknown = {}): ActivityPage {
    assertOwner(p);
    const q = parse(ActivityQuery, query);
    const limit = q.limit ?? 30;
    const db = this.ctx.db;

    const touching = q.taskId
      ? inArray(batchKey, db.select({ k: batchKey }).from(events).where(eq(events.entityId, q.taskId)))
      : undefined;
    const batches = db
      .select({ key: batchKey, last: max(events.id) })
      .from(events)
      .where(and(TRACKED, q.who === 'agents' ? ne(events.actor, 'owner') : undefined, touching))
      .groupBy(batchKey)
      .having(q.cursor ? lt(max(events.id), q.cursor) : undefined)
      .orderBy(desc(max(events.id)))
      .limit(limit + 1)
      .all();
    const page = batches.slice(0, limit);
    const keys = page.map((b) => b.key);
    if (keys.length === 0) return { entries: [], nextCursor: null };

    const rows = db
      .select()
      .from(events)
      .where(and(TRACKED, inArray(batchKey, keys)))
      .orderBy(asc(events.id))
      .all();
    const undone = new Map(
      db
        .select({ of: events.undoOf, at: max(events.at) })
        .from(events)
        .where(inArray(events.undoOf, keys))
        .groupBy(events.undoOf)
        .all()
        .map((r) => [r.of!, r.at]),
    );

    const entries = page.map(({ key }): ActivityEntry => {
      const evs = rows.filter((e) => keyOf(e) === key);
      const first = evs[0]!;
      const undoneAt = undone.get(key) ?? null;
      return {
        batchId: key,
        at: first.at.toISOString(),
        actor: first.actor,
        changes: evs.map((e) => this.change(db, e)),
        cantUndo: undoneAt ? 'Already undone.' : this.whyNot(db, evs),
        undoneAt: undoneAt ? new Date(undoneAt).toISOString() : null,
        undoOf: first.undoOf,
      };
    });
    const last = page.at(-1)!;
    return { entries, nextCursor: batches.length > limit ? last.last : null };
  }

  /** Put everything a batch changed back the way it was, as one new (itself undoable) batch. */
  undo(p: Principal, key: string): { ok: true } {
    assertOwner(p);
    const evs = this.ctx.db.select().from(events).where(and(TRACKED, inBatch(key))).orderBy(asc(events.id)).all();
    if (evs.length === 0) throw notFound('Change');
    const done = this.ctx.db.select({ id: events.id }).from(events).where(eq(events.undoOf, key)).limit(1).get();
    const reason = done ? 'Already undone.' : this.whyNot(this.ctx.db, evs);
    if (reason) throw new HelmError('conflict', reason);

    // Each entity goes back to how it was before its first change in the batch.
    const firsts = new Map<string, EventRow>();
    for (const e of evs) if (!firsts.has(`${e.entity}:${e.entityId}`)) firsts.set(`${e.entity}:${e.entityId}`, e);

    mutate(
      this.ctx,
      p,
      (tx, emit) => {
        for (const e of [...firsts.values()].reverse()) {
          const before = this.before(tx, e);
          if (e.entity === 'task') this.restoreTask(tx, emit, e.entityId, before as Task | null);
          else this.restoreProject(tx, emit, e.entityId, before as Project | null);
        }
      },
      { undoOf: key },
    );
    return { ok: true };
  }

  // ---------- Helpers ----------

  private change(db: Tx, e: EventRow): ActivityChange {
    return {
      eventId: e.id,
      entity: e.entity as 'task' | 'project',
      entityId: e.entityId,
      action: e.action,
      before: this.before(db, e),
      after: e.data as Task | Project,
    };
  }

  /** The entity as it was just before this event: the previous event's snapshot (null = new). */
  private before(db: Tx, e: EventRow): Task | Project | null {
    if (e.action === 'created') return null;
    const prev = db
      .select({ data: events.data })
      .from(events)
      .where(and(eq(events.entity, e.entity), eq(events.entityId, e.entityId), lt(events.id, e.id)))
      .orderBy(desc(events.id))
      .limit(1)
      .get();
    return (prev?.data as Task | Project | undefined) ?? null;
  }

  /** Undoing is only safe while nothing has touched the same tasks or projects since. */
  private whyNot(db: Tx, evs: EventRow[]): string | null {
    if (evs.some((e) => e.entity === 'project' && e.action === 'deleted')) {
      return 'A deleted project can’t be brought back.';
    }
    const lastId = evs.at(-1)!.id;
    const later = db
      .select({ entity: events.entity, entityId: events.entityId, data: events.data })
      .from(events)
      .where(
        and(
          gt(events.id, lastId),
          ne(events.action, 'keyed'),
          or(...evs.map((e) => and(eq(events.entity, e.entity), eq(events.entityId, e.entityId)))),
        ),
      )
      .orderBy(asc(events.id))
      .limit(1)
      .get();
    if (!later) return null;
    const name = later.entity === 'task' ? `“${(later.data as Task).title}”` : `The project “${(later.data as Project).name}”`;
    return `${name} changed after this. Undo the later change first.`;
  }

  private restoreTask(tx: Tx, emit: Emit, id: string, before: Task | null): void {
    const cur = tx.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!cur) return;
    const now = this.ctx.now();
    let action: string;
    let fields: Partial<typeof tasks.$inferInsert>;
    if (!before) {
      // It was created in this batch: remove it again.
      if (cur.deletedAt) return;
      fields = { deletedAt: now };
      action = 'deleted';
    } else {
      // A project deleted since can't be returned to; the task goes to the Inbox instead.
      const projectId =
        before.projectId && tx.select({ id: projects.id }).from(projects).where(eq(projects.id, before.projectId)).get()
          ? before.projectId
          : null;
      fields = {
        title: before.title,
        notes: before.notes,
        projectId,
        priority: before.priority,
        estimateMinutes: before.estimateMinutes,
        status: before.status,
        parentTaskId: before.parentTaskId,
        position: before.position,
        startedAt: date(before.startedAt),
        completedAt: date(before.completedAt),
        deletedAt: date(before.deletedAt),
        agentState: before.agentState ?? null,
        agentClaimedBy: before.agentClaimedBy ?? null,
        // Events from before Today existed don't carry these.
        today: before.today ?? null,
        todayAt: date(before.todayAt ?? null),
        planDate: before.planDate ?? null,
        todayOnly: before.todayOnly ?? false,
        keyWords: before.keyWords ?? null,
      };
      action = cur.deletedAt && !before.deletedAt ? 'restored' : !cur.deletedAt && before.deletedAt ? 'deleted' : 'updated';
    }
    const row = tx.update(tasks).set({ ...fields, updatedAt: now }).where(eq(tasks.id, id)).returning().get()!;
    emit({ entity: 'task', entityId: id, projectId: row.projectId, action, data: toTask(row) });
  }

  private restoreProject(tx: Tx, emit: Emit, id: string, before: Project | null): void {
    const cur = tx.select().from(projects).where(eq(projects.id, id)).get();
    if (!cur) return;
    const now = this.ctx.now();
    const fields = before
      ? {
          name: before.name,
          color: before.color,
          icon: before.icon,
          collapsed: before.collapsed,
          position: before.position,
          archivedAt: date(before.archivedAt),
        }
      : { archivedAt: cur.archivedAt ?? now };
    const row = tx.update(projects).set({ ...fields, updatedAt: now }).where(eq(projects.id, id)).returning().get()!;
    const action = cur.archivedAt && !row.archivedAt ? 'restored' : !cur.archivedAt && row.archivedAt ? 'archived' : 'updated';
    emit({ entity: 'project', entityId: id, projectId: id, action, data: toProject(row) });
  }
}
