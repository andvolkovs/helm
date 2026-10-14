import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AGENT_STATES,
  TODAY_SLOTS,
  PlanDate,
  buildTree,
  dayKey,
  planDayOf,
  shownDayOf,
  INBOX,
  PRIORITIES,
  projectCandidates,
  type Priority,
  type Task,
  type TaskNode,
} from '@helm/shared';
import { z } from 'zod';
import type { Config } from '../../config.ts';
import type { Principal } from '../../core/auth/principal.ts';
import { HelmError, invalid } from '../../core/errors.ts';
import type { Services } from '../../core/services/index.ts';

const Id = z.string().min(1).max(64);
const TaskId = Id.describe('Task id, from list_tasks, get_focus or get_task');
const ProjectArg = z
  .string()
  .min(1)
  .max(100)
  .describe('Project name or id. "Inbox" means no project. A unique start or part of the name also works; an ambiguous one is refused.');
const PriorityArg = z.enum(PRIORITIES).describe('now = doing today, soon = this week, someday = later');
const TodayArg = z
  .enum(TODAY_SLOTS)
  .describe("The user's Today list: main = one of the (at most 3) things that make the day, side = if there's time");
const PlanDateArg = PlanDate.describe(
  'A day of the user’s plan, YYYY-MM-DD: the task goes on that day’s list (as side unless `today` says main). Today’s date plans it for today.',
);
const Minutes = z.number().int().min(1).max(1440);
const Note = z.string().min(1).max(5000);

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

