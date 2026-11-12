import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, max, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
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
import type { SettingsService } from './settings.service.ts';

/** Events from before batches existed stand alone, keyed by their own id. */
const batchKey = sql<string>`coalesce(${events.batchId}, 'e' || ${events.id})`;
const keyOf = (e: EventRow) => e.batchId ?? `e${e.id}`;
const inBatch = (key: string): SQL =>
  /^e\d+$/.test(key) ? and(eq(events.id, Number(key.slice(1))), sql`${events.batchId} is null`)! : eq(events.batchId, key);

/** The same for many batches at once, through the indexes on `batch_id` and `id`. */
function inBatches(keys: string[]): SQL {
  const lone = keys.filter((k) => /^e\d+$/.test(k)).map((k) => Number(k.slice(1)));
  const shared = keys.filter((k) => !/^e\d+$/.test(k));
  return (
    or(
      shared.length ? inArray(events.batchId, shared) : undefined,
      lone.length ? and(inArray(events.id, lone), sql`${events.batchId} is null`) : undefined,
    ) ?? sql`0`
  );
}

const DAY_MS = 86_400_000;
/**
 * Rows asked for beyond the batches still missing, per step while looking for a page. Kept
 * small: with a filter few events pass (agents only), every extra row means reading far back.
 */
const SCAN_SPARE = 10;
/** How long events nobody sees in the log are kept, for apps catching up after being away. */
const SYNC_ONLY_KEEP_DAYS = 7;

/**
 * Key words picked in the background (`keyed`) aren't changes anyone made: left out, never undone.
 * The `+` keeps SQLite from reaching for the entity index on this test. Nearly every event is a
 * task or project event, so that index narrows nothing: it would read them all and sort, where
 * the batch index, or simply the newest rows in id order, gets there at once.
 */
const TRACKED = and(sql`+${events.entity} in ('task', 'project')`, ne(events.action, 'keyed'));
const date = (iso: string | null) => (iso ? new Date(iso) : null);

/**
 * The activity log: who changed what, grouped by request, with the state before each change so
 * it can be shown and undone. Built from the append-only events table. Owner only.
 */
