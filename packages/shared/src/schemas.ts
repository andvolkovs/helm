import { z } from 'zod';
import { isDayKey } from './days.ts';

// ---------- Enums ----------

export const PRIORITIES = ['now', 'soon', 'someday'] as const;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;

export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * Handing a task to an AI agent: `ready` = an agent may pick it up, `working` = an agent claimed
 * it, `review` = the agent says it's finished and waits for the owner to check and complete it.
 */
export const AGENT_STATES = ['ready', 'working', 'review'] as const;
export const AgentState = z.enum(AGENT_STATES);
export type AgentState = z.infer<typeof AgentState>;

/** A task on the Today list: `main` (what makes the day, at most MAX_TODAY_MAIN open) or `side` (if there's time). */
export const TODAY_SLOTS = ['main', 'side'] as const;
export const TodaySlot = z.enum(TODAY_SLOTS);
export type TodaySlot = z.infer<typeof TodaySlot>;
export const MAX_TODAY_MAIN = 3;

/** A calendar day, `YYYY-MM-DD`, in the user's own time zone. */
export const PlanDate = z.string().refine(isDayKey, 'date must be a real day, YYYY-MM-DD');

/** `manual`, `voice`, or `ai:<agent>` (agent = short slug). */
export const TaskSource = z
  .string()
  .regex(/^(manual|voice|ai:[a-z0-9][a-z0-9._-]{0,63})$/, 'source must be manual, voice or ai:<agent>');
export type TaskSource = z.infer<typeof TaskSource>;

export const Id = z.string().min(1).max(64);
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb');

// ---------- Entities (API shape, camelCase, ISO timestamps) ----------

export const Task = z.object({
  id: Id,
  title: z.string(),
  notes: z.string().nullable(),
  projectId: Id.nullable(),
  priority: Priority,
  estimateMinutes: z.number().int().nullable(),
  status: TaskStatus,
  parentTaskId: Id.nullable(),
  position: z.string(),
  source: TaskSource,
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  /** null = not handed to an agent. */
  agentState: AgentState.nullable(),
  /** Who claimed it (`token:<name>`, `owner`, ...), while `working` or `review`. */
  agentClaimedBy: z.string().nullable(),
  /** On the Today list; null = not. Stays set once done, so it shows under "Done today". */
  today: TodaySlot.nullable(),
  /** When it went on the plan, or moved to another day. Orders a day's tasks. */
  todayAt: z.string().nullable(),
  /**
   * The day it's planned for (with `today` set). Later than today = planned ahead; earlier =
   * carried over to today. null on tasks planned before days existed: see `planDayOf`.
   */
  planDate: z.string().nullable().optional(),
  /** Added straight to Today: lives only there, never on the board. */
  todayOnly: z.boolean(),
  /** Words of the title shown in bold for skimming, picked by the server. null = not picked yet. */
  keyWords: z.array(z.string()).nullable().optional(),
});
export type Task = z.infer<typeof Task>;

