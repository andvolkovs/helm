import {
  addDays,
  dayKey,
  dayRange,
  formatDay,
  MAX_TODAY_MAIN,
  planDayOf,
  PRIORITIES,
  shownDayOf,
  weekStart,
  type Priority,
  type Task,
  type TaskNode,
} from '@helm/shared';

/** One day of the week view. */
export interface DayPlan {
  /** `YYYY-MM-DD`. */
  day: string;
  isToday: boolean;
  /** Before today: its open tasks have moved on to today. */
  past: boolean;
  /** Open tasks shown on this day, in the order they were planned. */
  main: TaskNode[];
  side: TaskNode[];
  /** Planned tasks finished on this day. */
  done: Task[];
  /** For a past day: tasks planned for it that weren't finished and now show on today. */
  movedOn: number;
  /** Estimates of the open tasks, in minutes. */
  minutes: number;
  /** Open tasks without an estimate. */
  unestimated: number;
}

/** In the order they went on the plan. */
const byPlanned = (a: Task, b: Task) => (a.todayAt ?? '').localeCompare(b.todayAt ?? '') || a.id.localeCompare(b.id);

/** The seven days (Monday first) of the week `offset` weeks from this one. */
export function weekDays(today: string, offset = 0): string[] {
  const start = addDays(weekStart(today), offset * 7);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Midnight at the start of `day` on this device, for queries by time. */
export const startOfDayKey = (day: string) => new Date(`${day}T00:00:00`);

/**
 * Planned tasks that are done: the task cache (fresh as you tick things off) and the done log
 * (which also has them after a reload); the cache wins when both have one.
 */
export function donePlanned(live: readonly Task[], log: readonly Task[]): Task[] {
  const byId = new Map<string, Task>();
  for (const t of log) byId.set(t.id, t);
  for (const t of live) if (byId.has(t.id) || t.status === 'done') byId.set(t.id, t);
  return [...byId.values()]
    .filter((t) => t.today && !t.parentTaskId && !t.deletedAt && t.status === 'done' && t.completedAt)
    .sort((a, b) => a.completedAt!.localeCompare(b.completedAt!));
}

/** The plan for each of `days`: open tasks where they show, and what was finished on each. */
export function weekPlan(roots: readonly TaskNode[], done: readonly Task[], days: readonly string[], today: string): DayPlan[] {
  const open = roots.filter((t) => t.today && t.status !== 'done' && !t.deletedAt).sort(byPlanned);
  return days.map((day) => {
    const here = open.filter((t) => shownDayOf(t, today) === day);
    return {
      day,
      isToday: day === today,
      past: day < today,
      main: here.filter((t) => t.today === 'main'),
      side: here.filter((t) => t.today === 'side'),
      done: done.filter((t) => dayKey(new Date(t.completedAt!)) === day),
      movedOn: day < today ? open.filter((t) => planDayOf(t) === day).length : 0,
      minutes: here.reduce((sum, t) => sum + (t.estimateMinutes ?? 0), 0),
      unestimated: here.filter((t) => !t.estimateMinutes).length,
    };
  });
}

export const mainFull = (d: Pick<DayPlan, 'main'>, except?: string) =>
  d.main.filter((t) => t.id !== except).length >= MAX_TODAY_MAIN;

const RANK: Record<Priority, number> = Object.fromEntries(PRIORITIES.map((p, i) => [p, i])) as Record<Priority, number>;

/** Open board tasks with no day yet, Now first, then in board order. */
export function unplanned(roots: readonly TaskNode[], priorities: ReadonlySet<Priority>): TaskNode[] {
  return roots
    .filter((t) => !t.today && !t.todayOnly && t.status !== 'done' && !t.deletedAt && priorities.has(t.priority))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => RANK[a.t.priority] - RANK[b.t.priority] || a.i - b.i)
    .map(({ t }) => t);
}

/**
 * Where a dropped (or moved) task should go: the slot, plus the day when it changes. null when
 * nothing would change. A carried-over task dropped on today keeps its own day ("from Tue").
 */
export function placement(
  t: Task,
  to: { day: string; slot: 'main' | 'side' | 'keep' },
  today: string,
): { today: 'main' | 'side'; planDate?: string } | null {
  const slot = to.slot === 'keep' ? (t.today ?? 'side') : to.slot;
  const shown = shownDayOf(t, today);
  if (shown === to.day && slot === t.today) return null;
  return shown === to.day ? { today: slot } : { today: slot, planDate: to.day };
}

/** "This week", "Next week", "Last week" or "Week of 5 Oct". */
export function weekTitle(offset: number, days: readonly string[]): string {
  if (offset === 0) return 'This week';
  if (offset === 1) return 'Next week';
  if (offset === -1) return 'Last week';
  return `Week of ${formatDay(days[0]!, { day: 'numeric', month: 'short' })}`;
}

/** "12 – 18 October", or "28 September – 4 October" across months (in the locale's order). */
export function weekRange(days: readonly string[]): string {
  return dayRange(days[0]!, days[days.length - 1]!);
}

/** How a day's load reads under its bar, against the daily budget. */
export function loadText(d: DayPlan, budget: number, fmt: (min: number) => string): { text: string; over: boolean } {
  const count = d.main.length + d.side.length;
  if (d.isToday) {
    const total = count + d.done.length;
    if (!total) return { text: 'Free', over: false };
    const left = d.minutes ? ` · about ${fmt(d.minutes)} left` : '';
    return { text: `${d.done.length} of ${total} done${left}`, over: d.minutes > budget };
  }
  if (!count) return { text: 'Free', over: false };
  if (!d.minutes) return { text: `${count} ${count === 1 ? 'task' : 'tasks'}, no estimates`, over: false };
  if (d.minutes > budget) return { text: `${fmt(d.minutes)} · ${fmt(d.minutes - budget)} over`, over: true };
  return { text: `${fmt(d.minutes)} · room for ${fmt(budget - d.minutes)}`, over: false };
}
