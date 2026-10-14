import { dayKey, formatDay, type ActivityChange, type ActivityEntry, type Project, type Task } from '@helm/shared';
import { formatMinutes } from '../../lib/format.ts';

/** `owner` → You, `token:Claude Code` → Claude Code, `ai:assistant` → Assistant. */
export function actorLabel(actor: string): string {
  if (actor === 'owner') return 'You';
  if (actor === 'ai:assistant') return 'Assistant';
  const name = actor.replace(/^(token|ai):/, '');
  return name || actor;
}

export const isAgent = (actor: string) => actor !== 'owner';

export interface ChangeLine {
  key: string;
  text: string;
  /** Field-by-field detail, e.g. "Priority: Soon → Now". */
  details: string[];
  /** Subtasks that changed the same way, folded into this line. */
  alsoSubtasks: number;
}

type Names = (projectId: string | null) => string;

const PRIORITY = { now: 'Now', soon: 'Soon', someday: 'Someday' } as const;
const q = (s: string) => `“${s}”`;
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The paragraph an append added, or null when the notes were rewritten. */
export function addedNote(before: string | null, after: string | null): string | null {
  if (!after) return null;
  const old = before?.trimEnd() ?? '';
  if (!after.startsWith(old)) return null;
  return after.slice(old.length).trim() || null;
}

function taskDetails(b: Task, a: Task, names: Names): string[] {
  const out: string[] = [];
  if (b.title !== a.title) out.push(`Title: ${q(b.title)} → ${q(a.title)}`);
  if (b.projectId !== a.projectId) out.push(`Project: ${names(b.projectId)} → ${names(a.projectId)}`);
  if (b.priority !== a.priority) out.push(`Priority: ${PRIORITY[b.priority]} → ${PRIORITY[a.priority]}`);
  if (b.estimateMinutes !== a.estimateMinutes) {
    const est = (m: number | null) => (m ? formatMinutes(m) : 'none');
    out.push(`Estimate: ${est(b.estimateMinutes)} → ${est(a.estimateMinutes)}`);
  }
  if (b.notes !== a.notes) {
    const added = addedNote(b.notes, a.notes);
    out.push(
      !a.notes ? 'Notes cleared' : added ? `Note added: ${clip(added)}` : b.notes ? 'Notes rewritten' : `Notes: ${clip(a.notes)}`,
    );
  }
  // Only undo writes these in a plain update; normal status and hand-off steps have their own actions.
  if (b.status !== a.status) out.push(`Status: ${STATUS[b.status]} → ${STATUS[a.status]}`);
  if (b.agentState !== a.agentState) out.push(`Agents: ${AGENT[b.agentState ?? 'none']} → ${AGENT[a.agentState ?? 'none']}`);
  // Events from before Today existed have no `today`.
  if ((b.today ?? null) !== (a.today ?? null)) out.push(`Today: ${TODAY[b.today ?? 'none']} → ${TODAY[a.today ?? 'none']}`);
  if (b.planDate && a.planDate && b.planDate !== a.planDate) out.push(`Day: ${dayName(b.planDate)} → ${dayName(a.planDate)}`);
  return out;
}

const dayName = (day: string) => formatDay(day, { weekday: 'short', day: 'numeric', month: 'short' });

/** "on Today", or "for Thu 15 Oct" when it was planned for a later day than the one it went on. */
function planPlace(t: Task): string {
  const ahead = t.planDate && t.todayAt && t.planDate > dayKey(new Date(t.todayAt));
  return ahead ? `for ${dayName(t.planDate!)}` : 'on Today';
}

const TODAY = { none: 'not on it', main: 'main', side: 'secondary' } as const;

const STATUS = { todo: 'To do', in_progress: 'In progress', done: 'Done' } as const;
const AGENT = { none: 'not handed over', ready: 'waiting', working: 'working on it', review: 'for review' } as const;

