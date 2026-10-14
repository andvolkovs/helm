import type { Task } from './schemas.ts';
import { shownDayOf } from './days.ts';
import { buildTree, type TaskNode } from './tree.ts';

export interface Focus {
  /** The task being worked on now (top-level; if a subtask is active, its parent). */
  current: TaskNode | null;
  /** Set when the active in-progress task is a subtask of `current`. */
  activeSubtaskId: string | null;
  /** Other top-level tasks with in-progress work (only when the in-progress limit is > 1). */
  alsoInProgress: TaskNode[];
  /** What to pick up after `current`: Today's first main task, else the first Now task, else Soon. */
  upNext: TaskNode | null;
  /** Today's main tasks, then the other Now tasks, excluding `current` and `upNext`. */
  now: TaskNode[];
}

function isOpen(t: Task): boolean {
  return t.status !== 'done' && t.deletedAt === null;
}

function hasWorkInProgress(n: TaskNode): boolean {
  return n.status === 'in_progress' || n.subtasks.some((s) => s.status === 'in_progress');
}

/** In the order they went on Today. */
function byPlanned(a: Task, b: Task): number {
  return (a.todayAt ?? '').localeCompare(b.todayAt ?? '');
}

/** Latest-started first. */
function byStartedDesc(a: Task, b: Task): number {
  return (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
}

/**
 * `today` (the user's `YYYY-MM-DD`) keeps main tasks planned for a later day out of Today's;
 * without it, every main task counts.
 */
export function computeFocus(tasks: readonly Task[], today?: string, timeZone?: string): Focus {
  const roots = buildTree(tasks).filter(isOpen);
  const rootById = new Map(roots.map((n) => [n.id, n]));

  const active = tasks.filter((t) => t.status === 'in_progress' && t.deletedAt === null).sort(byStartedDesc)[0];

  let current: TaskNode | null = null;
  let activeSubtaskId: string | null = null;
  if (active) {
    const parent = active.parentTaskId ? rootById.get(active.parentTaskId) : undefined;
    if (parent) {
      current = parent;
      activeSubtaskId = active.id;
    } else {
      current = rootById.get(active.id) ?? null;
    }
  }

  const rest = roots.filter((n) => n.id !== current?.id);
  const alsoInProgress = rest.filter(hasWorkInProgress);
  const isTodayMain = (n: TaskNode) => n.today === 'main' && (!today || shownDayOf(n, today, timeZone) === today);
  const todayMain = rest.filter(isTodayMain).sort(byPlanned);
  const nowList = [...todayMain, ...rest.filter((n) => n.priority === 'now' && !isTodayMain(n))];

  const upNext =
    nowList.find((n) => n.status === 'todo') ??
    rest.find((n) => n.priority === 'soon' && n.status === 'todo') ??
    null;

  return {
    current,
    activeSubtaskId,
    alsoInProgress,
    upNext,
    now: nowList.filter((n) => n.id !== upNext?.id),
  };
}
