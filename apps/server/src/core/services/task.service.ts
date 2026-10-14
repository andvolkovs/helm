import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, max, ne, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { projects, tasks, type TaskRow, type Tx } from '@helm/db';
import {
  AppendNoteInput,
  ArrangeTasksInput,
  CreateTaskInput,
  SetAgentStateInput,
  DoneLogQuery,
  INBOX,
  MAX_TODAY_MAIN,
  MoveTaskInput,
  UpdateTaskInput,
  byPosition,
  computeFocus,
  dayKey,
  formatDay,
  planDayOf,
  shownDayOf,
  type AgentState,
  type DoneLogPage,
  type Focus,
  type Task,
  type TaskStatus,
  type TodaySlot,
} from '@helm/shared';
import { generateNKeysBetween } from 'fractional-indexing';
import { ulid } from 'ulidx';
import { actorOf, assertRead, assertWrite, projectScope, type Principal } from '../auth/principal.ts';
import { forbidden, HelmError, invalid, notFound, parse } from '../errors.ts';
import { mutate, type Emit, type ServiceContext } from './context.ts';
import { toTask } from './mappers.ts';
import { keyAfter, keyBetweenNeighbours } from './ordering.ts';
import { getLiveProject } from './project.service.ts';

type Patch = Partial<Omit<TaskRow, 'id' | 'createdAt'>>;

/** Who key-word picks are recorded as. */
const KEY_WORDS: Principal = { kind: 'owner', via: 'helm' };

const NOTES_MAX = 20_000;

/**
 * Where the request comes from. `timeZone` (IANA, from the app) says which day "today" is for
 * the user; without it the server's own zone is used.
 */
export interface Where {
  timeZone?: string;
}

export class TaskService {
  constructor(private readonly ctx: ServiceContext) {}

  // ---------- Reads ----------

  get(p: Principal, id: string): Task {
    const row = this.getRow(this.ctx.db, id);
    assertRead(p, row.projectId);
    return toTask(row);
  }