function taskLine(c: ActivityChange, names: Names): Omit<ChangeLine, 'key' | 'alsoSubtasks'> | null {
  const a = c.after as Task;
  const b = c.before as Task | null;
  const t = q(a.title);
  switch (c.action) {
    case 'created':
      return { text: `Added ${t}${a.parentTaskId ? '' : ` to ${a.todayOnly ? 'Today' : names(a.projectId)}`}`, details: [] };
    case 'completed':
      return { text: `Completed ${t}`, details: [] };
    case 'reopened':
      return { text: `Reopened ${t}`, details: [] };
    case 'started':
      return { text: `Started ${t}`, details: [] };
    case 'stopped':
      return { text: `Paused ${t}`, details: [] };
    case 'deleted':
      return { text: `Deleted ${t}`, details: [] };
    case 'restored':
      return { text: `Brought back ${t}`, details: b ? taskDetails(b, a, names) : [] };
    case 'noted': {
      const added = addedNote(b?.notes ?? null, a.notes);
      return { text: `Added a note to ${t}`, details: added ? [clip(added, 400)] : [] };
    }
    case 'agent': {
      if (a.agentState === 'ready') {
        return { text: b?.agentState === 'working' ? `Handed ${t} back` : `Handed ${t} to agents`, details: [] };
      }
      if (a.agentState === 'working') return { text: `Claimed ${t}`, details: [] };
      if (a.agentState === 'review') return { text: `Sent ${t} for review`, details: [] };
      return { text: `Took ${t} off the agents’ list`, details: [] };
    }
    default: {
      // updated / moved (and anything newer): describe what differs.
      if (!b) return { text: `Changed ${t}`, details: [] };
      const details = taskDetails(b, a, names);
      if (details.length === 0) return b.position !== a.position ? { text: `Reordered ${t}`, details: [] } : null;
      if (details.length === 1 && b.projectId !== a.projectId) return { text: `Moved ${t} to ${names(a.projectId)}`, details: [] };
      if (details.length === 1 && b.priority !== a.priority) {
        return { text: `Set ${t} to ${PRIORITY[a.priority]}`, details: [] };
      }
      if (details.length === 1 && (b.today ?? null) !== (a.today ?? null)) {
        if (!a.today) return { text: `Took ${t} off ${b.planDate ? 'the plan' : 'Today'}`, details: [] };
        if (b.today) return { text: `Made ${t} ${a.today === 'main' ? 'a main task' : 'secondary'} ${planPlace(a)}`, details: [] };
        const verb = planPlace(a) === 'on Today' ? 'Put' : 'Planned';
        return { text: `${verb} ${t} ${planPlace(a)}${a.today === 'main' ? ' as a main task' : ''}`, details: [] };
      }
      if (details.length === 1 && b.planDate && a.planDate && b.planDate !== a.planDate) {
        return { text: `Moved ${t} to ${dayName(a.planDate)}`, details: [] };
      }
      return { text: `Changed ${t}`, details };
    }
  }
}

function projectLine(c: ActivityChange): Omit<ChangeLine, 'key' | 'alsoSubtasks'> | null {
  const a = c.after as Project;
  const b = c.before as Project | null;
  const p = q(a.name);
  switch (c.action) {
    case 'created':
      return { text: `Created project ${p}`, details: [] };
    case 'archived':
      return { text: `Archived project ${p}`, details: [] };
    case 'restored':
      return { text: `Brought back project ${p}`, details: [] };
    case 'deleted':
      return { text: `Deleted project ${p} and its tasks`, details: [] };
    case 'moved':
      return { text: `Reordered project ${p}`, details: [] };
    default: {
      if (!b) return { text: `Changed project ${p}`, details: [] };
      const details: string[] = [];
      if (b.name !== a.name) details.push(`Name: ${q(b.name)} → ${p}`);
      if (b.color !== a.color) details.push('New color');
      if (b.icon !== a.icon) details.push(`Icon: ${a.icon ?? 'automatic'}`);
      // Folding a panel open or shut isn't worth a line.
      return details.length ? { text: `Changed project ${q(b.name)}`, details } : null;
    }
  }
}

/**
 * One entry as readable lines. Subtasks that changed the same way as their parent in the same
 * step (completing a task completes its subtasks) fold into the parent's line.
 */
export function describeEntry(entry: ActivityEntry, names: Names): ChangeLine[] {
  const lines: (ChangeLine & { taskId?: string; action?: string })[] = [];
  const topActions = new Set(
    entry.changes
      .filter((c) => c.entity === 'task' && !(c.after as Task).parentTaskId)
      .map((c) => `${c.entityId}:${c.action}`),
  );
  for (const c of entry.changes) {
    if (c.entity === 'task') {
      const parent = (c.after as Task).parentTaskId;
      if (parent && topActions.has(`${parent}:${c.action}`)) {
        const host = lines.find((l) => l.taskId === parent && l.action === c.action);
        if (host) {
          host.alsoSubtasks++;
          continue;
        }
      }
    }
    const line = c.entity === 'task' ? taskLine(c, names) : projectLine(c);
    if (line) lines.push({ ...line, key: String(c.eventId), alsoSubtasks: 0, taskId: c.entityId, action: c.action });
  }
  return lines.map(({ taskId: _t, action: _a, ...l }) => l);
}

/** The task an entry is mostly about, to open it. */
export function mainTaskId(entry: ActivityEntry): string | null {
  return entry.changes.find((c) => c.entity === 'task')?.entityId ?? null;
}
