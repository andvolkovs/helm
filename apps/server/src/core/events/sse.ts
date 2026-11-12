import { asc, gt, max } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { events, type Db } from '@helm/db';
import type { HelmEvent, Task } from '@helm/shared';
import type { AppEnv } from '../../http/env.ts';
import { canRead, type Principal } from '../auth/principal.ts';
import { toHelmEvent } from '../services/context.ts';
import type { EventBus } from './bus.ts';

/** More missed events than this and the client is told to refetch instead of replaying. */
const MAX_REPLAY = 500;
const PING_MS = 25_000;

function visibleTo(p: Principal, e: HelmEvent): boolean {
  if (e.entity === 'token' || e.entity === 'timer') return p.kind === 'owner';
  const projectId = e.entity === 'task' ? (e.data as Task).projectId : e.entityId;
  return canRead(p, projectId);
}

/** A stream opened with a token ends as soon as that token is revoked. */
function revokes(p: Principal, e: HelmEvent): boolean {
  return p.kind === 'token' && e.entity === 'token' && e.action === 'revoked' && e.entityId === p.tokenId;
}

/**
 * GET /events: server-sent change stream.
 * - `Last-Event-ID` header (sent automatically by EventSource on reconnect) or `?since=<id>`
 *   replays missed events from the events table.
 * - Without a cursor, a `ready` event carries the current cursor.
 * - `reset` means the client is too far behind and should refetch everything.
 */
export function eventRoutes(db: Db, bus: EventBus, prunedThrough: () => number = () => 0): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/events', (c) => {
    const p = c.var.principal;
    const since = Number.parseInt(c.req.header('last-event-id') ?? c.req.query('since') ?? '', 10);

    return streamSSE(c, async (stream) => {
      const queue: HelmEvent[] = [];
      let wake = () => {};
      let closed = false;
      // Subscribe before reading the head so nothing falls in the gap; duplicates are skipped by id.
      const unsubscribe = bus.subscribe((e) => {
        queue.push(e);
        wake();
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        wake();
      });

      const head = db.select({ v: max(events.id) }).from(events).get()?.v ?? 0;
      let cursor = 0;

      const send = async (e: HelmEvent) => {
        if (e.id <= cursor) return;
        cursor = e.id;
        if (revokes(p, e)) {
          closed = true;
          unsubscribe();
          return;
        }
        if (!visibleTo(p, e)) return;
        await stream.writeSSE({ id: String(e.id), event: 'change', data: JSON.stringify(e) });
      };

      if (Number.isFinite(since) && since >= 0) {
        const backlog = db
          .select()
          .from(events)
          .where(gt(events.id, since))
          .orderBy(asc(events.id))
          .limit(MAX_REPLAY + 1)
          .all();
        // Too far behind, or some of what was missed has been pruned since.
        if (backlog.length > MAX_REPLAY || since < prunedThrough()) {
          cursor = head;
          await stream.writeSSE({ id: String(head), event: 'reset', data: JSON.stringify({ cursor: head }) });
        } else {
          for (const row of backlog) await send(toHelmEvent(row));
          cursor = Math.max(cursor, since);
        }
      } else {
        cursor = head;
        await stream.writeSSE({ id: String(head), event: 'ready', data: JSON.stringify({ cursor: head }) });
      }

      const expired = () => p.kind === 'token' && !!p.expiresAt && p.expiresAt.getTime() <= Date.now();

      while (!closed) {
        // Checked at least every ping: a stream doesn't outlive its token.
        if (expired()) break;
        while (queue.length > 0 && !closed) await send(queue.shift()!);
        if (closed) break;
        const woke = await Promise.race([
          new Promise<boolean>((resolve) => (wake = () => resolve(true))),
          stream.sleep(PING_MS).then(() => false),
        ]);
        if (!woke && !closed) await stream.writeSSE({ event: 'ping', data: '' });
      }
      unsubscribe();
    });
  });

  return r;
}
