import { byPosition, type Task } from '@helm/shared';

export const RANGES = ['today', 'week', 'month', 'all', 'custom'] as const;
export type RangeKey = (typeof RANGES)[number];

export const RANGE_LABEL: Record<RangeKey, string> = {
  today: 'Today',
  week: '7 days',
  month: '30 days',
  all: 'All time',
  custom: 'Dates…',
};

export interface DoneFilter {
  range: RangeKey;
  /** Project id, `inbox`, or null for every project. */
  project: string | null;
  /** Custom range, inclusive local dates as `yyyy-mm-dd`. */
  from: string | null;
  to: string | null;
  /** Words that must each be in the title or notes. */
  q: string | null;
  /** A task to point out, e.g. the one picked in search. */
  task: string | null;
}

export const DEFAULT_FILTER: DoneFilter = { range: 'today', project: null, from: null, to: null, q: null, task: null };

/** The server's limit on the words filter. */
export const DONE_QUERY_MAX = 200;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function filterFromParams(params: URLSearchParams): DoneFilter {
  const range = params.get('range');
  const date = (k: string) => {
    const v = params.get(k);
    return v && DATE.test(v) ? v : null;
  };
  return {
    range: RANGES.includes(range as RangeKey) ? (range as RangeKey) : DEFAULT_FILTER.range,
    project: params.get('project') || null,
    from: date('from'),
    to: date('to'),
    q: params.get('q')?.trim().slice(0, DONE_QUERY_MAX) || null,
    task: params.get('task') || null,
  };
}

export function filterToParams(f: DoneFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (f.range !== DEFAULT_FILTER.range) params.set('range', f.range);
  if (f.project) params.set('project', f.project);
  if (f.range === 'custom') {
    if (f.from) params.set('from', f.from);
    if (f.to) params.set('to', f.to);
  }
  if (f.q) params.set('q', f.q);
  if (f.task) params.set('task', f.task);
  return params;
}

// ---------- Dates (all local time) ----------

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** `yyyy-mm-dd` for the local calendar day. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseDay(key: string): Date {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** ISO bounds for the API: `from` inclusive, `to` exclusive. */
export function rangeBounds(f: DoneFilter, now: Date): { from?: string; to?: string } {
  const today = startOfDay(now);
  switch (f.range) {
    case 'today':
      return { from: today.toISOString() };
    case 'week':
      return { from: addDays(today, -6).toISOString() };
    case 'month':
      return { from: addDays(today, -29).toISOString() };
    case 'all':
      return {};
    case 'custom': {
      // Swap a reversed pair rather than showing an empty log.
      let [a, b] = [f.from, f.to];
      if (a && b && a > b) [a, b] = [b, a];
      return {
        from: a ? parseDay(a).toISOString() : undefined,
        to: b ? addDays(parseDay(b), 1).toISOString() : undefined,
      };
    }
  }
}

export function dayLabel(key: string, now: Date): string {
  const today = dayKey(now);
  if (key === today) return 'Today';
  if (key === dayKey(addDays(startOfDay(now), -1))) return 'Yesterday';
  const d = parseDay(key);
  return d.toLocaleDateString([], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

// ---------- Grouping ----------

export interface LogEntry {
  task: Task;
  /** Done subtasks, when their parent is in the log too. */
  subtasks: Task[];
  /** Open parent of a subtask finished on its own. */
  partOf: Task | null;
}

export interface LogDay {
  key: string;
  entries: LogEntry[];
  estimateMinutes: number;
}

/** The Done view's address for one finished task: every date, narrowed to its title, and pointed out. */
export function doneHrefFor(task: Pick<Task, 'id' | 'title'>): string {
  const params = filterToParams({ ...DEFAULT_FILTER, range: 'all', q: task.title.trim().slice(0, DONE_QUERY_MAX) || null, task: task.id });
  return `#/done?${params}`;
}

/** Whether `entry` is, or holds as a subtask, the task with `id`. */
export function entryHolds(entry: LogEntry, id: string | null): boolean {
  return id !== null && (entry.task.id === id || entry.subtasks.some((s) => s.id === id));
}

/**
 * Groups done tasks (newest first) into local days. Subtasks nest under their parent when the
 * parent is in the log; otherwise they stand alone, with the open parent looked up for context.
 */
export function buildLog(done: Task[], lookup: (id: string) => Task | undefined): LogDay[] {
  const seen = new Set<string>();
  const unique = done.filter((t) => !seen.has(t.id) && seen.add(t.id));
  const byId = new Map(unique.map((t) => [t.id, t]));

  const nested = new Map<string, Task[]>();
  for (const t of unique) {
    if (t.parentTaskId && byId.has(t.parentTaskId)) {
      nested.set(t.parentTaskId, [...(nested.get(t.parentTaskId) ?? []), t]);
    }
  }

  const days: LogDay[] = [];
  for (const t of unique) {
    if (!t.completedAt || (t.parentTaskId && byId.has(t.parentTaskId))) continue;
    const subtasks = (nested.get(t.id) ?? []).sort(byPosition);
    const entry: LogEntry = {
      task: t,
      subtasks,
      partOf: t.parentTaskId ? (lookup(t.parentTaskId) ?? null) : null,
    };
    const key = dayKey(new Date(t.completedAt));
    let day = days.at(-1);
    if (day?.key !== key) {
      day = { key, entries: [], estimateMinutes: 0 };
      days.push(day);
    }
    day.entries.push(entry);
    day.estimateMinutes +=
      t.estimateMinutes ?? subtasks.reduce((sum, s) => sum + (s.estimateMinutes ?? 0), 0);
  }
  return days;
}