export class ActivityService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly settings: SettingsService,
  ) {}

  list(p: Principal, query: unknown = {}): ActivityPage {
    assertOwner(p);
    const q = parse(ActivityQuery, query);
    const limit = q.limit ?? 30;
    const db = this.ctx.db;

    const who = q.who === 'agents' ? ne(events.actor, 'owner') : undefined;
    const batches = q.taskId
      ? this.batchesTouching(q.taskId, who, q.cursor, limit)
      : this.latestBatches(who, q.cursor, limit);
    const page = batches.slice(0, limit);
    const keys = page.map((b) => b.key);
    if (keys.length === 0) return { entries: [], nextCursor: null };

    const rows = db
      .select()
      .from(events)
      .where(and(TRACKED, inBatches(keys)))
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
    // The oldest event of the last batch shown: the next page starts strictly before it.
    const oldest = rows.find((e) => keyOf(e) === page.at(-1)!.key)!.id;
    return { entries, nextCursor: batches.length > limit ? oldest : null };
  }

  /** Put everything a batch changed back the way it was, as one new (itself undoable) batch. */
  undo(p: Principal, key: string): { ok: true } {
    assertOwner(p);
    const evs = this.ctx.db.select().from(events).where(and(TRACKED, inBatch(key))).orderBy(asc(events.id)).all();
    const since = this.visibleFrom();
    if (evs.length === 0 || (since && evs[0]!.at < since)) throw notFound('Change');
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
        const restored = new Set([...firsts.values()].filter((e) => e.entity === 'task').map((e) => e.entityId));
        this.keepInProgressLimit(tx, emit, restored);
      },
      { undoOf: key },
    );
    return { ok: true };
  }

  // ---------- Paging ----------

  /** Only history newer than this is shown or undone (see `prune`); undefined = all of it. */
  private visibleFrom(): Date | undefined {
    const days = this.ctx.historyKeepDays ?? 0;
    return days > 0 ? new Date(this.ctx.now().getTime() - days * DAY_MS) : undefined;
  }

  /**
   * The newest batches, found by walking the log backwards from the cursor and stopping as soon
   * as a page is full. One request writes its events in one transaction, so a batch's events sit
   * next to each other and the first one met is its newest. Cost follows the page, not the log.
   */
  private latestBatches(who: SQL | undefined, cursor: number | undefined, limit: number): { key: string }[] {
    const since = this.visibleFrom();
    const found: { key: string }[] = [];
    const seen = new Set<string>();
    let before = cursor;
    for (;;) {
      const want = limit + 1 - found.length + SCAN_SPARE;
      const chunk = this.ctx.db
        .select({ id: events.id, key: batchKey })
        .from(events)
        .where(and(TRACKED, who, since ? gte(events.at, since) : undefined, before ? lt(events.id, before) : undefined))
        .orderBy(desc(events.id))
        .limit(want)
        .all();
      for (const r of chunk) {
        if (seen.has(r.key)) continue;
        seen.add(r.key);
        found.push({ key: r.key });
        if (found.length > limit) return found;
      }
      if (chunk.length < want) return found;
      before = chunk.at(-1)!.id;
    }
  }

  /** The newest batches that changed one task: few, and found through the entity index. */
  private batchesTouching(taskId: string, who: SQL | undefined, cursor: number | undefined, limit: number): { key: string }[] {
    const db = this.ctx.db;
    const since = this.visibleFrom();
    const keys = db
      .selectDistinct({ key: batchKey })
      .from(events)
      .where(and(eq(events.entity, 'task'), eq(events.entityId, taskId)))
      .all()
      .map((r) => r.key);
    if (keys.length === 0) return [];
    return db
      .select({ key: batchKey })
      .from(events)
      .where(and(TRACKED, who, inBatches(keys), since ? gte(events.at, since) : undefined))
      .groupBy(batchKey)
      .having(cursor ? lt(max(events.id), cursor) : undefined)
      .orderBy(desc(max(events.id)))
      .limit(limit + 1)
      .all();
  }

  // ---------- Housekeeping ----------

  /**
   * Thin out the event log, which otherwise grows with every change for ever:
   * - events that only exist to keep open apps in step (key-word picks, timer and token changes)
   *   go after a week: nobody sees them in the activity log;
   * - with `historyKeepDays` set, task and project history older than that goes too, except each
   *   task's or project's newest older event, kept so later changes still know what came before.
   * An app that was away for longer than what is left simply takes a fresh snapshot.
   */
  prune(): { removed: number } {
    const now = this.ctx.now().getTime();
    const keepDays = this.ctx.historyKeepDays ?? 0;
    return this.ctx.db.transaction((tx) => {
      const syncOnly = and(
        lt(events.at, new Date(now - SYNC_ONLY_KEEP_DAYS * DAY_MS)),
        or(inArray(events.entity, ['token', 'timer']), eq(events.action, 'keyed')),
      );
      let old: SQL | undefined;
      if (keepDays > 0) {
        const cut = new Date(now - keepDays * DAY_MS);
        const baselines = tx
          .select({ id: max(events.id) })
          .from(events)
          .where(and(TRACKED, lt(events.at, cut)))
          .groupBy(events.entity, events.entityId);
        old = and(lt(events.at, cut), notInArray(events.id, baselines));
      }
      const doomed = or(syncOnly, old);
      const top = tx.select({ id: max(events.id) }).from(events).where(doomed).get()?.id;
      if (top == null) return { removed: 0 };
      const removed = tx.delete(events).where(doomed).run().changes;
      this.settings.notePruned(top);
      return { removed };
    });
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

  /**
   * Undo can put a task back in progress while another one is. The limit still holds: the others
   * are paused, oldest first, just as when a task is started. Part of the same undo, so undoing
   * that brings them back.
   */
  private keepInProgressLimit(tx: Tx, emit: Emit, restored: Set<string>): void {
    const limit = this.ctx.rules.inProgressLimit;
    if (limit <= 0) return;
    const active = tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.status, 'in_progress'), isNull(tasks.deletedAt)))
      .orderBy(asc(tasks.startedAt))
      .all();
    if (active.length <= limit || !active.some((t) => restored.has(t.id))) return;
    const queue = [...active.filter((t) => !restored.has(t.id)), ...active.filter((t) => restored.has(t.id))];
    const now = this.ctx.now();
    while (queue.length > limit) {
      const t = queue.shift()!;
      const row = tx
        .update(tasks)
        .set({ status: 'todo', startedAt: null, updatedAt: now })
        .where(eq(tasks.id, t.id))
        .returning()
        .get()!;
      emit({ entity: 'task', entityId: row.id, projectId: row.projectId, action: 'stopped', data: toTask(row) });
    }
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
