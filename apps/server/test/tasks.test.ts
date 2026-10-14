import { describe, expect, it } from 'vitest';
import { OWNER } from '../src/core/auth/principal.ts';
import { HelmError } from '../src/core/errors.ts';
import { setup, token } from './helpers.ts';

const o = OWNER;

function errCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof HelmError) return e.code;
    throw e;
  }
  throw new Error('expected an error');
}

describe('TaskService.create', () => {
  it('applies defaults and appends in order', () => {
    const { services } = setup();
    const a = services.tasks.create(o, { title: '  Write spec ' });
    const b = services.tasks.create(o, { title: 'Review' });
    expect(a).toMatchObject({ title: 'Write spec', priority: 'soon', status: 'todo', source: 'manual', projectId: null });
    expect(a.position < b.position).toBe(true);
  });

  it('validates input', () => {
    const { services } = setup();
    expect(errCode(() => services.tasks.create(o, { title: '' }))).toBe('invalid');
    expect(errCode(() => services.tasks.create(o, { title: 'x', priority: 'urgent' }))).toBe('invalid');
    expect(errCode(() => services.tasks.create(o, { title: 'x', source: 'robot' }))).toBe('invalid');
    expect(errCode(() => services.tasks.create(o, { title: 'x', projectId: 'nope' }))).toBe('not_found');
  });

  it('subtasks inherit project and priority, and respect max depth', () => {
    const { services } = setup();
    const proj = services.projects.create(o, { name: 'Work' });
    const parent = services.tasks.create(o, { title: 'Parent', projectId: proj.id, priority: 'now' });
    const child = services.tasks.create(o, { title: 'Child', parentTaskId: parent.id });
    expect(child).toMatchObject({ projectId: proj.id, priority: 'now', parentTaskId: parent.id });
    expect(errCode(() => services.tasks.create(o, { title: 'Grandchild', parentTaskId: child.id }))).toBe('invalid');
  });

  it('creates subtasks in the same call, in order', () => {
    const { services } = setup();
    const p = services.tasks.create(o, {
      title: 'Trip',
      priority: 'now',
      subtasks: [{ title: 'Book train' }, { title: 'Pack', estimateMinutes: 20 }],
    });
    const subs = services.tasks.board(o).filter((t) => t.parentTaskId === p.id);
    expect(subs.map((s) => s.title)).toEqual(['Book train', 'Pack']);
    expect(subs[1]).toMatchObject({ priority: 'now', estimateMinutes: 20 });
  });

  it('rejects inline subtasks that would exceed max depth, creating nothing', () => {
    const { services } = setup();
    const p = services.tasks.create(o, { title: 'P' });
    expect(errCode(() => services.tasks.create(o, { title: 'c', parentTaskId: p.id, subtasks: [{ title: 'gc' }] }))).toBe(
      'invalid',
    );
    expect(services.tasks.board(o)).toHaveLength(1);
  });

  it('adding a subtask to a done parent reopens it', () => {
    const { services } = setup();
    const parent = services.tasks.create(o, { title: 'Parent' });
    services.tasks.complete(o, parent.id);
    services.tasks.create(o, { title: 'More work', parentTaskId: parent.id });
    expect(services.tasks.get(o, parent.id).status).toBe('todo');
  });
});

