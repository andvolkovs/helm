import type { Task } from '@helm/shared';
import { describe, expect, it } from 'vitest';
import { buildEntries, matchViews, searchOpen, searchWords } from './search-model.ts';

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

const ids = (ts: Task[]) => ts.map((t) => t.id);

describe('searchWords', () => {
  it('lowercases and splits on whitespace', () => {
    expect(searchWords('  Pay  the BILL ')).toEqual(['pay', 'the', 'bill']);
    expect(searchWords('   ')).toEqual([]);
  });
});

describe('searchOpen', () => {
  it('needs every word, in the title or the notes, in any case', () => {
    const tasks = [
      task({ id: 'a', title: 'Pay electric bill' }),
      task({ id: 'b', title: 'Call plumber', notes: 'About the electric meter' }),
      task({ id: 'c', title: 'Buy milk' }),
    ];
    expect(ids(searchOpen(tasks, 'ELECTRIC'))).toEqual(['a', 'b']);
    expect(ids(searchOpen(tasks, 'electric bill'))).toEqual(['a']);
    expect(ids(searchOpen(tasks, 'plumber meter'))).toEqual(['b']);
    expect(searchOpen(tasks, 'zebra')).toEqual([]);
    expect(searchOpen(tasks, '  ')).toEqual([]);
  });

  it('puts title matches before notes matches, then Now before Soon before Someday', () => {
    const tasks = [
      task({ id: 'notes-now', title: 'Other', notes: 'tax', priority: 'now' }),
      task({ id: 'title-someday', title: 'Tax ideas', priority: 'someday' }),
      task({ id: 'title-now', title: 'File tax', priority: 'now' }),
      task({ id: 'title-soon', title: 'Tax folder', priority: 'soon' }),
    ];
    expect(ids(searchOpen(tasks, 'tax'))).toEqual(['title-now', 'title-soon', 'title-someday', 'notes-now']);
  });

  it('keeps the given order among equals, skips done and deleted, finds subtasks, and caps the list', () => {
    const tasks = [
      task({ id: 'one', title: 'x one' }),
      task({ id: 'gone', title: 'x gone', deletedAt: '2026-10-02T00:00:00.000Z' }),
      task({ id: 'finished', title: 'x finished', status: 'done' }),
      task({ id: 'sub', title: 'x sub', parentTaskId: 'one' }),
      task({ id: 'two', title: 'x two' }),
    ];
    expect(ids(searchOpen(tasks, 'x'))).toEqual(['one', 'sub', 'two']);
    expect(ids(searchOpen(tasks, 'x', 2))).toEqual(['one', 'sub']);
  });
});

describe('matchViews and buildEntries', () => {
  const views = [
    { route: 'board' as const, label: 'Board', key: 'b' },
    { route: 'today' as const, label: 'Today', key: 't' },
    { route: 'week' as const, label: 'Week', key: 'w' },
  ];

  it('filters the view jumps by what was typed', () => {
    expect(matchViews(views, '')).toHaveLength(3);
    expect(matchViews(views, 'week').map((v) => v.route)).toEqual(['week']);
    expect(matchViews(views, 'go to tod').map((v) => v.route)).toEqual(['today']);
    expect(matchViews(views, 'go')).toHaveLength(3);
    expect(matchViews(views, 'zebra')).toEqual([]);
  });

  it('orders open, done, then actions, and lists a task once', () => {
    const open = [task({ id: 'a' })];
    const done = [task({ id: 'a', status: 'done' }), task({ id: 'd' })];
    const entries = buildEntries(open, done, views, 'week ');
    // "week" names a view outright: it comes first, so Enter goes there rather than making a task.
    expect(entries.map((e) => e.id)).toEqual(['view:week', 'open:a', 'done:d', 'new']);
    expect(buildEntries([], [], views, 'go to Today').map((e) => e.id)).toEqual(['view:today', 'new']);
    // Only part of a name: the jump stays with the actions.
    expect(buildEntries(open, [], views, 'wee').map((e) => e.id)).toEqual(['open:a', 'new', 'view:week']);
    expect(entries.find((e) => e.kind === 'new')).toMatchObject({ title: 'week' });
  });
});