function text(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Service errors become tool errors the model can read and act on. */
function run(fn: () => unknown): CallToolResult {
  try {
    return text(fn());
  } catch (err) {
    if (err instanceof HelmError) {
      return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}` }] };
    }
    console.error(err);
    return { isError: true, content: [{ type: 'text', text: 'internal: something went wrong on the server' }] };
  }
}

function agentName(p: Principal): string {
  return p.kind === 'token' ? p.name : 'owner';
}

/**
 * One MCP server per request, bound to the caller's principal: every tool goes through the
 * same services as the REST API, so token scopes apply unchanged. Read-only tokens are not
 * offered the write tools at all.
 */
export function buildMcpServer(services: Services, p: Principal, config: Config): McpServer {
  const canWrite = p.kind === 'owner' || p.scope === 'read_write';
  const limit = config.rules.inProgressLimit;

  const server = new McpServer(
    { name: 'helm', version: '0.1.0' },
    {
      instructions: [
        'Helm is the user’s personal task board, shown on their screens as they work.',
        'Tasks have a priority (now, soon, someday), a status (todo, in_progress, done), an optional estimate in minutes and at most one level of subtasks. Tasks without a project live in the Inbox.',
        limit > 0
          ? `At most ${limit} task(s) can be in progress; starting another pauses the one started longest ago.`
          : 'Any number of tasks can be in progress.',
        'Call get_focus first to see what the user is working on. Only mark tasks done or change priorities when the user asked or clearly finished the work.',
        'Working through tasks on your own: list_tasks with agent_state "ready" shows tasks the user handed to agents. claim_task one before you start (never start_task: that changes what the user is focused on), add_note as you go, then submit_for_review with a short summary. Don’t complete handed-off tasks: the user reviews and completes them. If you can’t finish, hand_back with the reason.',
        'Notes can only be added to (add_note), never rewritten. Nothing can be deleted. The user can see and undo every change you make.',
        canWrite
          ? `Tasks you create are labelled as added by "${agentName(p)}".`
          : 'This connection is read-only.',
      ].join(' '),
    },
  );

  // ---------- Views ----------

  const projectNames = () =>
    new Map(services.projects.list(p, { includeArchived: 'true' }).map((x) => [x.id, x.name]));

  const view = (t: Task, names: Map<string, string>, subtasks?: readonly Task[]) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    project: t.projectId ? (names.get(t.projectId) ?? 'unknown project') : 'Inbox',
    projectId: t.projectId,
    estimateMinutes: t.estimateMinutes,
    ...(t.notes ? { notes: t.notes } : {}),
    ...(t.parentTaskId ? { parentTaskId: t.parentTaskId } : {}),
    ...(subtasks && subtasks.length > 0
      ? {
          progress: `${subtasks.filter((s) => s.status === 'done').length}/${subtasks.length} subtasks done`,
          subtasks: subtasks.map((s) => ({ id: s.id, title: s.title, status: s.status })),
        }
      : {}),
    ...(t.status === 'in_progress' && t.startedAt ? { startedAt: t.startedAt } : {}),
    ...(t.completedAt ? { completedAt: t.completedAt } : {}),
    ...(t.agentState ? { agentState: t.agentState } : {}),
    ...(t.agentClaimedBy ? { claimedBy: t.agentClaimedBy.replace(/^token:/, '') } : {}),
    ...(t.today ? { today: t.today, plannedFor: planDayOf(t), ...(t.todayOnly ? { todayOnly: true } : {}) } : {}),
    addedBy: t.source,
  });

  const nodeView = (n: TaskNode, names: Map<string, string>) => view(n, names, n.subtasks);

  /** undefined = not given, null = Inbox, else a project id the caller can see. */
  const resolveProject = (arg: string | undefined): string | null | undefined => {
    if (arg === undefined) return undefined;
    if (arg.trim().toLowerCase() === INBOX) return null;
    const projects = services.projects.list(p);
    const byId = projects.find((x) => x.id === arg);
    if (byId) return byId.id;
    const hits = projectCandidates(arg, projects);
    if (hits.length === 1) return hits[0]!.id;
    if (hits.length > 1) {
      throw invalid(`"${arg}" could mean ${hits.map((x) => `"${x.name}"`).join(' or ')}. Use the full project name.`);
    }
    const known = ['Inbox', ...projects.map((x) => x.name)].join(', ');
    throw invalid(`No project matches "${arg}". Projects: ${known}`);
  };

  const withSubtasks = (t: Task) => view(t, projectNames(), services.tasks.subtasks(p, t.id));

  // ---------- Read ----------

  server.registerTool(
    'get_focus',
    {
      title: 'What the user is doing now',
      description:
        'The task in progress (with its subtasks), what is up next, and the rest of the Now list. Start here.',
      annotations: READ,
    },
    () =>
      run(() => {
        const f = services.tasks.focus(p);
        const names = projectNames();
        return {
          inProgress: f.current ? nodeView(f.current, names) : null,
          activeSubtaskId: f.activeSubtaskId,
          alsoInProgress: f.alsoInProgress.map((n) => nodeView(n, names)),
          upNext: f.upNext ? nodeView(f.upNext, names) : null,
          restOfNow: f.now.map((n) => nodeView(n, names)),
        };
      }),
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List open tasks',
      description:
        'Open (not done) tasks with their subtasks, ordered by priority and then by the user’s own order. Filter by project, priority, status, agent hand-off state, Today or text.',
      inputSchema: {
        project: ProjectArg.optional(),
        priority: PriorityArg.optional(),
        status: z.enum(['todo', 'in_progress']).optional(),
        agent_state: z
          .enum(AGENT_STATES)
          .optional()
          .describe('ready = handed to agents and free to claim, working = claimed, review = waiting for the user'),
        query: z.string().max(200).optional().describe('Case-insensitive text to find in titles and notes'),
        today: z.boolean().optional().describe('true = only tasks on the user’s Today list (main and side)'),
        planned_for: PlanDate.optional().describe('Only tasks planned for this day, YYYY-MM-DD'),
      },
      annotations: READ,
    },
    (args) =>
      run(() => {
        const projectId = resolveProject(args.project);
        const q = args.query?.toLowerCase();
        const rank = (x: Priority) => PRIORITIES.indexOf(x);
        const names = projectNames();
        const today = dayKey(new Date());
        return buildTree(services.tasks.board(p))
          .filter((n) => n.status !== 'done')
          .filter((n) => projectId === undefined || n.projectId === projectId)
          .filter((n) => !args.priority || n.priority === args.priority)
          .filter((n) => !args.status || n.status === args.status)
          .filter((n) => !args.agent_state || n.agentState === args.agent_state)
          .filter((n) => args.today === undefined || (shownDayOf(n, today) === today) === args.today)
          .filter((n) => !args.planned_for || shownDayOf(n, today) === (args.planned_for < today ? today : args.planned_for))
          .filter((n) => !q || `${n.title}\n${n.notes ?? ''}`.toLowerCase().includes(q))
          .sort((a, b) => rank(a.priority) - rank(b.priority))
          .map((n) => nodeView(n, names));
      }),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get a task',
      description: 'One task with its notes and all of its subtasks, done or not.',
      inputSchema: { id: TaskId },
      annotations: READ,
    },
    ({ id }) => run(() => withSubtasks(services.tasks.get(p, id))),
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'Projects the user sorts tasks into, with how many open tasks each has. The Inbox holds tasks without a project.',
      annotations: READ,
    },
    () =>
      run(() => {
        const open = buildTree(services.tasks.board(p)).filter((n) => n.status !== 'done');
        const count = (id: string | null) => open.filter((n) => n.projectId === id).length;
        const projects = services.projects.list(p).map((x) => ({ id: x.id, name: x.name, openTasks: count(x.id) }));
        const inboxVisible = p.kind === 'owner' || p.projectIds === null;
        return inboxVisible ? [{ id: null, name: 'Inbox', openTasks: count(null) }, ...projects] : projects;
      }),
  );

  server.registerTool(
    'list_done',
    {
      title: 'List finished tasks',
      description: 'Tasks marked done recently, newest first.',
      inputSchema: {
        project: ProjectArg.optional(),
        days: z.number().int().min(1).max(365).default(7).describe('How many days back to look'),
        include_subtasks: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: READ,
    },
    (args) =>
      run(() => {
        const projectId = resolveProject(args.project);
        const from = new Date(Date.now() - args.days * 86_400_000).toISOString();
        const page = services.tasks.doneLog(p, {
          from,
          limit: String(args.limit),
          includeSubtasks: String(args.include_subtasks),
          ...(projectId === undefined ? {} : { projectId: projectId ?? INBOX }),
        });
        const names = projectNames();
        return { tasks: page.tasks.map((t) => view(t, names)), more: page.nextCursor !== null };
      }),
  );

  if (!canWrite) return server;

  // ---------- Write ----------

  server.registerTool(
    'create_task',
    {
      title: 'Add a task',
      description:
        'Add a task, optionally with subtasks. Without a project it goes to the Inbox; without a priority it is "soon". Pass parent_task_id to add a single subtask to an existing task instead. Refuses a title that is already open in the same place unless allow_duplicate is true.',
      inputSchema: {
        title: z.string().min(1).max(500),
        notes: z.string().max(10_000).optional(),
        project: ProjectArg.optional(),
        priority: PriorityArg.optional(),
        estimate_minutes: Minutes.optional(),
        parent_task_id: Id.optional().describe('Make this a subtask of that task (inherits its project)'),
        subtasks: z.array(z.string().min(1).max(500)).max(50).optional().describe('Titles of subtasks to add'),
        for_agent: z.boolean().optional().describe('Hand it to agents straight away (agent_state "ready")'),
        allow_duplicate: z.boolean().optional().describe('Add it even if an open task has the same title'),
        today: TodayArg.optional(),
        plan_date: PlanDateArg.optional(),
      },
      annotations: WRITE,
    },
    (args) =>
      run(() => {
        const projectId = resolveProject(args.project);
        if (!args.allow_duplicate) {
          const same = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
          const twin = services.tasks
            .board(p)
            .find(
              (t) =>
                t.status !== 'done' &&
                same(t.title) === same(args.title) &&
                (args.parent_task_id
                  ? t.parentTaskId === args.parent_task_id
                  : !t.parentTaskId && t.projectId === (projectId ?? null)),
            );
          if (twin) {
            throw invalid(
              `An open task with this title already exists (id ${twin.id}). Update that one, or pass allow_duplicate: true.`,
            );
          }
        }
        const task = services.tasks.create(p, {
          title: args.title,
          notes: args.notes,
          projectId: projectId ?? null,
          priority: args.priority,
          estimateMinutes: args.estimate_minutes,
          parentTaskId: args.parent_task_id,
          subtasks: args.subtasks?.map((title) => ({ title })),
          agentState: args.for_agent ? 'ready' : undefined,
          today: args.today,
          planDate: args.plan_date,
        });
        return withSubtasks(task);
      }),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Edit a task',
      description:
        'Change a task’s title, priority, estimate, project or place on Today. Only the fields you pass change. To write notes use add_note.',
      inputSchema: {
        id: TaskId,
        title: z.string().min(1).max(500).optional(),
        priority: PriorityArg.optional(),
        estimate_minutes: Minutes.nullable().optional().describe('null clears the estimate'),
        project: ProjectArg.optional().describe('Move to this project ("Inbox" for none); subtasks follow'),
        today: TodayArg.nullable().optional().describe('Put on Today as main or side; null takes it off'),
        plan_date: PlanDateArg.optional().describe('Move it to another day of the plan, YYYY-MM-DD'),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    (args) =>
      run(() => {
        const projectId = resolveProject(args.project);
        const task = services.tasks.update(p, args.id, {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.estimate_minutes !== undefined ? { estimateMinutes: args.estimate_minutes } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
          ...(args.today !== undefined ? { today: args.today } : {}),
          ...(args.plan_date !== undefined ? { planDate: args.plan_date } : {}),
        });
        return withSubtasks(task);
      }),
  );

  const statusTool = (
    name: string,
    title: string,
    description: string,
    action: 'start' | 'stop' | 'complete' | 'reopen',
  ) =>
    server.registerTool(
      name,
      { title, description, inputSchema: { id: TaskId }, annotations: { ...WRITE, idempotentHint: true } },
      ({ id }) => run(() => withSubtasks(services.tasks[action](p, id))),
    );

  statusTool(
    'start_task',
    'Start a task',
    'Mark a task as in progress, so it shows as the user’s focus (it may pause what they are doing). Only when the user asked. To work on a task yourself, use claim_task.',
    'start',
  );
  statusTool('pause_task', 'Pause a task', 'Move an in-progress task back to todo.', 'stop');
  statusTool(
    'complete_task',
    'Mark a task done',
    'Mark a task done. Completing a task also completes its open subtasks. Only when the user asked or the work is finished. Tasks handed to agents can’t be completed by agents: use submit_for_review.',
    'complete',
  );
  statusTool('reopen_task', 'Reopen a task', 'Put a done task back to todo.', 'reopen');

  server.registerTool(
    'move_task',
    {
      title: 'Move a task',
      description:
        'Change a task’s project or priority, or reorder it. To reorder, give the task it should go right after or right before (a task in the same list).',
      inputSchema: {
        id: TaskId,
        project: ProjectArg.optional(),
        priority: PriorityArg.optional(),
        after_task_id: Id.optional(),
        before_task_id: Id.optional(),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    (args) =>
      run(() => {
        const projectId = resolveProject(args.project);
        const task = services.tasks.move(p, args.id, {
          ...(projectId !== undefined ? { projectId } : {}),
          ...(args.priority ? { priority: args.priority } : {}),
          ...(args.after_task_id ? { afterId: args.after_task_id } : {}),
          ...(args.before_task_id ? { beforeId: args.before_task_id } : {}),
        });
        return withSubtasks(task);
      }),
  );

  // ---------- Notes and hand-off ----------

  server.registerTool(
    'add_note',
    {
      title: 'Add to a task’s notes',
      description:
        'Add a paragraph below the task’s notes, signed with your name and the date: progress, findings, links, questions. Existing notes are never changed.',
      inputSchema: { id: TaskId, text: Note },
      annotations: WRITE,
    },
    ({ id, text: note }) => run(() => withSubtasks(services.tasks.appendNote(p, id, { text: note }))),
  );

  const agentTool = (
    name: string,
    title: string,
    description: string,
    state: 'ready' | 'working' | 'review' | null,
    note: 'required' | 'optional' | 'none',
  ) =>
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: {
          id: TaskId,
          ...(note === 'required' ? { note: Note } : note === 'optional' ? { note: Note.optional() } : {}),
        },
        annotations: { ...WRITE, idempotentHint: true },
      },
      (args: { id: string; note?: string }) =>
        run(() => withSubtasks(services.tasks.setAgentState(p, args.id, { state, note: args.note }))),
    );

  agentTool(
    'mark_for_agent',
    'Hand a task to agents',
    'Mark a task as one an AI agent can do (agent_state "ready"), e.g. when sorting the Inbox. Add why in note if useful.',
    'ready',
    'optional',
  );
  agentTool(
    'claim_task',
    'Claim a task to work on',
    'Take a task marked "ready" before working on it, so no other agent picks it up. Doesn’t change the user’s focus.',
    'working',
    'none',
  );
  agentTool(
    'submit_for_review',
    'Hand in finished work',
    'Say a claimed task is finished. note: what you did and where to look (branch, PR, files). The user reviews and completes it.',
    'review',
    'required',
  );
  agentTool(
    'hand_back',
    'Give a task back',
    'Release a claimed task you can’t finish, back to "ready" for another try. note: why, and what you found.',
    'ready',
    'required',
  );

  return server;
}