describe('status rules', () => {
  it('starting a task moves the previous in-progress task back to todo (limit 1)', () => {
    const { services, published } = setup();
    const a = services.tasks.create(o, { title: 'A' });
    const b = services.tasks.create(o, { title: 'B' });
    services.tasks.start(o, a.id);
    services.tasks.start(o, b.id);
    expect(services.tasks.get(o, a.id)).toMatchObject({ status: 'todo', startedAt: null });
    expect(services.tasks.get(o, b.id).status).toBe('in_progress');
    expect(published.map((e) => `${e.action}:${e.entityId === a.id ? 'A' : 'B'}`)).toEqual([
      'created:A',
      'created:B',
      'started:A',
      'stopped:A',
      'started:B',
    ]);
  });

  it('limit 0 allows many in progress', () => {
    const { services } = setup({ inProgressLimit: 0 });
    const a = services.tasks.create(o, { title: 'A' });
    const b = services.tasks.create(o, { title: 'B' });
    services.tasks.start(o, a.id);
    services.tasks.start(o, b.id);
    expect(services.tasks.board(o).filter((t) => t.status === 'in_progress')).toHaveLength(2);
  });

  it('completing a parent completes open subtasks; reopening a subtask reopens the parent', () => {
    const { services } = setup();
    const p = services.tasks.create(o, { title: 'P' });
    const c1 = services.tasks.create(o, { title: 'c1', parentTaskId: p.id });
    const c2 = services.tasks.create(o, { title: 'c2', parentTaskId: p.id });
    services.tasks.complete(o, c1.id);
    services.tasks.complete(o, p.id);
    expect(services.tasks.get(o, c2.id).status).toBe('done');
    expect(services.tasks.get(o, p.id).completedAt).not.toBeNull();

    services.tasks.reopen(o, c2.id);
    expect(services.tasks.get(o, p.id)).toMatchObject({ status: 'todo', completedAt: null });
  });

  it('status can also be set via update', () => {
    const { services } = setup();
    const a = services.tasks.create(o, { title: 'A' });
    expect(services.tasks.update(o, a.id, { status: 'done' }).status).toBe('done');
  });
});

describe('update / move / remove', () => {
  it('moving a parent to another project moves its subtasks; subtasks cannot move alone', () => {
    const { services } = setup();
    const work = services.projects.create(o, { name: 'Work' });
    const p = services.tasks.create(o, { title: 'P' });
    const c = services.tasks.create(o, { title: 'c', parentTaskId: p.id });
    services.tasks.update(o, p.id, { projectId: work.id });
    expect(services.tasks.get(o, c.id).projectId).toBe(work.id);
    expect(errCode(() => services.tasks.update(o, c.id, { projectId: null }))).toBe('invalid');
  });

  it('rejects unknown fields', () => {
    const { services } = setup();
    const a = services.tasks.create(o, { title: 'A' });
    expect(errCode(() => services.tasks.update(o, a.id, { parentTaskId: 'x' }))).toBe('invalid');
  });

  it('reorders with afterId / beforeId', () => {
    const { services } = setup();
    const [a, b, c] = ['A', 'B', 'C'].map((title) => services.tasks.create(o, { title }));
    const order = () => services.tasks.board(o).map((t) => t.title).join('');

    services.tasks.move(o, c!.id, { afterId: a!.id });
    expect(order()).toBe('ACB');
    services.tasks.move(o, b!.id, { beforeId: a!.id });
    expect(order()).toBe('BAC');
    services.tasks.move(o, b!.id, { afterId: a!.id, beforeId: c!.id });
    expect(order()).toBe('ABC');
    expect(errCode(() => services.tasks.move(o, a!.id, { afterId: a!.id }))).toBe('invalid');
  });

  it('moves between bins and priorities in one call', () => {
    const { services, published } = setup();
    const home = services.projects.create(o, { name: 'Home' });
    const a = services.tasks.create(o, { title: 'A' });
    const moved = services.tasks.move(o, a.id, { projectId: home.id, priority: 'now' });
    expect(moved).toMatchObject({ projectId: home.id, priority: 'now' });
    expect(published.at(-1)?.action).toBe('moved');
  });

  it('soft-deletes with subtasks', () => {
    const { services } = setup();
    const p = services.tasks.create(o, { title: 'P' });
    services.tasks.create(o, { title: 'c', parentTaskId: p.id });
    services.tasks.remove(o, p.id);
    expect(services.tasks.board(o)).toEqual([]);
    expect(errCode(() => services.tasks.get(o, p.id))).toBe('not_found');
  });

  it('restores a deleted task with the subtasks deleted along with it', () => {
    const { services } = setup();
    const p = services.tasks.create(o, { title: 'P' });
    const gone = services.tasks.create(o, { title: 'deleted earlier', parentTaskId: p.id });
    services.tasks.remove(o, gone.id);
    services.tasks.create(o, { title: 'c', parentTaskId: p.id });
    services.tasks.remove(o, p.id);
    expect(services.tasks.restore(o, p.id).deletedAt).toBeNull();
    expect(services.tasks.board(o).map((t) => t.title).sort()).toEqual(['P', 'c']);
    expect(errCode(() => services.tasks.restore(o, 'nope'))).toBe('not_found');
  });

  it('won’t restore a subtask whose parent is deleted', () => {
    const { services } = setup();
    const p = services.tasks.create(o, { title: 'P' });
    const c = services.tasks.create(o, { title: 'c', parentTaskId: p.id });
    services.tasks.remove(o, c.id);
    services.tasks.remove(o, p.id);
    expect(errCode(() => services.tasks.restore(o, c.id))).toBe('not_found');
  });
});

