import { buildTree, dayKey, formatDay, shownDayOf, type Project, type Task, type TaskNode } from '@helm/shared';

/** Top-level tasks sent to the model at most; the rest are summarised as a count. */
export const MAX_TASKS = 150;

/**
 * The board as text for a model. Tasks get short refs (t1, t2...) instead of ids: fewer
 * tokens, fewer copy mistakes. `refs` maps them back.
 */
export interface Snapshot {
  text: string;
  /** Open top-level tasks in board order (the ones that can be ranked). */
  open: TaskNode[];
  refs: Map<string, Task>;
  projects: Project[];
}

const PRIORITY_WORD = { now: 'now', soon: 'soon', someday: 'someday' } as const;

export function ago(iso: string, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 21) return `${d} days ago`;
  return `${Math.round(d / 7)} weeks ago`;
}

export function today(now: Date, timeZone?: string): string {
  const fmt = (tz?: string) =>
    new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: tz,
    }).format(now);
  try {
    return fmt(timeZone);
  } catch {
    return fmt();
  }
}

export function buildSnapshot(
  board: Task[],
  projects: Project[],
  recentlyDone: Task[],
  now: Date,
  timeZone?: string,
): Snapshot {
  const todayKey = dayKey(now, timeZone);
  const planned = (t: Task) => {
    const day = shownDayOf(t, todayKey, timeZone);
    if (!day) return null;
    const slot = t.today === 'main' ? 'main' : 'secondary';
    return day === todayKey
      ? `on the user's Today list (${slot})`
      : `planned for ${formatDay(day, { weekday: 'long', day: 'numeric', month: 'long' }, 'en-GB')} (${slot})`;
  };
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const nameOf = (t: Task) => (t.projectId ? (projectName.get(t.projectId) ?? 'Inbox') : 'Inbox');
  const open = buildTree(board).filter((n) => n.status !== 'done');
  const shown = open.slice(0, MAX_TASKS);

  const refs = new Map<string, Task>();
  let n = 0;
  const ref = (t: Task) => {
    const r = `t${++n}`;
    refs.set(r, t);
    return r;
  };

  const lines: string[] = [];
  for (const t of shown) {
    const parts = [
      `${ref(t)}: ${t.title}`,
      `project ${nameOf(t)}`,
      `priority ${PRIORITY_WORD[t.priority]}`,
      t.status === 'in_progress' ? `IN PROGRESS, started ${ago(t.startedAt ?? t.updatedAt, now)}` : null,
      t.estimateMinutes ? `estimate ${t.estimateMinutes} min` : null,
      planned(t),
      `added ${ago(t.createdAt, now)}`,
      t.source !== 'manual' ? `added by ${t.source}` : null,
      t.agentState === 'ready'
        ? 'handed to agents, not claimed yet'
        : t.agentState === 'working'
          ? `an agent (${t.agentClaimedBy}) is working on it`
          : t.agentState === 'review'
            ? 'an agent finished it, waiting for the user to review'
            : null,
    ].filter(Boolean);
    lines.push(`- ${parts.join('; ')}`);
    if (t.notes) lines.push(`  notes: ${t.notes.replace(/\s+/g, ' ').slice(0, 300)}`);
    for (const s of t.subtasks) {
      const state = s.status === 'done' ? 'done' : s.status === 'in_progress' ? 'in progress' : 'open';
      lines.push(`  - ${ref(s)} (subtask, ${state}): ${s.title}`);
    }
  }
  if (open.length > shown.length) lines.push(`(${open.length - shown.length} more open tasks not shown)`);

  const done = recentlyDone.map((t) => `- ${t.title} (${nameOf(t)}, done ${ago(t.completedAt!, now)})`);
  const text = [
    `Projects: ${projects.length ? projects.map((p) => p.name).join(', ') : 'none yet'}. Tasks without a project are in the Inbox.`,
    '',
    'Open tasks, in the order they sit on the board:',
    lines.length ? lines.join('\n') : '(none)',
    '',
    'Done in the last 7 days:',
    done.length ? done.join('\n') : '(nothing)',
  ].join('\n');

  return { text, open: shown, refs, projects };
}
