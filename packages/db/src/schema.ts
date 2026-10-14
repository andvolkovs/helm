import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

// Timestamps are stored as integer milliseconds since epoch.
const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  /** An emoji shown beside the name; null = pick one from the name. */
  icon: text('icon'),
  collapsed: integer('collapsed', { mode: 'boolean' }).notNull().default(false),
  position: text('position').notNull(),
  archivedAt: ts('archived_at'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    notes: text('notes'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    priority: text('priority', { enum: ['now', 'soon', 'someday'] }).notNull(),
    estimateMinutes: integer('estimate_minutes'),
    status: text('status', { enum: ['todo', 'in_progress', 'done'] }).notNull(),
    parentTaskId: text('parent_task_id').references((): AnySQLiteColumn => tasks.id, { onDelete: 'cascade' }),
    position: text('position').notNull(),
    source: text('source').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    deletedAt: ts('deleted_at'),
    /** Handed to an AI agent: ready | working | review; null = not. */
    agentState: text('agent_state', { enum: ['ready', 'working', 'review'] }),
    /** Actor that claimed it (e.g. `token:Claude Code`). */
    agentClaimedBy: text('agent_claimed_by'),
    /** On the Today list: main | side; null = not. Stays set once done, for "Done today". */
    today: text('today', { enum: ['main', 'side'] }),
    /** When it went on Today; older than the start of today = carried over. */
    todayAt: ts('today_at'),
    /** The day it's planned for (`YYYY-MM-DD`, the user's own calendar). Later than today = planned
     *  ahead; earlier = carried over. null on tasks from before planning ahead existed. */
    planDate: text('plan_date'),
    /** Added straight to Today: kept off the board. */
    todayOnly: integer('today_only', { mode: 'boolean' }).notNull().default(false),
    /** Words of the title to show in bold (JSON array); null = not picked yet. */
    keyWords: text('key_words', { mode: 'json' }).$type<string[]>(),
  },
  (t) => [
    index('tasks_parent_idx').on(t.parentTaskId),
    index('tasks_project_idx').on(t.projectId),
    index('tasks_status_idx').on(t.status),
    index('tasks_completed_idx').on(t.completedAt),
    check('tasks_priority_chk', sql`${t.priority} in ('now', 'soon', 'someday')`),
    check('tasks_status_chk', sql`${t.status} in ('todo', 'in_progress', 'done')`),
  ],
);

export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** First chars of the token, shown in UI to identify it. */
  prefix: text('prefix').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  scope: text('scope', { enum: ['read', 'read_write'] }).notNull(),
  /** JSON array of project ids, or null for all projects (incl. Inbox). */
  projectIds: text('project_ids', { mode: 'json' }).$type<string[] | null>(),
  createdAt: ts('created_at').notNull(),
  lastUsedAt: ts('last_used_at'),
  expiresAt: ts('expires_at'),
  revokedAt: ts('revoked_at'),
});

/** Append-only change log. Drives realtime sync (id = SSE cursor) and the audit trail. */
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: ts('at').notNull(),
    actor: text('actor').notNull(),
    entity: text('entity', { enum: ['task', 'project', 'token', 'timer'] }).notNull(),
    entityId: text('entity_id').notNull(),
    /** Project the entity belongs to (for scope-filtering the stream); null = Inbox / not applicable. */
    projectId: text('project_id'),
    action: text('action').notNull(),
    data: text('data', { mode: 'json' }).notNull(),
    /** Events written by one request share it, so they can be shown and undone together. Null on old rows. */
    batchId: text('batch_id'),
    /** The batch this one undid. */
    undoOf: text('undo_of'),
  },
  (t) => [
    index('events_entity_idx').on(t.entity, t.entityId),
    index('events_batch_idx').on(t.batchId),
    index('events_undo_idx').on(t.undoOf),
  ],
);

/**
 * Countdown timers. At most one is live (running, paused, or finished and not yet dismissed);
 * starting a new one ends the old one.
 */
export const timers = sqliteTable('timers', {
  id: text('id').primaryKey(),
  label: text('label'),
  /** The task it was started for, if any. Not a foreign key: a timer outlives its task. */
  taskId: text('task_id'),
  durationMs: integer('duration_ms').notNull(),
  /** When it rings; null while paused. */
  endsAt: ts('ends_at'),
  /** Time left while paused; null while running. */
  remainingMs: integer('remaining_ms'),
  finishedAt: ts('finished_at'),
  /** Stopped or dismissed: no longer shown. */
  endedAt: ts('ended_at'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

/** Web Push subscriptions: one per browser or installed app that turned on timer alerts. */
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: ts('created_at').notNull(),
});

/** Small server settings that must survive restarts (e.g. the Web Push key pair). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export type ProjectRow = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type TimerRow = typeof timers.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
