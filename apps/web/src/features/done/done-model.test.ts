import { describe, expect, it } from 'vitest';
import type { Task } from '@helm/shared';
import {
  DEFAULT_FILTER,
  buildLog,
  dayKey,
  dayLabel,
  filterFromParams,
  filterToParams,
  doneHrefFor,
  rangeBounds,
  type DoneFilter,
} from './done-model.ts';

function task(p: Partial<Task> & { id: string }): Task {
  return {
    title: p.id,
    notes: null,
    projectId: null,
    priority: 'soon',
    estimateMinutes: null,
    status: 'done',
    parentTaskId: null,
    position: 'a0',
    source: 'manual',
    createdAt: '',
    updatedAt: '',
    startedAt: null,
    completedAt: null,
    deletedAt: null,
    agentState: null,
    agentClaimedBy: null,
    today: null,
    todayAt: null,
    todayOnly: false,
    ...p,
  };
}

/** Local-time ISO string, so tests pass in any time zone. */
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();
const now = new Date(2026, 8, 24, 15, 30); // Thu 24 Sep 2026, 15:30 local

describe('filter <-> hash params', () => {
  it('round-trips and drops defaults', () => {
    const f: DoneFilter = { range: 'custom', project: 'inbox', from: '2026-09-01', to: '2026-09-10', q: 'tax form', task: 't1' };
    expect(filterFromParams(filterToParams(f))).toEqual(f);
    expect(filterToParams(DEFAULT_FILTER).toString()).toBe('');
  });

  it('ignores junk', () => {
    expect(filterFromParams(new URLSearchParams('range=nope&from=yesterday&q=%20%20'))).toEqual(DEFAULT_FILTER);
    expect(filterFromParams(new URLSearchParams(`q=${'x'.repeat(300)}`)).q).toHaveLength(200);
  });

  it('links a finished task to every date, narrowed to its title', () => {
    const href = doneHrefFor({ id: 't9', title: ' Pay & file tax ' });
    expect(href.startsWith('#/done?')).toBe(true);
    expect(filterFromParams(new URLSearchParams(href.split('?')[1]))).toEqual({
      ...DEFAULT_FILTER,
      range: 'all',
      q: 'Pay & file tax',
      task: 't9',
    });
  });
});

describe('rangeBounds', () => {
  const f = (p: Partial<DoneFilter>) => rangeBounds({ ...DEFAULT_FILTER, ...p }, now);

  it('counts whole local days back from today', () => {
    expect(f({ range: 'today' })).toEqual({ from: new Date(2026, 8, 24).toISOString() });
    expect(f({ range: 'week' })).toEqual({ from: new Date(2026, 8, 18).toISOString() });
    expect(f({ range: 'month' })).toEqual({ from: new Date(2026, 7, 26).toISOString() });
    expect(f({ range: 'all' })).toEqual({});
  });

  it('makes custom dates inclusive and swaps a reversed pair', () => {
    const want = { from: new Date(2026, 8, 1).toISOString(), to: new Date(2026, 8, 11).toISOString() };
    expect(f({ range: 'custom', from: '2026-09-01', to: '2026-09-10' })).toEqual(want);
    expect(f({ range: 'custom', from: '2026-09-10', to: '2026-09-01' })).toEqual(want);
    expect(f({ range: 'custom', from: '2026-09-01' })).toEqual({ from: want.from, to: undefined });
  });
});

describe('dayLabel', () => {
  it('names recent days', () => {
    expect(dayLabel('2026-09-24', now)).toBe('Today');
    expect(dayLabel('2026-09-23', now)).toBe('Yesterday');
    expect(dayLabel('2026-09-21', now)).not.toMatch(/2026/);
    expect(dayLabel('2025-12-31', now)).toMatch(/2025/);
  });
});

describe('buildLog', () => {
  const openParent = task({ id: 'open', status: 'todo', title: 'Open parent' });
  const lookup = (id: string) => (id === openParent.id ? openParent : undefined);

  it('groups by local day, nests subtasks under a done parent, sums estimates', () => {
    const log = buildLog(
      [
        task({ id: 'p', completedAt: at(2026, 9, 24, 14), estimateMinutes: null }),
        task({ id: 's2', parentTaskId: 'p', position: 'a2', completedAt: at(2026, 9, 24, 14), estimateMinutes: 20 }),
        task({ id: 's1', parentTaskId: 'p', position: 'a1', completedAt: at(2026, 9, 24, 10), estimateMinutes: 10 }),
        task({ id: 'x', completedAt: at(2026, 9, 24, 9), estimateMinutes: 30 }),
        task({ id: 'y', completedAt: at(2026, 9, 22) }),
      ],
      lookup,
    );
    expect(log.map((d) => d.key)).toEqual(['2026-09-24', '2026-09-22']);
    expect(log[0]!.entries.map((e) => e.task.id)).toEqual(['p', 'x']);
    expect(log[0]!.entries[0]!.subtasks.map((s) => s.id)).toEqual(['s1', 's2']);
    // Parent without its own estimate counts its subtasks' estimates.
    expect(log[0]!.estimateMinutes).toBe(60);
    expect(log[1]!.estimateMinutes).toBe(0);
  });

  it('keeps a lone subtask as its own entry with its open parent, and drops duplicates', () => {
    const sub = task({ id: 's', parentTaskId: 'open', completedAt: at(2026, 9, 24) });
    const log = buildLog([sub, sub], lookup);
    expect(log[0]!.entries).toHaveLength(1);
    expect(log[0]!.entries[0]!.partOf?.title).toBe('Open parent');
  });

  it('uses the local calendar day', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});