describe('reads', () => {
  it('board keeps done subtasks of open parents (for progress) but drops done top-level tasks', () => {
    const { services } = setup();
    const p = services.tasks.create(o, { title: 'P' });
    const c = services.tasks.create(o, { title: 'c', parentTaskId: p.id });
    const done = services.tasks.create(o, { title: 'Done' });
    services.tasks.complete(o, c.id);
    services.tasks.complete(o, done.id);
    // Parent and child share a position (different scopes), so their order isn't defined.
    expect(services.tasks.board(o).map((t) => t.title).sort()).toEqual(['P', 'c']);
  });

  it('focus returns current and up next', () => {
    const { services } = setup();
    const a = services.tasks.create(o, { title: 'A', priority: 'now' });
    const b = services.tasks.create(o, { title: 'B', priority: 'now' });
    services.tasks.start(o, b.id);
    const f = services.tasks.focus(o);
    expect(f.current?.id).toBe(b.id);
    expect(f.upNext?.id).toBe(a.id);
  });

  it('done log filters by project and date range, newest first', () => {
    const { services, clock } = setup();
    const work = services.projects.create(o, { name: 'Work' });
    const a = services.tasks.create(o, { title: 'A', projectId: work.id });
    const b = services.tasks.create(o, { title: 'B' });
    const c = services.tasks.create(o, { title: 'C', projectId: work.id });
    clock.set('2026-09-20T12:00:00.000Z');
    services.tasks.complete(o, a.id);
    clock.set('2026-09-22T12:00:00.000Z');
    services.tasks.complete(o, b.id);
    services.tasks.complete(o, c.id);

    const titles = (q: object) => services.tasks.doneLog(o, q).tasks.map((t) => t.title);
    expect(titles({})).toEqual(['C', 'B', 'A']);
    expect(titles({ projectId: work.id })).toEqual(['C', 'A']);
    expect(titles({ projectId: 'inbox' })).toEqual(['B']);
    expect(titles({ from: '2026-09-21T00:00:00.000Z' })).toEqual(['C', 'B']);
    expect(titles({ to: '2026-09-21T00:00:00.000Z' })).toEqual(['A']);
  });

  it('done log pages with a cursor without losing tasks completed at the same moment', () => {
    const { services, clock } = setup();
    const parent = services.tasks.create(o, {
      title: 'P',
      subtasks: [{ title: 's1' }, { title: 's2' }, { title: 's3' }],
    });
    const solo = services.tasks.create(o, { title: 'Solo' });
    clock.set('2026-09-20T12:00:00.000Z');
    services.tasks.complete(o, solo.id);
    clock.set('2026-09-22T12:00:00.000Z');
    services.tasks.complete(o, parent.id); // parent + 3 subtasks share one timestamp

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = services.tasks.doneLog(o, { includeSubtasks: 'true', limit: '2', cursor });
      seen.push(...page.tasks.map((t) => t.title));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);

    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(['P', 's1', 's2', 's3', 'Solo']));
    expect(seen.at(-1)).toBe('Solo');
    expect(pages).toBe(3);
    expect(errCode(() => services.tasks.doneLog(o, { cursor: 'nope' }))).toBe('invalid');
  });

  it('archived projects drop off the board', () => {
    const { services } = setup();
    const work = services.projects.create(o, { name: 'Work' });
    services.tasks.create(o, { title: 'A', projectId: work.id });
    services.projects.archive(o, work.id);
    expect(services.tasks.board(o)).toEqual([]);
    expect(services.projects.list(o)).toEqual([]);
    expect(services.projects.list(o, { includeArchived: 'true' }).map((p) => p.name)).toEqual(['Work']);
  });

  it('deleting a project deletes its tasks, open and done', () => {
    const { services } = setup();
    const work = services.projects.create(o, { name: 'Work' });
    const home = services.projects.create(o, { name: 'Home' });
    const parent = services.tasks.create(o, { title: 'A', projectId: work.id });
    services.tasks.create(o, { title: 'A1', parentTaskId: parent.id });
    const done = services.tasks.create(o, { title: 'B', projectId: work.id });
    services.tasks.complete(o, done.id);
    services.tasks.create(o, { title: 'C', projectId: home.id });

    services.projects.remove(o, work.id);
    expect(services.projects.list(o, { includeArchived: 'true' }).map((p) => p.name)).toEqual(['Home']);
    expect(services.tasks.board(o).map((t) => t.title)).toEqual(['C']);
    expect(services.tasks.doneLog(o, { includeSubtasks: 'true' }).tasks).toEqual([]);
    expect(errCode(() => services.projects.remove(o, work.id))).toBe('not_found');
    expect(errCode(() => services.projects.remove(token({ scope: 'read_write', projectIds: [home.id] }), home.id))).toBe(
      'forbidden',
    );
  });
});

