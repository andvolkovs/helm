import { Hono } from 'hono';
import type { Services } from '../core/services/index.ts';
import { jsonBody, timeZoneOf, type AppEnv } from './env.ts';

/** REST API v1. All routes require a principal (see `authenticate`). */
export function apiRoutes(s: Services): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // ----- Tasks -----
  r.get('/tasks', (c) => c.json(s.tasks.board(c.var.principal)));
  r.get('/tasks/:id', (c) => c.json(s.tasks.get(c.var.principal, c.req.param('id'))));
  r.post('/tasks', async (c) =>
    c.json(s.tasks.create(c.var.principal, await jsonBody(c), { timeZone: timeZoneOf(c) }), 201),
  );
  r.patch('/tasks/:id', async (c) =>
    c.json(s.tasks.update(c.var.principal, c.req.param('id'), await jsonBody(c), { timeZone: timeZoneOf(c) })),
  );
  r.delete('/tasks/:id', (c) => c.json(s.tasks.remove(c.var.principal, c.req.param('id'))));
  r.post('/tasks/:id/move', async (c) => c.json(s.tasks.move(c.var.principal, c.req.param('id'), await jsonBody(c))));
  r.post('/tasks/arrange', async (c) => c.json(s.tasks.arrange(c.var.principal, await jsonBody(c))));
  for (const action of ['start', 'stop', 'complete', 'reopen', 'restore'] as const) {
    r.post(`/tasks/:id/${action}`, (c) => c.json(s.tasks[action](c.var.principal, c.req.param('id'))));
  }
  r.post('/tasks/:id/notes', async (c) =>
    c.json(s.tasks.appendNote(c.var.principal, c.req.param('id'), await jsonBody(c))),
  );
  r.post('/tasks/:id/agent', async (c) =>
    c.json(s.tasks.setAgentState(c.var.principal, c.req.param('id'), await jsonBody(c))),
  );

  r.get('/focus', (c) => c.json(s.tasks.focus(c.var.principal, { timeZone: timeZoneOf(c) })));
  r.get('/done', (c) => c.json(s.tasks.doneLog(c.var.principal, c.req.query())));

  // ----- Projects -----
  r.get('/projects', (c) => c.json(s.projects.list(c.var.principal, c.req.query())));
  r.get('/projects/:id', (c) => c.json(s.projects.get(c.var.principal, c.req.param('id'))));
  r.post('/projects', async (c) => c.json(s.projects.create(c.var.principal, await jsonBody(c)), 201));
  r.patch('/projects/:id', async (c) =>
    c.json(s.projects.update(c.var.principal, c.req.param('id'), await jsonBody(c))),
  );
  r.post('/projects/:id/move', async (c) =>
    c.json(s.projects.move(c.var.principal, c.req.param('id'), await jsonBody(c))),
  );
  // DELETE archives (kept for existing clients); ?permanent=true deletes the project and its tasks.
  r.delete('/projects/:id', (c) =>
    c.json(
      c.req.query('permanent') === 'true'
        ? s.projects.remove(c.var.principal, c.req.param('id'))
        : s.projects.archive(c.var.principal, c.req.param('id')),
    ),
  );

  // ----- Activity (owner only) -----
  r.get('/activity', (c) => c.json(s.activity.list(c.var.principal, c.req.query())));
  r.post('/activity/:batch/undo', (c) => c.json(s.activity.undo(c.var.principal, c.req.param('batch'))));

  // ----- API tokens (owner only) -----
  r.get('/tokens', (c) => c.json(s.tokens.list(c.var.principal)));
  r.post('/tokens', async (c) => c.json(s.tokens.create(c.var.principal, await jsonBody(c)), 201));
  r.delete('/tokens/:id', (c) => c.json(s.tokens.revoke(c.var.principal, c.req.param('id'))));

  return r;
}
