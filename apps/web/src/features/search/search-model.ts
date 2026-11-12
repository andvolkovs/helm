import type { Priority, Task } from '@helm/shared';
import type { Route } from '../../lib/route.ts';

/** Open tasks listed in the palette, and done ones asked from the server. */
export const OPEN_SHOWN = 8;
export const DONE_SHOWN = 5;
/** Shorter than this, asking the server for done tasks would match nearly everything. */
export const DONE_MIN_CHARS = 2;

const RANK: Record<Priority, number> = { now: 0, soon: 1, someday: 2 };

/** What was typed as lowercase words; a task must contain all of them. */
export function searchWords(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Open tasks (top-level and subtasks) that contain every word in the title or notes. Title matches
 * come first, then Now before Soon before Someday; ties keep the order given (board order).
 */
export function searchOpen(tasks: readonly Task[], query: string, limit = OPEN_SHOWN): Task[] {
  const words = searchWords(query);
  if (!words.length) return [];
  const found: { t: Task; i: number; notesOnly: boolean }[] = [];
  tasks.forEach((t, i) => {
    if (t.status === 'done' || t.deletedAt) return;
    const title = t.title.toLowerCase();
    const notes = (t.notes ?? '').toLowerCase();
    if (!words.every((w) => title.includes(w) || notes.includes(w))) return;
    found.push({ t, i, notesOnly: !words.every((w) => title.includes(w)) });
  });
  return found
    .sort((a, b) => Number(a.notesOnly) - Number(b.notesOnly) || RANK[a.t.priority] - RANK[b.t.priority] || a.i - b.i)
    .slice(0, limit)
    .map(({ t }) => t);
}

/** A view the palette can jump to. */
export interface ViewLink {
  route: Route;
  label: string;
  /** The single-key shortcut, shown beside it. */
  key: string;
}

/** "Go to ..." links whose name contains every typed word; all of them for an empty query. */
export function matchViews<T extends ViewLink>(views: readonly T[], query: string): T[] {
  // "go to week" works as well as "week"; "to" alone would match every "Go to ...".
  const words = searchWords(query.replace(/^\s*go(\s+to)?(\s|$)/i, ''));
  return views.filter((v) => words.every((w) => v.label.toLowerCase().includes(w)));
}

/** One selectable row, in the order shown. */
export type Entry =
  | { id: string; kind: 'open'; task: Task }
  | { id: string; kind: 'done'; task: Task }
  | { id: string; kind: 'new'; title: string }
  | { id: string; kind: 'view'; view: ViewLink };

export const NEW_ID = 'new';

/** The longest query the server takes for done tasks; the input stops there too. */
export const QUERY_MAX = 200;

/**
 * The rows in order: open tasks, done tasks, then actions (New task first, then the view jumps).
 * A query that names a view outright ("week", "go to done") puts that view first, so Enter goes
 * there instead of making a task called "week".
 */
export function buildEntries(
  open: readonly Task[],
  done: readonly Task[],
  views: readonly ViewLink[],
  query: string,
): Entry[] {
  const openIds = new Set(open.map((t) => t.id));
  const asked = query.trim().replace(/^go(\s+to)?\s+/i, '').toLowerCase();
  const named = views.find((v) => v.label.toLowerCase() === asked);
  return [
    ...(named ? [{ id: `view:${named.route}`, kind: 'view', view: named } satisfies Entry] : []),
    ...open.map((task): Entry => ({ id: `open:${task.id}`, kind: 'open', task })),
    // A task can be in both for a moment while a completion is syncing; show it once.
    ...done.filter((t) => !openIds.has(t.id)).map((task): Entry => ({ id: `done:${task.id}`, kind: 'done', task })),
    { id: NEW_ID, kind: 'new', title: query.trim() },
    ...matchViews(views, query)
      .filter((v) => v !== named)
      .map((view): Entry => ({ id: `view:${view.route}`, kind: 'view', view })),
  ];
}