describe('token scopes', () => {
  it('read-only tokens cannot write', () => {
    const { services } = setup();
    const ro = token({ scope: 'read' });
    services.tasks.create(o, { title: 'A' });
    expect(services.tasks.board(ro)).toHaveLength(1);
    expect(errCode(() => services.tasks.create(ro, { title: 'B' }))).toBe('forbidden');
  });

  it('project-scoped tokens only see and write their projects (not the Inbox)', () => {
    const { services } = setup();
    const work = services.projects.create(o, { name: 'Work' });
    const home = services.projects.create(o, { name: 'Home' });
    services.tasks.create(o, { title: 'inbox' });
    const homeTask = services.tasks.create(o, { title: 'home', projectId: home.id });
    services.tasks.create(o, { title: 'work', projectId: work.id });

    const scoped = token({ projectIds: [work.id] });
    expect(services.tasks.board(scoped).map((t) => t.title)).toEqual(['work']);
    expect(services.projects.list(scoped).map((p) => p.name)).toEqual(['Work']);
    expect(errCode(() => services.tasks.get(scoped, homeTask.id))).toBe('forbidden');
    expect(errCode(() => services.tasks.create(scoped, { title: 'x' }))).toBe('forbidden');
    expect(errCode(() => services.projects.create(scoped, { name: 'New' }))).toBe('forbidden');
    expect(services.tasks.create(scoped, { title: 'ok', projectId: work.id }).source).toBe('ai:claude-desktop');
  });

  it('tokens may pass their own ai:<agent> source but not manual', () => {
    const { services } = setup();
    expect(services.tasks.create(token(), { title: 'x', source: 'ai:planner' }).source).toBe('ai:planner');
    expect(services.tasks.create(token(), { title: 'y', source: 'manual' }).source).toBe('ai:claude-desktop');
  });
});

describe('events', () => {
  it('records the actor and publishes nothing when a write fails', () => {
    const { services, published } = setup();
    services.tasks.create(token(), { title: 'A' });
    expect(published[0]).toMatchObject({ actor: 'token:Claude Desktop', entity: 'task', action: 'created' });

    const before = published.length;
    expect(errCode(() => services.tasks.create(o, { title: 'x', parentTaskId: 'missing' }))).toBe('not_found');
    expect(published.length).toBe(before);
  });
});

describe('project icons', () => {
  it('stores an emoji, and null lets the app choose', () => {
    const { services } = setup();
    const plain = services.projects.create(o, { name: 'Work' });
    expect(plain.icon).toBeNull();
    const garden = services.projects.create(o, { name: 'Garden', icon: '🌱' });
    expect(garden.icon).toBe('🌱');
    expect(services.projects.update(o, garden.id, { icon: '🏡' }).icon).toBe('🏡');
    expect(services.projects.update(o, garden.id, { icon: null }).icon).toBeNull();
    expect(() => services.projects.update(o, garden.id, { icon: 'a'.repeat(17) })).toThrow();
  });
});

