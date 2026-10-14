import { buildTree, type Task } from '@helm/shared';
import { describe, expect, it } from 'vitest';
import { carriedFrom, doneToday, minutesLeft, todayLists } from './today-model.ts';

function task(p: Partial<Task> & { id: string }): Task {
  return {
    title: p.id,
    notes: null,
    projectId: null,
    priority: 'soon',
    estimateMinutes: null,
    status: 'todo',
    parentTaskId: null,
    position: 'a0',
    source: 'manual',
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
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

const now = new Date(2026, 9, 2, 15, 0);
const at = (day: number, hour = 9) => new Date(2026, 9, day, hour).toISOString();

describe('todayLists', () => {
  it('splits open Today tasks into main and side, in the order they were planned', () => {
    const roots = buildTree([
      task({ id: 'b', today: 'main', todayAt: at(2, 10) }),
      task({ id: 'a', today: 'main', todayAt: at(2, 9) }),
      task({ id: 's', today: 'side', todayAt: at(1) }),
      task({ id: 'done', today: 'main', todayAt: at(2), status: 'done' }),
      task({ id: 'board' }),
    ]);
    const { main, side } = todayLists(roots, '2026-10-02');
    expect(main.map((t) => t.id)).toEqual(['a', 'b']);
    expect(side.map((t) => t.id)).toEqual(['s']);
  });
});

describe('carriedFrom', () => {
  it('names the day a task was planned, when that was before today', () => {
    expect(carriedFrom({ todayAt: at(2, 0) }, now)).toBeNull();
    expect(carriedFrom({ todayAt: at(1, 23) }, now)).toBe('yesterday');
    const monday = new Date(2026, 8, 28, 9);
    expect(carriedFrom({ todayAt: monday.toISOString() }, now)).toBe(monday.toLocaleDateString([], { weekday: 'long' }));
    const old = new Date(2026, 8, 10, 9);
    expect(carriedFrom({ todayAt: old.toISOString() }, now)).toBe(old.toLocaleDateString([], { day: 'numeric', month: 'short' }));
    expect(carriedFrom({ todayAt: null }, now)).toBeNull();
  });
});

describe('doneToday', () => {
  it('lists Today tasks finished since midnight, preferring the live copy', () => {
    const fromLog = task({ id: 'x', today: 'main', status: 'done', completedAt: at(2, 11) });
    const reopened = { ...fromLog, status: 'todo' as const, completedAt: null, updatedAt: at(2, 12) };
    const justNow = task({ id: 'y', today: 'side', status: 'done', completedAt: at(2, 14) });
    const yesterday = task({ id: 'z', today: 'side', status: 'done', completedAt: at(1, 14) });
    const notOnToday = task({ id: 'w', status: 'done', completedAt: at(2, 13) });
    expect(doneToday([justNow, notOnToday], [fromLog, yesterday], now).map((t) => t.id)).toEqual(['x', 'y']);
    expect(doneToday([reopened, justNow], [fromLog], now).map((t) => t.id)).toEqual(['y']);
  });
});

describe('minutesLeft', () => {
  it('adds up estimates', () => {
    expect(minutesLeft([task({ id: 'a', estimateMinutes: 30 }), task({ id: 'b' }), task({ id: 'c', estimateMinutes: 15 })])).toBe(45);
  });
});
