import { dayKey, daysBetween, formatDay, shownDayOf, type Task, type TaskNode } from '@helm/shared';

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** In the order they went on Today. */
const byPlanned = (a: Task, b: Task) => (a.todayAt ?? '').localeCompare(b.todayAt ?? '') || a.id.localeCompare(b.id);

/** Open tasks on Today (`today` = `YYYY-MM-DD`), split into main and side. Ones planned for later days stay out. */
export function todayLists(roots: readonly TaskNode[], today: string): { main: TaskNode[]; side: TaskNode[] } {
  const open = roots.filter((t) => t.status !== 'done' && !t.deletedAt && shownDayOf(t, today) === today).sort(byPlanned);
  return { main: open.filter((t) => t.today === 'main'), side: open.filter((t) => t.today === 'side') };
}

/** For a task still on Today from an earlier day: "yesterday", "Monday" or "29 Sep". */
export function carriedFrom(t: Pick<Task, 'todayAt' | 'planDate'>, now: Date): string | null {
  const day = t.planDate ?? (t.todayAt ? dayKey(new Date(t.todayAt)) : null);
  const today = dayKey(now);
  if (!day || day >= today) return null;
  const days = daysBetween(day, today);
  if (days <= 1) return 'yesterday';
  if (days < 7) return formatDay(day, { weekday: 'long' });
  return formatDay(day, { day: 'numeric', month: 'short' });
}

/**
 * Today's tasks finished today. `live` is the task cache (fresh as you tick things off), `log` the
 * done log since midnight (which also has them after a reload); the cache wins when both have one.
 */
export function doneToday(live: readonly Task[], log: readonly Task[], now: Date): Task[] {
  const start = startOfDay(now).getTime();
  const byId = new Map<string, Task>();
  for (const t of log) byId.set(t.id, t);
  for (const t of live) if (byId.has(t.id) || t.status === 'done') byId.set(t.id, t);
  return [...byId.values()]
    .filter(
      (t) =>
        t.today && !t.parentTaskId && !t.deletedAt && t.status === 'done' && t.completedAt && Date.parse(t.completedAt) >= start,
    )
    .sort((a, b) => a.completedAt!.localeCompare(b.completedAt!));
}

/** Estimates of what's left, in minutes. */
export const minutesLeft = (tasks: readonly Task[]) => tasks.reduce((sum, t) => sum + (t.estimateMinutes ?? 0), 0);