export const Project = z.object({
  id: Id,
  name: z.string(),
  color: HexColor,
  /** An emoji chosen for the project; null means the app picks one from the name. */
  icon: z.string().nullable(),
  collapsed: z.boolean(),
  position: z.string(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof Project>;

// ---------- Inputs ----------

const Title = z.string().trim().min(1, 'title is required').max(500);
const Notes = z.string().max(20_000).nullable();
const Estimate = z.number().int().min(1).max(24 * 60).nullable();

export const CreateTaskInput = z.object({
  title: Title,
  notes: Notes.optional(),
  projectId: Id.nullable().optional(),
  priority: Priority.optional(),
  estimateMinutes: Estimate.optional(),
  parentTaskId: Id.nullable().optional(),
  source: TaskSource.optional(),
  /** Let an agent pick it up straight away. */
  agentState: z.literal('ready').nullable().optional(),
  /** Put it on Today (top-level tasks only). */
  today: TodaySlot.nullable().optional(),
  /** Plan it for this day instead of today (as Secondary unless `today` says). */
  planDate: PlanDate.optional(),
  /** Keep it off the board: it lives only on Today. Needs `today`. */
  todayOnly: z.boolean().optional(),
  /** Create subtasks in the same step (same transaction). */
  subtasks: z
    .array(z.object({ title: Title, estimateMinutes: Estimate.optional() }))
    .max(50)
    .optional(),
});
export type CreateTaskInput = z.input<typeof CreateTaskInput>;

export const UpdateTaskInput = z
  .object({
    title: Title,
    notes: Notes,
    projectId: Id.nullable(),
    priority: Priority,
    estimateMinutes: Estimate,
    status: TaskStatus,
    agentState: AgentState.nullable(),
    /** Put on Today, move between main and side, or (null) take off. Top-level tasks only. */
    today: TodaySlot.nullable(),
    /** Move it to another day of the plan (puts it on as Secondary if it wasn't). */
    planDate: PlanDate,
  })
  .partial()
  .strict();
export type UpdateTaskInput = z.input<typeof UpdateTaskInput>;

/**
 * Reposition a task (drag & drop). `afterId` = the task it should sit below,
 * `beforeId` = the task it should sit above. Either, both or neither may be given.
 */
export const MoveTaskInput = z
  .object({
    projectId: Id.nullable().optional(),
    priority: Priority.optional(),
    afterId: Id.nullable().optional(),
    beforeId: Id.nullable().optional(),
  })
  .strict();
export type MoveTaskInput = z.input<typeof MoveTaskInput>;

/** Add to a task's notes without touching what's there (how agents write notes). */
export const AppendNoteInput = z.object({ text: z.string().trim().min(1, 'text is required').max(5000) }).strict();
export type AppendNoteInput = z.input<typeof AppendNoteInput>;

/** Hand a task to agents, claim it, hand it back or send it for review. `note` is appended. */
export const SetAgentStateInput = z
  .object({
    state: AgentState.nullable(),
    note: z.string().trim().min(1).max(5000).optional(),
  })
  .strict();
export type SetAgentStateInput = z.input<typeof SetAgentStateInput>;

/** A short emoji (a few code points, e.g. flags or skin tones), not text. */
export const ProjectIcon = z.string().trim().min(1).max(16);

export const CreateProjectInput = z.object({
  name: z.string().trim().min(1).max(100),
  color: HexColor.optional(),
  icon: ProjectIcon.nullable().optional(),
});
export type CreateProjectInput = z.input<typeof CreateProjectInput>;

export const UpdateProjectInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    color: HexColor,
    icon: ProjectIcon.nullable(),
    collapsed: z.boolean(),
  })
  .partial()
  .strict();
export type UpdateProjectInput = z.input<typeof UpdateProjectInput>;

export const MoveProjectInput = z
  .object({
    afterId: Id.nullable().optional(),
    beforeId: Id.nullable().optional(),
  })
  .strict();
export type MoveProjectInput = z.input<typeof MoveProjectInput>;

/** Project filter value: a project id, or "inbox" for tasks without a project. */
export const INBOX = 'inbox' as const;

export const DoneLogQuery = z.object({
  projectId: Id.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  includeSubtasks: z.stringbool().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  /** Opaque `nextCursor` from the previous page. */
  cursor: z
    .string()
    .regex(/^\d+:[^:]+$/, 'cursor must come from a previous page')
    .optional(),
});
export type DoneLogQuery = z.input<typeof DoneLogQuery>;

/** Newest first. `nextCursor` is null on the last page. */
export interface DoneLogPage {
  tasks: Task[];
  nextCursor: string | null;
}

export const ProjectListQuery = z.object({
  includeArchived: z.stringbool().optional(),
});
export type ProjectListQuery = z.input<typeof ProjectListQuery>;

// ---------- API tokens ----------

export const TOKEN_SCOPES = ['read', 'read_write'] as const;
export const TokenScope = z.enum(TOKEN_SCOPES);
export type TokenScope = z.infer<typeof TokenScope>;

/** A token as the owner sees it. The secret itself is shown once, at creation, and never stored. */
export const ApiToken = z.object({
  id: Id,
  name: z.string(),
  /** Start of the secret, to tell tokens apart. */
  prefix: z.string(),
  scope: TokenScope,
  /** null = every project and the Inbox. */
  projectIds: z.array(Id).nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiToken = z.infer<typeof ApiToken>;

export const CreateTokenInput = z
  .object({
    /** Who uses it, e.g. "Claude Code". Becomes the task source `ai:<slug>`. */
    name: z.string().trim().min(1).max(64),
    scope: TokenScope,
    projectIds: z.array(Id).min(1).max(100).nullable().default(null),
    expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
  })
  .strict();
export type CreateTokenInput = z.input<typeof CreateTokenInput>;

export interface CreatedToken {
  token: ApiToken;
  /** Plain secret. Returned only by the create call. */
  secret: string;
}

// ---------- Voice ----------

/** What the server can do with voice; the app falls back to the browser's speech recognition. */
export interface VoiceStatus {
  /** Server can turn audio into text. */
  transcribe: boolean;
  /** Server can turn text into task fields with an AI model. */
  parse: boolean;
  /** Why a feature is off, in words for the user. */
  reasons: { transcribe?: string; parse?: string };
  /** Longest recording the server accepts. */
  maxSeconds: number;
}

export const VoiceTextInput = z
  .object({
    text: z.string().trim().min(1, 'text is required').max(5000),
  })
  .strict();
export type VoiceTextInput = z.input<typeof VoiceTextInput>;

/** A task suggested from speech. Nothing is saved until the user confirms it. */
export interface TaskSuggestion {
  title: string;
  notes: string | null;
  projectId: string | null;
  /** A project name that was heard but doesn't exist yet. */
  unmatchedProject: string | null;
  /** The heard name fits several projects; the user picks one (projectId stays null). */
  projectChoices: { id: string; name: string }[];
  /** null = not said. */
  priority: Priority | null;
  estimateMinutes: number | null;
  subtasks: string[];
  /** "…, today" or "…, today, main" said at the end; null = not said. */
  today: TodaySlot | null;
}

export interface VoiceParseResult {
  transcript: string;
  /** At least one. */
  tasks: TaskSuggestion[];
  /** false = no AI model (or it failed); the transcript became the title as is. */
  parsed: boolean;
  /** Why parsing was skipped when a model is set up but failed, for the user. */
  notice?: string;
}

// ---------- Assistant ----------

/** Put tasks in this order (and optionally set priorities). Only top-level tasks. */
export const ArrangeItems = z
  .array(z.object({ id: Id, priority: Priority.optional() }).strict())
  .min(1)
  .max(500);

export const ArrangeTasksInput = z.object({ items: ArrangeItems }).strict();
export type ArrangeTasksInput = z.input<typeof ArrangeTasksInput>;

/** One change the assistant proposed and the user accepted. Deleting is deliberately absent. */
export const AssistantChange = z.union([
  z
    .object({
      action: z.literal('create'),
      title: Title,
      notes: Notes.optional(),
      projectId: Id.nullable().optional(),
      priority: Priority.optional(),
      estimateMinutes: Estimate.optional(),
      parentTaskId: Id.nullable().optional(),
      subtasks: z.array(Title).max(50).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      taskId: Id,
      title: Title.optional(),
      notes: Notes.optional(),
      projectId: Id.nullable().optional(),
      priority: Priority.optional(),
      estimateMinutes: Estimate.optional(),
    })
    .strict(),
  z.object({ action: z.enum(['start', 'stop', 'complete', 'reopen']), taskId: Id }).strict(),
  z.object({ action: z.literal('arrange'), items: ArrangeItems }).strict(),
]);
export type AssistantChange = z.infer<typeof AssistantChange>;

export const ApplyChangesInput = z.object({ changes: z.array(AssistantChange).min(1).max(50) }).strict();
export type ApplyChangesInput = z.input<typeof ApplyChangesInput>;

export interface ApplyResult {
  /** One per change, in order. A failed change doesn't stop the rest. */
  results: { ok: boolean; error?: string }[];
}

export interface AssistantStatus {
  available: boolean;
  /** Why not, in words for the user. */
  reason?: string;
}

/** A suggested working order for open top-level tasks, first = do first. */
export interface PrioritySuggestion {
  /** One or two sentences on the overall reasoning. */
  summary: string;
  items: { taskId: string; priority: Priority; reason: string | null }[];
}

export const AssistantChatInput = z
  .object({
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(8000) }).strict())
      .min(1)
      .max(40),
  })
  .strict();
