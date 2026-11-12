import { events } from '@helm/db';
import type { Task } from '@helm/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { OWNER } from '../src/core/auth/principal.ts';
import { setup, testConfig, token } from './helpers.ts';

const DAY = 86_400_000;
const agent = token({ name: 'Claude Code' });

/** Every page of the log, in order. */
function allPages(services: ReturnType<typeof setup>['services'], query: Record<string, string>) {
  const entries = [];
  let cursor: number | null | undefined;
  do {
    const page = services.activity.list(OWNER, { ...query, ...(cursor ? { cursor: String(cursor) } : {}) });
    entries.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor);
  return entries;
}

describe('activity log paging', () => {
  it('pages through every batch once, newest first, however many events a batch has', () => {
    const { services } = setup();
    for (let i = 0; i < 8; i++) {
      // Three events in one batch, then two more batches for the same task.
      const t = services.tasks.create(i % 3 === 0 ? agent : OWNER, { title: `Task ${i}`, subtasks: [{ title: 'a' }, { title: 'b' }] });
      services.tasks.setKeyWords(t.id, t.title, ['Task']);
      services.tasks.update(OWNER, t.id, { priority: 'now' });
      services.tasks.complete(OWNER, t.id);
    }
    const whole = services.activity.list(OWNER, { limit: '100' }).entries;
    expect(whole).toHaveLength(24);
    expect(whole[0]!.changes).toHaveLength(3); // the last complete: parent and two subtasks

    const paged = allPages(services, { limit: '5' });
    expect(paged.map((e) => e.batchId)).toEqual(whole.map((e) => e.batchId));
    expect(new Set(paged.map((e) => e.batchId)).size).toBe(24);

    const agents = allPages(services, { limit: '2', who: 'agents' });
    expect(agents.map((e) => e.actor)).toEqual(['token:Claude Code', 'token:Claude Code', 'token:Claude Code']);
  });

  it('shows one task’s history, a page at a time', () => {
    const { services } = setup();
    const t = services.tasks.create(OWNER, { title: 'Mine' });
    const other = services.tasks.create(OWNER, { title: 'Other' });
    for (const priority of ['now', 'someday', 'soon', 'now'] as const) {
      services.tasks.update(OWNER, t.id, { priority });
      services.tasks.update(OWNER, other.id, { priority });
    }
    const history = allPages(services, { limit: '2', taskId: t.id });
    expect(history).toHaveLength(5);
    expect(history.every((e) => e.changes.every((c) => c.entityId === t.id))).toBe(true);
    expect(history.map((e) => e.changes[0]!.action)).toEqual(['updated', 'updated', 'updated', 'updated', 'created']);
  });
});

describe('pruning the event log', () => {
  it('drops key-word, timer and token events after a week and keeps everything else', () => {
    const { services, ctx, clock } = setup();
    const t = services.tasks.create(OWNER, { title: 'Call the bank' });
    services.tasks.setKeyWords(t.id, t.title, ['bank']);
    services.timers.start(OWNER, { minutes: 5 });
    services.tokens.create(OWNER, { name: 'A', scope: 'read' });
    const count = () => ctx.db.select().from(events).all().length;
    expect(count()).toBe(4);

    expect(services.activity.prune()).toEqual({ removed: 0 });
    clock.set(new Date(ctx.now().getTime() + 8 * DAY).toISOString());
    expect(services.activity.prune()).toEqual({ removed: 3 });
    expect(ctx.db.select().from(events).all().map((e) => e.action)).toEqual(['created']);
    expect(services.settings.eventsPrunedThrough()).toBe(4);
    // Nothing the log shows has gone, and the task keeps its key words.
    expect(services.activity.list(OWNER, {}).entries).toHaveLength(1);
    expect(services.tasks.get(OWNER, t.id).keyWords).toEqual(['bank']);
  });

  it('with a history limit, keeps what later changes need to be shown and undone', () => {
    const { services, ctx, clock } = setup();
    const t = services.tasks.create(OWNER, { title: 'Old title' });
    services.tasks.update(OWNER, t.id, { priority: 'now' });
    const untouched = services.tasks.create(OWNER, { title: 'Left alone' });

    clock.set(new Date(ctx.now().getTime() + 40 * DAY).toISOString());
    services.tasks.update(OWNER, t.id, { title: 'New title' });

    ctx.historyKeepDays = 30;
    // The first task's creation goes; its last old state stays, as does the other task's only event.
    expect(services.activity.prune()).toEqual({ removed: 1 });

    const { entries } = services.activity.list(OWNER, {});
    expect(entries).toHaveLength(1);
    expect((entries[0]!.changes[0]!.before as Task).title).toBe('Old title');
    expect(entries[0]!.cantUndo).toBeNull();

    services.activity.undo(OWNER, entries[0]!.batchId);
    expect(services.tasks.get(OWNER, t.id)).toMatchObject({ title: 'Old title', priority: 'now' });
    // Tasks themselves are never touched.
    expect(services.tasks.get(OWNER, untouched.id).title).toBe('Left alone');
  });

  it('makes an app that was away since before the prune take a fresh snapshot', async () => {
    const env = setup();
    const app = await createApp({ config: testConfig, ctx: env.ctx, services: env.services });
    const t = env.services.tasks.create(OWNER, { title: 'Call the bank' });
    env.services.tasks.setKeyWords(t.id, t.title, ['bank']);
    env.clock.set(new Date(env.ctx.now().getTime() + 8 * DAY).toISOString());
    env.services.activity.prune();

    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: testConfig.ownerPassword }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const first = async (since: number) => {
      const res = await app.request(`/api/v1/events?since=${since}`, { headers: { cookie } });
      const reader = res.body!.getReader();
      // A stream with nothing to say stays silent until its next ping: don't wait for that.
      const { value } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined }>((r) => setTimeout(() => r({ value: undefined }), 300)),
      ]);
      await reader.cancel();
      return value ? new TextDecoder().decode(value) : '';
    };
    // Event 2 (the key words) was pruned: a stream at 1 has a gap, one at 2 doesn't.
    expect(await first(1)).toContain('event: reset');
    expect(await first(2)).not.toContain('event: reset');
  });
});
