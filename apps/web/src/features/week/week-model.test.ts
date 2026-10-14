import { buildTree, type Task } from '@helm/shared';
import { describe, expect, it } from 'vitest';
import { donePlanned, loadText, placement, unplanned, weekDays, weekPlan, weekRange, weekTitle } from './week-model.ts';

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
    planDate: null,
    todayOnly: false,
    ...p,
  };
}

const today = '2026-10-14'; // a Wednesday
const days = weekDays(today);
const at = (day: number, hour = 9) => new Date(2026, 9, day, hour).toISOString();

describe('weekDays', () => {
  it('runs Monday to Sunday, and moves by weeks', () => {
    expect(days).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
    expect(weekDays(today, 1)[0]).toBe('2026-10-19');
    expect(weekTitle(0, days)).toBe('This week');
    expect(weekTitle(1, weekDays(today, 1))).toBe('Next week');
    expect(weekRange(days)).toMatch(/12\D+18|October/);
  });
});

describe('weekPlan', () => {
  const tasks = [
    task({ id: 'passport', today: 'main', planDate: '2026-10-13', todayAt: at(13), estimateMinutes: 45 }),
    task({ id: 'report', today: 'main', planDate: today, todayAt: at(14, 8), estimateMinutes: 90 }),
    task({ id: 'bank', today: 'side', planDate: today, todayAt: at(14, 9), estimateMinutes: 15 }),
    task({ id: 'slides', today: 'main', planDate: '2026-10-15', todayAt: at(14, 10), estimateMinutes: 120 }),
    task({ id: 'tulips', today: 'side', planDate: '2026-10-15', todayAt: at(14, 11) }),
    task({ id: 'flights', today: 'side', planDate: '2026-10-13', status: 'done', completedAt: at(13, 15) }),
    task({ id: 'board' }),
  ];
  const plan = weekPlan(buildTree(tasks), donePlanned(tasks, []), days, today);
  const day = (d: string) => plan.find((p) => p.day === d)!;

  it('puts open tasks on their day, and carries unfinished ones over to today', () => {
    expect(day(today).main.map((t) => t.id)).toEqual(['passport', 'report']);
    expect(day(today).side.map((t) => t.id)).toEqual(['bank']);
    expect(day('2026-10-15').main.map((t) => t.id)).toEqual(['slides']);
    expect(day('2026-10-15')).toMatchObject({ minutes: 120, unestimated: 1 });
  });

  it('shows on a past day what got done, and what moved on', () => {
    expect(day('2026-10-13')).toMatchObject({ past: true, movedOn: 1 });
    expect(day('2026-10-13').done.map((t) => t.id)).toEqual(['flights']);
    expect(day('2026-10-13').main).toEqual([]);
  });

  it('reads the load against the day budget', () => {
    expect(loadText(day('2026-10-15'), 60, (m) => `${m}m`)).toEqual({ text: '120m · 60m over', over: true });
    expect(loadText(day('2026-10-15'), 240, (m) => `${m}m`)).toEqual({ text: '120m · room for 120m', over: false });
    expect(loadText(day('2026-10-18'), 240, (m) => `${m}m`)).toEqual({ text: 'Free', over: false });
  });
});

describe('placement', () => {
  const carried = task({ id: 'c', today: 'main', planDate: '2026-10-13' });

  it('keeps a carried-over task’s own day when it moves within today', () => {
    expect(placement(carried, { day: today, slot: 'side' }, today)).toEqual({ today: 'side' });
    expect(placement(carried, { day: today, slot: 'main' }, today)).toBeNull();
  });

  it('sends the day when it changes, and keeps the slot when asked', () => {
    expect(placement(carried, { day: '2026-10-16', slot: 'keep' }, today)).toEqual({ today: 'main', planDate: '2026-10-16' });
    expect(placement(task({ id: 'new' }), { day: '2026-10-16', slot: 'keep' }, today)).toEqual({
      today: 'side',
      planDate: '2026-10-16',
    });
  });
});

describe('unplanned', () => {
  it('lists open board tasks with no day, Now first, without Today-only ones', () => {
    const roots = buildTree([
      task({ id: 'soon-a', position: 'a0' }),
      task({ id: 'now', priority: 'now', position: 'a1' }),
      task({ id: 'later', priority: 'someday', position: 'a2' }),
      task({ id: 'planned', today: 'side', planDate: today }),
      task({ id: 'done', status: 'done' }),
    ]);
    expect(unplanned(roots, new Set(['now', 'soon'])).map((t) => t.id)).toEqual(['now', 'soon-a']);
  });
});