export type AssistantChatInput = z.input<typeof AssistantChatInput>;

/** Lines of the chat stream (NDJSON). */
export type ChatStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'proposal'; summary: string; changes: AssistantChange[] }
  | { type: 'error'; message: string }
  | { type: 'done' };

// ---------- Activity ----------

export const ActivityQuery = z.object({
  /** `agents` = everything not done by the owner directly (tokens and the assistant). */
  who: z.enum(['all', 'agents']).optional(),
  taskId: Id.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  /** `nextCursor` from the previous page. */
  cursor: z.coerce.number().int().min(1).optional(),
});
export type ActivityQuery = z.input<typeof ActivityQuery>;

/** One change to a task or project, with the state before it (null = it was created). */
export interface ActivityChange {
  eventId: number;
  entity: 'task' | 'project';
  entityId: string;
  action: string;
  before: Task | Project | null;
  after: Task | Project;
}

/** Everything one request changed, e.g. completing a task and its subtasks. */
export interface ActivityEntry {
  batchId: string;
  at: string;
  /** `owner`, `ai:assistant` or `token:<name>` */
  actor: string;
  changes: ActivityChange[];
  /** Why it can't be undone, or null when it can. */
  cantUndo: string | null;
  /** Set when a later entry undid this one. */
  undoneAt: string | null;
  /** This entry undid that batch. */
  undoOf: string | null;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  nextCursor: number | null;
}