  /**
   * Everything the live board needs: all open tasks, plus done subtasks of open parents
   * (for "2/5" progress). Tasks in archived projects are excluded.
   */
  board(p: Principal): Task[] {
    const parent = alias(tasks, 'parent');
    return this.ctx.db
      .select()
      .from(tasks)
      .leftJoin(parent, eq(parent.id, tasks.parentTaskId))
      .leftJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(
          isNull(tasks.deletedAt),
          isNull(projects.archivedAt),
          or(
            ne(tasks.status, 'done'),
            and(isNotNull(tasks.parentTaskId), ne(parent.status, 'done'), isNull(parent.deletedAt)),
          ),
          this.scopeFilter(p),
        ),
      )
      .orderBy(asc(tasks.position), asc(tasks.id))
      .all()
      .map((r) => toTask(r.tasks));
  }

  /** Subtasks of a task, done ones included, in board order. */
  subtasks(p: Principal, id: string): Task[] {
    const parent = this.getRow(this.ctx.db, id);
    assertRead(p, parent.projectId);
    return this.children(this.ctx.db, id)
      .map(toTask)
      .sort(byPosition);
  }

  focus(p: Principal, where: Where = {}): Focus {
    return computeFocus(this.board(p), this.today(where), where.timeZone);
  }

  /** Completed tasks, newest first. */
  doneLog(p: Principal, query: unknown = {}): DoneLogPage {
    const q = parse(DoneLogQuery, query);
    const limit = q.limit ?? 200;
    const project: SQL | undefined =
      q.projectId === undefined
        ? undefined
        : q.projectId === INBOX
          ? isNull(tasks.projectId)
          : eq(tasks.projectId, q.projectId);
    // Keyset paging on (completed_at, id): a whole parent + subtasks can share one timestamp.
    let after: SQL | undefined;
    if (q.cursor) {
      const [ms, id] = q.cursor.split(':') as [string, string];
      const at = new Date(Number(ms));
      after = or(lt(tasks.completedAt, at), and(eq(tasks.completedAt, at), lt(tasks.id, id)));
    }
    const rows = this.ctx.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.status, 'done'),
          isNull(tasks.deletedAt),
          q.includeSubtasks ? undefined : isNull(tasks.parentTaskId),
          q.from ? gte(tasks.completedAt, new Date(q.from)) : undefined,
          q.to ? lt(tasks.completedAt, new Date(q.to)) : undefined,
          project,
          after,
          this.scopeFilter(p),
        ),
      )
      .orderBy(desc(tasks.completedAt), desc(tasks.id))
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      tasks: page.map(toTask),
      nextCursor: rows.length > limit && last ? `${last.completedAt!.getTime()}:${last.id}` : null,
    };
  }

  // ---------- Writes ----------

  create(p: Principal, input: unknown, where: Where = {}): Task {
    const i = parse(CreateTaskInput, input);
    return mutate(this.ctx, p, (tx, emit) => {
      let projectId = i.projectId ?? null;
      let priority = i.priority ?? 'soon';
      let parent: TaskRow | null = null;

      if (i.parentTaskId) {
        parent = this.getRow(tx, i.parentTaskId);
        if (this.depthOf(tx, parent) + 1 > this.ctx.rules.maxSubtaskDepth) {
          throw invalid(`Subtasks can be nested at most ${this.ctx.rules.maxSubtaskDepth} level(s) deep`);
        }
        // Subtasks always live in their parent's project.
        projectId = parent.projectId;
        priority = i.priority ?? parent.priority;
      } else if (projectId) {
        getLiveProject(tx, projectId);
      }
      assertWrite(p, projectId);

      // A day without a slot plans it as Secondary.
      const today = i.today ?? (i.planDate ? 'side' : null);
      if (today && parent) throw invalid('Only top-level tasks go on Today.');
      if (i.todayOnly && !today) throw invalid('A Today-only task needs a place on Today: main or side.');
      const planDate = today ? (i.planDate ?? this.today(where)) : null;
      if (today === 'main') this.assertRoomInMain(tx, planDate!, where);

      const depth = parent ? this.depthOf(tx, parent) + 1 : 0;
      if (i.subtasks?.length && depth + 1 > this.ctx.rules.maxSubtaskDepth) {
        throw invalid(`Subtasks can be nested at most ${this.ctx.rules.maxSubtaskDepth} level(s) deep`);
      }

      const source = sourceFor(p, i.source);
      const insert = (values: {
        title: string;
        notes?: string | null;
        estimateMinutes?: number | null;
        parentTaskId: string | null;
        handOff?: boolean;
        today?: TodaySlot | null;
        planDate?: string | null;
        todayOnly?: boolean;
      }) => {
        const now = this.ctx.now();
        const row = tx
          .insert(tasks)
          .values({
            id: ulid(),
            title: values.title,
            notes: values.notes ?? null,
            projectId,
            priority,
            estimateMinutes: values.estimateMinutes ?? null,
            status: 'todo',
            parentTaskId: values.parentTaskId,
            position: keyAfter(this.lastSiblingPosition(tx, values.parentTaskId)),
            source,
            agentState: values.handOff ? (i.agentState ?? null) : null,
            today: values.today ?? null,
            todayAt: values.today ? now : null,
            planDate: values.today ? (values.planDate ?? null) : null,
            todayOnly: values.todayOnly ?? false,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        emitTask(emit, 'created', row);
        return row;
      };

      const row = insert({ ...i, parentTaskId: parent?.id ?? null, handOff: true, today, planDate, todayOnly: i.todayOnly });
      for (const sub of i.subtasks ?? []) insert({ title: sub.title, estimateMinutes: sub.estimateMinutes, parentTaskId: row.id });

      // A done parent can't have open subtasks.
      if (parent?.status === 'done') this.transition(tx, emit, parent, 'todo');
      return toTask(row);
    });
  }

  update(p: Principal, id: string, input: unknown, where: Where = {}): Task {
    const patch = parse(UpdateTaskInput, input);
    return mutate(this.ctx, p, (tx, emit) => {
      let row = this.getRow(tx, id);
      assertWrite(p, row.projectId);

      const fields: Patch = {};
      if (patch.title !== undefined && patch.title !== row.title) {
        fields.title = patch.title;
        // Picked again for the new title (see the key words module).
        fields.keyWords = null;
      }
      if (patch.notes !== undefined && patch.notes !== row.notes) {
        // Agents may add to notes but never rewrite or clear what's there.
        if (p.kind === 'token' && row.notes && !patch.notes?.startsWith(row.notes)) {
          throw forbidden('Agents can add to notes but not rewrite them. Use add_note (POST /tasks/:id/notes).');
        }
        fields.notes = patch.notes;
      }
      if (patch.priority !== undefined) fields.priority = patch.priority;
      if (patch.estimateMinutes !== undefined) fields.estimateMinutes = patch.estimateMinutes;
      if (patch.projectId !== undefined && patch.projectId !== row.projectId) {
        this.checkProjectChange(tx, p, row, patch.projectId);
        fields.projectId = patch.projectId;
      }
      if (patch.today !== undefined || patch.planDate !== undefined) {
        // A day without a slot keeps the slot it has, or plans it as Secondary.
        const slot = patch.today !== undefined ? patch.today : (row.today ?? 'side');
        const wasDay = planDayOf(row, where.timeZone);
        // Moving between main and side keeps the day it was planned for (even a past one).
        const day = slot === null ? null : (patch.planDate ?? wasDay ?? this.today(where));
        const moved = day !== wasDay;
        if (slot !== row.today || moved) {
          if (row.parentTaskId) throw invalid('Only top-level tasks go on Today.');
          if (slot && row.status === 'done') throw invalid('This task is already done.');
          if (slot === 'main' && (row.today !== 'main' || moved)) this.assertRoomInMain(tx, day!, where, row.id);
          fields.today = slot;
          fields.planDate = day;
          fields.todayAt = slot === null ? null : row.today && !moved ? row.todayAt : this.ctx.now();
          // Taken off Today, a Today-only task joins its board instead of vanishing.
          if (slot === null && row.todayOnly) fields.todayOnly = false;
        }
      }

      if (Object.keys(fields).length > 0) {
        row = this.write(tx, row.id, fields);
        emitTask(emit, 'updated', row);
        if (fields.projectId !== undefined) this.cascadeProject(tx, emit, row);
      }
      if (patch.agentState !== undefined && patch.agentState !== row.agentState) {
        row = this.handOff(tx, emit, p, row, patch.agentState);
      }
      if (patch.status !== undefined) row = this.transition(tx, emit, row, this.checkStatusChange(p, row, patch.status));
      return toTask(row);
    });
  }

  // ---------- Key words (written by the server, not by people) ----------

  /** Open top-level tasks whose key words haven't been picked yet, oldest first. */
  needingKeyWords(limit: number): Pick<Task, 'id' | 'title' | 'projectId'>[] {
    return this.ctx.db
      .select({ id: tasks.id, title: tasks.title, projectId: tasks.projectId })
      .from(tasks)
      .where(
        and(isNull(tasks.keyWords), isNull(tasks.parentTaskId), isNull(tasks.deletedAt), ne(tasks.status, 'done')),
      )
      .orderBy(asc(tasks.createdAt))
      .limit(limit)
      .all();
  }

  /** Titles of open top-level tasks, for telling a title's rare words from its common ones. */
  openTitles(): { projectId: string | null; title: string }[] {
    return this.ctx.db
      .select({ projectId: tasks.projectId, title: tasks.title })
      .from(tasks)
      .where(and(isNull(tasks.parentTaskId), isNull(tasks.deletedAt), ne(tasks.status, 'done')))
      .all();
  }

  /**
   * Store the key words picked for `title`. Skipped if the title changed meanwhile (it gets its
   * own pick). Recorded as `keyed`, which the activity log leaves out.
   */
  setKeyWords(id: string, title: string, words: string[]): void {
    mutate(this.ctx, KEY_WORDS, (tx, emit) => {
      const row = tx.select().from(tasks).where(eq(tasks.id, id)).get();
      if (!row || row.title !== title || row.deletedAt) return;
      const updated = tx.update(tasks).set({ keyWords: words }).where(eq(tasks.id, id)).returning().get()!;
      emitTask(emit, 'keyed', updated);
    });
  }

  /** Add a paragraph to the notes, signed and dated. The only way agents write notes. */
  appendNote(p: Principal, id: string, input: unknown): Task {
    const { text } = parse(AppendNoteInput, input);
    return mutate(this.ctx, p, (tx, emit) => {
      const row = this.getRow(tx, id);
      assertWrite(p, row.projectId);
      const updated = this.write(tx, row.id, { notes: this.withNote(p, row.notes, text) });
      emitTask(emit, 'noted', updated);
      return toTask(updated);
    });
  }

  /**
   * Hand a task to agents and back:
   * - `ready`: any agent may claim it (set by the owner, a sorting agent, or an agent handing it back)
   * - `working`: claimed; only tasks marked ready, and never one another agent holds
   * - `review`: the claiming agent says it's finished; the owner checks and completes it
   * - null: no longer for agents
   */
  setAgentState(p: Principal, id: string, input: unknown): Task {
    const i = parse(SetAgentStateInput, input);
    return mutate(this.ctx, p, (tx, emit) => {
      let row = this.getRow(tx, id);
      assertWrite(p, row.projectId);
      // Check the hand-off first: a refused claim shouldn't leave its note behind.
      const next = this.handOff(tx, emit, p, row, i.state, true);
      if (i.note) {
        row = this.write(tx, row.id, { notes: this.withNote(p, row.notes, i.note) });
        emitTask(emit, 'noted', row);
      }
      return toTask(next ? this.handOff(tx, emit, p, row, i.state) : row);
    });
  }

  /** Drag & drop: change project and/or priority and/or position in one step. */
  move(p: Principal, id: string, input: unknown): Task {
    const m = parse(MoveTaskInput, input);
    return mutate(this.ctx, p, (tx, emit) => {
      let row = this.getRow(tx, id);
      assertWrite(p, row.projectId);

      const fields: Patch = {};
      if (m.projectId !== undefined && m.projectId !== row.projectId) {
        this.checkProjectChange(tx, p, row, m.projectId);
        fields.projectId = m.projectId;
      }
      if (m.priority !== undefined && m.priority !== row.priority) fields.priority = m.priority;
      if (m.afterId || m.beforeId) fields.position = this.positionFor(tx, p, row, m.afterId ?? null, m.beforeId ?? null);
      if (Object.keys(fields).length === 0) return toTask(row);

      row = this.write(tx, row.id, fields);
      emitTask(emit, 'moved', row);
      if (fields.projectId !== undefined) this.cascadeProject(tx, emit, row);
      return toTask(row);
    });
  }

  /**
   * Put top-level tasks in the given order, optionally setting priorities, in one step.
   * The tasks swap among the positions they already hold, so everything else stays put.
   */
  arrange(p: Principal, input: unknown): Task[] {
    const { items } = parse(ArrangeTasksInput, input);
    return mutate(this.ctx, p, (tx, emit) => {
      const seen = new Set<string>();
      const rows = items.map((item) => {
        if (seen.has(item.id)) throw invalid('Each task can appear only once');
        seen.add(item.id);
        const row = this.getRow(tx, item.id);
        assertWrite(p, row.projectId);
        if (row.parentTaskId) throw invalid('Only top-level tasks can be arranged');
        return row;
      });
      const slots = rows.map((r) => r.position).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      // Equal keys can't express an order; give the whole group fresh ones in the same place.
      const unique = new Set(slots).size === slots.length;
      const keys = unique ? slots : this.freshKeys(tx, slots[0]!, rows.length, new Set(rows.map((r) => r.id)));

      return rows.map((row, i) => {
        const fields: Patch = {};
        if (row.position !== keys[i]) fields.position = keys[i]!;
        const priority = items[i]!.priority;
        if (priority && priority !== row.priority) fields.priority = priority;
        if (Object.keys(fields).length === 0) return toTask(row);
        const updated = this.write(tx, row.id, fields);
        emitTask(emit, 'moved', updated);
        return toTask(updated);
      });
    });
  }

  /** `n` ascending keys starting at `from`, below the next top-level task that isn't being moved. */
  private freshKeys(tx: Tx, from: string, n: number, moving: Set<string>): string[] {
    const next = tx
      .select({ id: tasks.id, v: tasks.position })
      .from(tasks)
      .where(and(isNull(tasks.parentTaskId), gt(tasks.position, from)))
      .orderBy(asc(tasks.position))
      .all()
      .find((r) => !moving.has(r.id))?.v ?? null;
    const before = tx
      .select({ v: max(tasks.position) })
      .from(tasks)
      .where(and(isNull(tasks.parentTaskId), lt(tasks.position, from)))
      .get()?.v ?? null;
    return generateNKeysBetween(before, next, n);
  }

  setStatus(p: Principal, id: string, status: TaskStatus): Task {
    return mutate(this.ctx, p, (tx, emit) => {
      const row = this.getRow(tx, id);
      assertWrite(p, row.projectId);
      return toTask(this.transition(tx, emit, row, this.checkStatusChange(p, row, status)));
    });
  }

  start = (p: Principal, id: string) => this.setStatus(p, id, 'in_progress');
  stop = (p: Principal, id: string) => this.setStatus(p, id, 'todo');
  complete = (p: Principal, id: string) => this.setStatus(p, id, 'done');
  reopen = (p: Principal, id: string) => this.setStatus(p, id, 'todo');

  /** Soft delete, including subtasks. */
  remove(p: Principal, id: string): Task {
    return mutate(this.ctx, p, (tx, emit) => {
      const row = this.getRow(tx, id);
      assertWrite(p, row.projectId);
      const now = this.ctx.now();
      for (const child of this.children(tx, row.id)) {
        emitTask(emit, 'deleted', this.write(tx, child.id, { deletedAt: now }));
      }
      const deleted = this.write(tx, row.id, { deletedAt: now });
      emitTask(emit, 'deleted', deleted);
      return toTask(deleted);
    });
  }

  /** Undo a delete: bring the task back with the subtasks deleted along with it. */
  restore(p: Principal, id: string): Task {
    return mutate(this.ctx, p, (tx, emit) => {
      const row = tx.select().from(tasks).where(eq(tasks.id, id)).get();
      if (!row) throw notFound('Task');
      assertWrite(p, row.projectId);
      if (!row.deletedAt) return toTask(row);
      if (row.parentTaskId) this.getRow(tx, row.parentTaskId);
      const deletedWith = tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.parentTaskId, row.id), eq(tasks.deletedAt, row.deletedAt)))
        .all();
      const restored = this.write(tx, row.id, { deletedAt: null });
      emitTask(emit, 'restored', restored);
      for (const child of deletedWith) emitTask(emit, 'restored', this.write(tx, child.id, { deletedAt: null }));
      return toTask(restored);
    });
  }

  // ---------- Status rules ----------

  /**
   * Apply a status change and its knock-on effects:
   * - starting respects the in-progress limit (oldest in-progress task is moved back to todo)
   * - completing a parent completes its open subtasks
   * - reopening/starting a subtask (or adding one) reopens a done parent
   */
  private transition(tx: Tx, emit: Emit, row: TaskRow, to: TaskStatus): TaskRow {
    if (row.status === to) return row;
    const now = this.ctx.now();
    let updated: TaskRow;

    if (to === 'in_progress') {
      this.makeRoomToStart(tx, emit, row.id);
      updated = this.write(tx, row.id, { status: to, startedAt: now, completedAt: null });
      emitTask(emit, 'started', updated);
    } else if (to === 'done') {
      // Finished: no longer waiting on or for an agent.
      updated = this.write(tx, row.id, { status: to, completedAt: now, agentState: null, agentClaimedBy: null });
      emitTask(emit, 'completed', updated);
      for (const child of this.children(tx, row.id)) {
        if (child.status !== 'done') this.transition(tx, emit, child, 'done');
      }
    } else {
      updated = this.write(tx, row.id, { status: to, startedAt: null, completedAt: null });
      emitTask(emit, row.status === 'done' ? 'reopened' : 'stopped', updated);
    }

    if (to !== 'done' && row.parentTaskId) {
      const parent = this.getRow(tx, row.parentTaskId);
      if (parent.status === 'done') this.transition(tx, emit, parent, 'todo');
    }
    return updated;
  }

  /** The user's today, `YYYY-MM-DD`. */
  private today(where: Where): string {
    return dayKey(this.ctx.now(), where.timeZone);
  }

  /**
   * Main is for the few things that make a day; done ones don't count. Tasks carried over from
   * earlier days count towards today's.
   */
  private assertRoomInMain(tx: Tx, day: string, where: Where, except?: string): void {
    const today = this.today(where);
    const shown = day < today ? today : day;
    const open = tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.today, 'main'), ne(tasks.status, 'done'), isNull(tasks.deletedAt)))
      .all()
      .filter((r) => r.id !== except && shownDayOf(r, today, where.timeZone) === shown).length;
    if (open >= MAX_TODAY_MAIN) {
      const name = shown === today ? 'Today' : formatDay(shown, { weekday: 'long', day: 'numeric', month: 'short' }, 'en-GB');
      throw new HelmError('conflict', `${name} already has ${MAX_TODAY_MAIN} main tasks. Move one to secondary first.`);
    }
  }

  private makeRoomToStart(tx: Tx, emit: Emit, startingId: string): void {
    const limit = this.ctx.rules.inProgressLimit;
    if (limit <= 0) return;
    const active = tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.status, 'in_progress'), isNull(tasks.deletedAt), ne(tasks.id, startingId)))
      .orderBy(asc(tasks.startedAt))
      .all();
    while (active.length >= limit) {
      const oldest = active.shift()!;
      this.transition(tx, emit, oldest, 'todo');
    }
  }

  // ---------- Agent hand-off ----------

  /** Agents hand finished work over for review; completing it is the owner's call. */
  private checkStatusChange(p: Principal, row: TaskRow, to: TaskStatus): TaskStatus {
    if (p.kind === 'token' && to === 'done' && (row.agentState === 'working' || row.agentState === 'review')) {
      throw forbidden('This task was handed to an agent: submit it for review instead. The owner completes it.');
    }
    return to;
  }

  /** Apply a hand-off step, or with `dryRun` only check it's allowed (true = something would change). */
  private handOff(tx: Tx, emit: Emit, p: Principal, row: TaskRow, to: AgentState | null, dryRun: true): boolean;
  private handOff(tx: Tx, emit: Emit, p: Principal, row: TaskRow, to: AgentState | null): TaskRow;
  private handOff(tx: Tx, emit: Emit, p: Principal, row: TaskRow, to: AgentState | null, dryRun = false): TaskRow | boolean {
    const me = actorOf(p);
    const owner = p.kind === 'owner';
    const holder = row.agentClaimedBy;
    const heldByOther = row.agentState === 'working' && holder !== null && holder !== me;
    const who = holder?.replace(/^token:/, '') ?? 'Another agent';

    if (to !== null && row.status === 'done') throw invalid('This task is already done.');
    if (to === 'working') {
      if (heldByOther && !owner) throw new HelmError('conflict', `${who} is already working on this task.`);
      if (!owner && row.agentState !== 'ready' && !(row.agentState === 'working' && holder === me)) {
        throw forbidden('Only tasks marked for an agent (state "ready") can be claimed.');
      }
    } else if (to === 'review') {
      if (!owner && !(row.agentState === 'working' && holder === me)) {
        throw forbidden('Claim the task before submitting it for review.');
      }
    } else if (!owner && heldByOther) {
      throw new HelmError('conflict', `${who} is working on this task; only it or the owner can change that.`);
    }

    const fields: Patch =
      to === 'working'
        ? { agentState: to, agentClaimedBy: me }
        : to === 'review'
          ? { agentState: to, agentClaimedBy: holder ?? me }
          : { agentState: to, agentClaimedBy: null };
    const changes = fields.agentState !== row.agentState || fields.agentClaimedBy !== row.agentClaimedBy;
    if (dryRun) return changes;
    if (!changes) return row;
    const updated = this.write(tx, row.id, fields);
    emitTask(emit, 'agent', updated);
    return updated;
  }

  private withNote(p: Principal, notes: string | null, text: string): string {
    const who = p.kind === 'owner' ? (p.via ?? 'you') : p.name;
    const day = this.ctx.now().toISOString().slice(0, 10);
    const entry = `— ${who}, ${day}: ${text.trim()}`;
    const next = notes?.trim() ? `${notes.trimEnd()}\n\n${entry}` : entry;
    if (next.length > NOTES_MAX) throw invalid('The notes are full. Ask the owner to tidy them up first.');
    return next;
  }

  // ---------- Helpers ----------

  private getRow(tx: Tx, id: string): TaskRow {
    const row = tx.select().from(tasks).where(and(eq(tasks.id, id), isNull(tasks.deletedAt))).get();
    if (!row) throw notFound('Task');
    return row;
  }

  private write(tx: Tx, id: string, fields: Patch): TaskRow {
    return tx
      .update(tasks)
      .set({ ...fields, updatedAt: this.ctx.now() })
      .where(eq(tasks.id, id))
      .returning()
      .get()!;
  }

  private children(tx: Tx, parentId: string): TaskRow[] {
    return tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.parentTaskId, parentId), isNull(tasks.deletedAt)))
      .all();
  }

  private depthOf(tx: Tx, row: TaskRow): number {
    let depth = 0;
    let cur = row;
    while (cur.parentTaskId && depth < 32) {
      depth++;
      cur = this.getRow(tx, cur.parentTaskId);
    }
    return depth;
  }

  private checkProjectChange(tx: Tx, p: Principal, row: TaskRow, projectId: string | null): void {
    if (row.parentTaskId) throw invalid("Subtasks follow their parent's project; move the parent instead");
    if (projectId) getLiveProject(tx, projectId);
    assertWrite(p, projectId);
  }

  private cascadeProject(tx: Tx, emit: Emit, parent: TaskRow): void {
    for (const child of this.children(tx, parent.id)) {
      emitTask(emit, 'moved', this.write(tx, child.id, { projectId: parent.projectId }));
    }
  }

  private siblingsOf(parentId: string | null): SQL {
    return parentId ? eq(tasks.parentTaskId, parentId) : isNull(tasks.parentTaskId);
  }

  private lastSiblingPosition(tx: Tx, parentId: string | null): string | null {
    return tx.select({ v: max(tasks.position) }).from(tasks).where(this.siblingsOf(parentId)).get()?.v ?? null;
  }

  private positionFor(tx: Tx, p: Principal, row: TaskRow, afterId: string | null, beforeId: string | null): string {
    const neighbour = (nid: string) => {
      const n = this.getRow(tx, nid);
      assertRead(p, n.projectId);
      if (n.id === row.id || n.parentTaskId !== row.parentTaskId) {
        throw invalid('afterId/beforeId must be a sibling of the moved task');
      }
      return n.position;
    };
    const others = and(this.siblingsOf(row.parentTaskId), isNull(tasks.deletedAt), ne(tasks.id, row.id));
    const adjacent = (dir: 'next' | 'prev') => (pos: string) =>
      tx
        .select({ v: tasks.position })
        .from(tasks)
        .where(and(others, dir === 'next' ? gt(tasks.position, pos) : lt(tasks.position, pos)))
        .orderBy(dir === 'next' ? asc(tasks.position) : desc(tasks.position))
        .limit(1)
        .get()?.v ?? null;

    return keyBetweenNeighbours(
      afterId ? neighbour(afterId) : null,
      beforeId ? neighbour(beforeId) : null,
      adjacent('next'),
      adjacent('prev'),
    );
  }

  private scopeFilter(p: Principal): SQL | undefined {
    const scope = projectScope(p);
    return scope ? inArray(tasks.projectId, scope) : undefined;
  }
}

function emitTask(emit: Emit, action: string, row: TaskRow): void {
  emit({ entity: 'task', entityId: row.id, projectId: row.projectId, action, data: toTask(row) });
}

/** Owner picks freely (default manual, or the agent it acts via). Tokens are always `ai:<something>`. */
function sourceFor(p: Principal, requested: string | undefined): string {
  if (p.kind === 'owner') return requested ?? (p.via ? `ai:${p.via}` : 'manual');
  if (requested?.startsWith('ai:')) return requested;
  const slug = p.name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64);
  return `ai:${slug || 'agent'}`;
}
