import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { OWNER } from '../src/core/auth/principal.ts';
import { HelmError } from '../src/core/errors.ts';
import { setup, testConfig, token } from './helpers.ts';

const errCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof HelmError ? e.code : 'other';
  }
  return 'none';
};

const agent = token({ name: 'Claude Code' });

async function makeApp(config = testConfig, env = setup()) {
  const app = await createApp({
    config,
    ctx: env.ctx,
    services: env.services,
    resolveToken: (t) => (t === 'agent-token' ? agent : null),
  });
  return { ...env, app };
}

async function login(app: Awaited<ReturnType<typeof makeApp>>['app'], password = testConfig.ownerPassword) {
  const res = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

describe('what agents can’t do', () => {
  it('never deletes: tasks, projects, archiving and restoring are the owner’s', () => {
    const { services } = setup();
    const project = services.projects.create(OWNER, { name: 'Work' });
    const task = services.tasks.create(OWNER, { title: 'Keep me', projectId: project.id });

    expect(errCode(() => services.tasks.remove(agent, task.id))).toBe('forbidden');
    expect(errCode(() => services.projects.archive(agent, project.id))).toBe('forbidden');
    expect(errCode(() => services.projects.remove(agent, project.id))).toBe('forbidden');
    expect(services.tasks.board(OWNER).map((t) => t.title)).toEqual(['Keep me']);

    services.tasks.remove(OWNER, task.id);
    expect(errCode(() => services.tasks.restore(agent, task.id))).toBe('forbidden');
  });

  it('refuses the same over REST', async () => {
    const { app, services } = await makeApp();
    const project = services.projects.create(OWNER, { name: 'Work' });
    const task = services.tasks.create(OWNER, { title: 'Keep me', projectId: project.id });
    const headers = { authorization: 'Bearer agent-token' };

    expect((await app.request(`/api/v1/tasks/${task.id}`, { method: 'DELETE', headers })).status).toBe(403);
    expect((await app.request(`/api/v1/projects/${project.id}`, { method: 'DELETE', headers })).status).toBe(403);
    expect((await app.request(`/api/v1/projects/${project.id}?permanent=true`, { method: 'DELETE', headers })).status).toBe(403);
    expect(services.projects.list(OWNER)).toHaveLength(1);
  });

  it('can’t complete handed-off work by any route', () => {
    const { services } = setup();
    // Marked for agents but not yet claimed.
    const ready = services.tasks.create(OWNER, { title: 'Ready', agentState: 'ready' });
    expect(errCode(() => services.tasks.complete(agent, ready.id))).toBe('forbidden');

    // Claimed: clearing the hand-off first, in the same request or an earlier one, doesn't help.
    services.tasks.setAgentState(agent, ready.id, { state: 'working' });
    expect(errCode(() => services.tasks.update(agent, ready.id, { agentState: null, status: 'done' }))).toBe('forbidden');
    expect(errCode(() => services.tasks.setAgentState(agent, ready.id, { state: null }))).toBe('forbidden');
    expect(errCode(() => services.tasks.update(agent, ready.id, { agentState: null }))).toBe('forbidden');
    expect(services.tasks.get(OWNER, ready.id)).toMatchObject({ status: 'todo', agentState: 'working' });

    // Completing a parent would complete its handed-off subtask.
    const parent = services.tasks.create(OWNER, { title: 'Parent' });
    const child = services.tasks.create(OWNER, { title: 'Child', parentTaskId: parent.id });
    services.tasks.setAgentState(OWNER, child.id, { state: 'ready' });
    expect(errCode(() => services.tasks.complete(agent, parent.id))).toBe('forbidden');

    // Ordinary tasks are still theirs to finish, and the owner finishes anything.
    const plain = services.tasks.create(OWNER, { title: 'Plain' });
    expect(services.tasks.complete(agent, plain.id).status).toBe('done');
    expect(services.tasks.complete(OWNER, ready.id).status).toBe('done');
  });
});

describe('subtasks deeper than one level', () => {
  it('are deleted, restored and moved with the task they hang under', () => {
    const { services } = setup({ maxSubtaskDepth: 2 });
    const home = services.projects.create(OWNER, { name: 'Home' });
    const top = services.tasks.create(OWNER, { title: 'Top' });
    const mid = services.tasks.create(OWNER, { title: 'Mid', parentTaskId: top.id });
    const leaf = services.tasks.create(OWNER, { title: 'Leaf', parentTaskId: mid.id });

    services.tasks.update(OWNER, top.id, { projectId: home.id });
    expect(services.tasks.get(OWNER, leaf.id).projectId).toBe(home.id);

    services.tasks.remove(OWNER, top.id);
    expect(services.tasks.board(OWNER)).toEqual([]);
    services.tasks.restore(OWNER, top.id);
    expect(services.tasks.board(OWNER).map((t) => t.title).sort()).toEqual(['Leaf', 'Mid', 'Top']);
  });
});

describe('undo', () => {
  it('keeps to the in-progress limit', () => {
    const { services } = setup();
    const a = services.tasks.create(OWNER, { title: 'A' });
    const b = services.tasks.create(OWNER, { title: 'B' });
    services.tasks.start(OWNER, a.id);
    services.tasks.stop(OWNER, a.id);
    services.tasks.start(OWNER, b.id);

    const stopped = services.activity
      .list(OWNER, {})
      .entries.find((e) => e.changes.some((c) => c.entityId === a.id && c.action === 'stopped'))!;
    services.activity.undo(OWNER, stopped.batchId);

    const inProgress = services.tasks.board(OWNER).filter((t) => t.status === 'in_progress');
    expect(inProgress.map((t) => t.title)).toEqual(['A']);
  });
});

describe('sessions', () => {
  it('sign out everywhere ends every session issued before it', async () => {
    const { app } = await makeApp();
    const phone = await login(app);
    const laptop = await login(app);
    expect((await app.request('/api/v1/tasks', { headers: { cookie: phone } })).status).toBe(200);

    const out = await app.request('/api/v1/auth/logout-all', { method: 'POST', headers: { cookie: laptop, 'content-type': 'application/json' } });
    expect(out.status).toBe(200);
    expect((await app.request('/api/v1/tasks', { headers: { cookie: phone } })).status).toBe(401);
    expect((await app.request('/api/v1/tasks', { headers: { cookie: laptop } })).status).toBe(401);
    expect((await app.request('/api/v1/auth/logout-all', { method: 'POST', headers: { 'content-type': 'application/json' } })).status).toBe(401);

    await new Promise((r) => setTimeout(r, 5));
    const again = await login(app);
    expect((await app.request('/api/v1/tasks', { headers: { cookie: again } })).status).toBe(200);
  });

  it('a new owner password ends sessions from the old one', async () => {
    const env = setup();
    const before = await makeApp(testConfig, env);
    const cookie = await login(before.app);

    // Restarted with the same password: still signed in.
    const same = await makeApp(testConfig, env);
    expect((await same.app.request('/api/v1/tasks', { headers: { cookie } })).status).toBe(200);

    const changed = { ...testConfig, ownerPassword: 'a different long password' };
    const after = await makeApp(changed, env);
    expect((await after.app.request('/api/v1/tasks', { headers: { cookie } })).status).toBe(401);
  });
});

describe('http hardening', () => {
  it('sends headers that keep other sites’ scripts and frames out', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/health');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // Not over plain HTTP.
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('refuses oversized request bodies, before signing in too', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'x'.repeat(3 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it('doesn’t let a made-up X-Forwarded-For dodge the login brake', async () => {
    const { app } = await makeApp();
    const guess = (n: number) =>
      app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${n}` },
        body: JSON.stringify({ password: 'nope' }),
      });
    for (let n = 0; n < 10; n++) expect((await guess(n)).status).toBe(401);
    expect((await guess(99)).status).toBe(429);
  });
});

describe('the owner’s day for agents', () => {
  it('plans “today” in the zone the owner’s app last reported, not the server’s', async () => {
    const { app, services, clock } = await makeApp();
    const cookie = await login(app);
    // The owner's app is far east: 11:00 UTC on the 23rd is already the 24th there.
    await app.request('/api/v1/tasks', { headers: { cookie, 'x-time-zone': 'Pacific/Kiritimati' } });
    expect(services.settings.ownerZone()).toBe('Pacific/Kiritimati');

    clock.set('2026-09-23T11:00:00.000Z');
    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: { authorization: 'Bearer agent-token', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'From an agent', today: 'side' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ planDate: '2026-09-24' });
  });
});