// ---------- Timer ----------

export const TIMER_STATUSES = ['running', 'paused', 'finished'] as const;
export type TimerStatus = (typeof TIMER_STATUSES)[number];

/** A countdown. Only the live one is ever sent; `ended` means it was stopped or dismissed. */
export interface Timer {
  id: string;
  label: string | null;
  taskId: string | null;
  durationMs: number;
  status: TimerStatus;
  /** When it rings (running) or rang (finished); null while paused. */
  endsAt: string | null;
  /** Time left while paused. */
  remainingMs: number | null;
  ended: boolean;
  createdAt: string;
  updatedAt: string;
}

export const StartTimerInput = z
  .object({
    minutes: z.number().positive().max(24 * 60),
    label: z.string().trim().max(200).nullable().optional(),
    taskId: Id.nullable().optional(),
  })
  .strict();
export type StartTimerInput = z.input<typeof StartTimerInput>;

export const ExtendTimerInput = z.object({ minutes: z.number().positive().max(24 * 60) }).strict();
export type ExtendTimerInput = z.input<typeof ExtendTimerInput>;

export const PushSubscriptionInput = z
  .object({
    endpoint: z.url().max(2000),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  })
  .loose();
export type PushSubscriptionInput = z.input<typeof PushSubscriptionInput>;

// ---------- Realtime ----------

export const EVENT_ENTITIES = ['task', 'project', 'token', 'timer'] as const;
export type EventEntity = (typeof EVENT_ENTITIES)[number];

export interface HelmEvent {
  id: number;
  at: string;
  /** `owner` or `token:<name>` */
  actor: string;
  entity: EventEntity;
  entityId: string;
  /** created | updated | moved | started | stopped | completed | reopened | deleted | archived | restored | agent | noted */
  action: string;
  /** Full snapshot of the entity after the change. Token events reach the owner only. */
  data: Task | Project | ApiToken | Timer;
}

// ---------- Defaults ----------

export const PROJECT_COLORS = [
  '#6E8BFF', // periwinkle
  '#3FB68B', // jade
  '#E7A93B', // amber
  '#E26D6D', // coral
  '#A57BE0', // lilac
  '#3BB4C9', // teal
  '#D9779F', // rose
  '#8C9A5B', // olive
] as const;