describe('Today', () => {
  it('puts tasks on Today and moves them between main and side, keeping the day planned', () => {
    const { services } = setup();
    const a = services.tasks.create(o, { title: 'Budget', today: 'main' });
    expect(a).toMatchObject({ today: 'main', todayOnly: false });
    expect(a.todayAt).not.toBeNull();

    const side = services.tasks.update(o, a.id, { today: 'side' });
    expect(side).toMatchObject({ today: 'side', todayAt: a.todayAt });
    const off = services.tasks.update(o, a.id, { today: null });
    expect(off).toMatchObject({ today: null, todayAt: null });
    expect(services.tasks.update(o, a.id, { today: 'side' }).todayAt! > a.todayAt!).toBe(true);
  });

  it('allows three open main tasks; done ones make room', () => {
    const { services } = setup();
    const main = [1, 2, 3].map((n) => services.tasks.create(o, { title: `Main ${n}`, today: 'main' }));
    expect(errCode(() => services.tasks.create(o, { title: 'Fourth', today: 'main' }))).toBe('conflict');
    const side = services.tasks.create(o, { title: 'Side', today: 'side' });
    expect(errCode(() => services.tasks.update(o, side.id, { today: 'main' }))).toBe('conflict');

    services.tasks.complete(o, main[0]!.id);
    expect(services.tasks.update(o, side.id, { today: 'main' }).today).toBe('main');
    // Done tasks stay on Today, for "Done today".
    expect(services.tasks.get(o, main[0]!.id).today).toBe('main');
  });

  it('keeps Today-only tasks off the board until they leave Today', () => {
    const { services } = setup();
    expect(errCode(() => services.tasks.create(o, { title: 'Parcel', todayOnly: true }))).toBe('invalid');
    const t = services.tasks.create(o, { title: 'Parcel', today: 'side', todayOnly: true });
    expect(t.todayOnly).toBe(true);
    expect(services.tasks.update(o, t.id, { today: null })).toMatchObject({ today: null, todayOnly: false });
  });

  it('is for open top-level tasks only', () => {
    const { services } = setup();
    const parent = services.tasks.create(o, { title: 'Parent' });
    expect(errCode(() => services.tasks.create(o, { title: 'Sub', parentTaskId: parent.id, today: 'side' }))).toBe('invalid');
    const sub = services.tasks.create(o, { title: 'Sub', parentTaskId: parent.id });
    expect(errCode(() => services.tasks.update(o, sub.id, { today: 'side' }))).toBe('invalid');
    services.tasks.complete(o, parent.id);
    expect(errCode(() => services.tasks.update(o, parent.id, { today: 'side' }))).toBe('invalid');
  });

  it('undo puts a task back where it was on Today', () => {
    const { services } = setup();
    const t = services.tasks.create(o, { title: 'Budget', today: 'main' });
    services.tasks.update(o, t.id, { today: null });
    const [latest] = services.activity.list(o, {}).entries;
    services.activity.undo(o, latest!.batchId);
    expect(services.tasks.get(o, t.id)).toMatchObject({ today: 'main', todayAt: t.todayAt });
  });
});

