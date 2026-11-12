import { describe, expect, it } from 'vitest';
import type { Task } from './schemas.ts';
import { buildTree, byPosition, progressOf } from './tree.ts';

function task(over: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    title: over.id,
    notes: null,
    projectId: null,
    priority: 'now',
    estimateMinutes: null,
    status: 'todo',
    parentTaskId: null,
    position: 'a0',
    source: 'manual',
    createdAt: '2026-09-23T09:00:00.000Z',
    updatedAt: '2026-09-23T09:00:00.000Z',
    startedAt: null,
    completedAt: null,
    deletedAt: null,
    agentState: null,
    agentClaimedBy: null,
    today: null,
    todayAt: null,
    todayOnly: false,
    ...over,
  };
}

describe('byPosition', () => {
  it('orders by position with plain string comparison', () => {
    // localeCompare would put 'B' before 'a'; fractional-index keys need code-unit order.
    expect(byPosition({ id: 'x', position: 'B' }, { id: 'y', position: 'a' })).toBe(-1);
    expect(byPosition({ id: 'x', position: 'a1' }, { id: 'y', position: 'a0' })).toBe(1);
  });

  it('breaks ties by id', () => {
    expect(byPosition({ id: 'a', position: 'a0' }, { id: 'b', position: 'a0' })).toBe(-1);
    expect(byPosition({ id: 'b', position: 'a0' }, { id: 'a', position: 'a0' })).toBe(1);
    expect(byPosition({ id: 'a', position: 'a0' }, { id: 'a', position: 'a0' })).toBe(0);
  });
});

describe('progressOf', () => {
  it('is null without subtasks', () => {
    expect(progressOf([])).toBeNull();
  });

  it('counts done subtasks', () => {
    const subs = [task({ id: '1', status: 'done' }), task({ id: '2' }), task({ id: '3', status: 'done' })];
    expect(progressOf(subs)).toEqual({ done: 2, total: 3 });
  });
});

describe('buildTree', () => {
  it('nests subtasks under their parent, both ordered by position', () => {
    const tree = buildTree([
      task({ id: 'p2', position: 'a2' }),
      task({ id: 's2', parentTaskId: 'p1', position: 'a1' }),
      task({ id: 'p1', position: 'a1' }),
      task({ id: 's1', parentTaskId: 'p1', position: 'a0', status: 'done' }),
    ]);
    expect(tree.map((n) => n.id)).toEqual(['p1', 'p2']);
    expect(tree[0]!.subtasks.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(tree[0]!.progress).toEqual({ done: 1, total: 2 });
    expect(tree[1]!.subtasks).toEqual([]);
    expect(tree[1]!.progress).toBeNull();
  });

  it('drops deleted tasks, and their subtasks become top-level', () => {
    const tree = buildTree([
      task({ id: 'p1', deletedAt: '2026-09-23T10:00:00.000Z' }),
      task({ id: 's1', parentTaskId: 'p1', position: 'a1' }),
      task({ id: 'p2', position: 'a2' }),
    ]);
    expect(tree.map((n) => n.id)).toEqual(['s1', 'p2']);
  });

  it('treats a subtask with a missing parent as top-level', () => {
    const tree = buildTree([task({ id: 's1', parentTaskId: 'gone' })]);
    expect(tree.map((n) => n.id)).toEqual(['s1']);
  });

  it('returns an empty list for no tasks', () => {
    expect(buildTree([])).toEqual([]);
  });
});