describe('Planning days ahead', () => {
  // The test clock starts on 23 September 2026, 09:00 UTC.
  const utc = { timeZone: 'UTC' };

  it('plans a task for a later day, as Secondary unless it says Main', () => {
    const { services } = setup();
    const a = services.tasks.create(o, { title: 'Slides', planDate: '2026-09-25' }, utc);
    expect(a).toMatchObject({ today: 'side', planDate: '2026-09-25' });
    const b = services.tasks.create(o, { title: 'Gate', today: 'main', planDate: '2026-09-25' }, utc);
    expect(b).toMatchObject({ today: 'main', planDate: '2026-09-25' });
    // No day given: today, in the user's own zone.
    expect(services.tasks.create(o, { title: 'Now', today: 'side' }, utc).planDate).toBe('2026-09-23');
    expect(errCode(() => services.tasks.create(o, { title: 'x', planDate: '2026-02-30' }, utc))).toBe('invalid');
  });

  it('counts today in the user’s time zone', () => {
    const { services, clock } = setup();
    clock.set('2026-09-23T23:30:00.000Z');
    const late = services.tasks.create(o, { title: 'Late', today: 'side' }, { timeZone: 'Pacific/Auckland' });
    expect(late.planDate).toBe('2026-09-24');
  });

  it('allows three main tasks per day; carried-over ones count for today', () => {
    const { services } = setup();
    const main = (title: string, planDate?: string) => services.tasks.create(o, { title, today: 'main', planDate }, utc);
    for (const n of [1, 2, 3]) main(`Fri ${n}`, '2026-09-25');
    expect(errCode(() => main('Fri 4', '2026-09-25'))).toBe('conflict');
    expect(main('Sat', '2026-09-26').today).toBe('main');

    main('Monday’s', '2026-09-21');
    main('Tuesday’s', '2026-09-22');
    main('Today’s');
    expect(errCode(() => main('One more'))).toBe('conflict');
  });

  it('moves tasks between days, keeping the slot, and checks room in Main there', () => {
    const { services } = setup();
    const t = services.tasks.create(o, { title: 'Invoice', today: 'main', planDate: '2026-09-24' }, utc);
    const moved = services.tasks.update(o, t.id, { planDate: '2026-09-25' }, utc);
    expect(moved).toMatchObject({ today: 'main', planDate: '2026-09-25' });
    expect(moved.todayAt! > t.todayAt!).toBe(true);

    for (const n of [1, 2, 3]) services.tasks.create(o, { title: `Sat ${n}`, today: 'main', planDate: '2026-09-26' }, utc);
    expect(errCode(() => services.tasks.update(o, t.id, { planDate: '2026-09-26' }, utc))).toBe('conflict');
    expect(services.tasks.update(o, t.id, { today: 'side', planDate: '2026-09-26' }, utc)).toMatchObject({
      today: 'side',
      planDate: '2026-09-26',
    });

    // A day for a task that wasn't planned puts it on as Secondary.
    const loose = services.tasks.create(o, { title: 'Loose' }, utc);
    expect(services.tasks.update(o, loose.id, { planDate: '2026-09-27' }, utc)).toMatchObject({
      today: 'side',
      planDate: '2026-09-27',
    });
    expect(services.tasks.update(o, loose.id, { today: null }, utc)).toMatchObject({
      today: null,
      planDate: null,
      todayAt: null,
    });
  });

  it('keeps a carried-over task’s day when it moves between main and side', () => {
    const { services } = setup();
    const t = services.tasks.create(o, { title: 'Passport', today: 'main', planDate: '2026-09-22' }, utc);
    expect(services.tasks.update(o, t.id, { today: 'side' }, utc)).toMatchObject({
      today: 'side',
      planDate: '2026-09-22',
      todayAt: t.todayAt,
    });
  });

  it('leaves main tasks planned for later out of Focus', () => {
    const { services } = setup();
    services.tasks.create(o, { title: 'Friday', today: 'main', planDate: '2026-09-25', priority: 'someday' }, utc);
    const today = services.tasks.create(o, { title: 'Today', today: 'main', priority: 'someday' }, utc);
    const f = services.tasks.focus(o, utc);
    expect(f.upNext?.id).toBe(today.id);
    expect(f.now).toEqual([]);
  });

  it('undo puts a task back on the day it was planned for', () => {
    const { services } = setup();
    const t = services.tasks.create(o, { title: 'Budget', planDate: '2026-09-24' }, utc);
    services.tasks.update(o, t.id, { planDate: '2026-09-26' }, utc);
    const [latest] = services.activity.list(o, {}).entries;
    services.activity.undo(o, latest!.batchId);
    expect(services.tasks.get(o, t.id)).toMatchObject({ today: 'side', planDate: '2026-09-24' });
  });
});
