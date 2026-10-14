import { ProviderError } from '@helm/providers';
import {
  ApplyChangesInput,
  AssistantChatInput,
  type ApplyResult,
  type AssistantChange,
  type AssistantStatus,
  type ChatStreamEvent,
} from '@helm/shared';
import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import { ASSISTANT, assertOwner, type Principal } from '../../core/auth/principal.ts';
import { HelmError, parse } from '../../core/errors.ts';
import type { Services } from '../../core/services/index.ts';
import { timeZoneOf, type AppEnv } from '../../http/env.ts';
import type { HelmModule } from '../module.ts';
import { chatReply } from './chat.ts';
import { suggestOrder } from './prioritize.ts';
import { buildSnapshot, today } from './snapshot.ts';

const DAY = 24 * 60 * 60 * 1000;

function snapshotFor(services: Services, p: Principal, now: Date, timeZone?: string) {
  return buildSnapshot(
    services.tasks.board(p),
    services.projects.list(p),
    services.tasks.doneLog(p, { from: new Date(now.getTime() - 7 * DAY).toISOString(), limit: 30 }).tasks,
    now,
    timeZone,
  );
}

function applyOne(services: Services, change: AssistantChange): void {
  const p = ASSISTANT;
  switch (change.action) {
    case 'create': {
      const { action: _a, subtasks, ...fields } = change;
      services.tasks.create(p, { ...fields, subtasks: subtasks?.map((title) => ({ title })) });
      return;
    }
    case 'update': {
      const { action: _a, taskId, ...fields } = change;
      services.tasks.update(p, taskId, fields);
      return;
    }
    case 'arrange':
      services.tasks.arrange(p, { items: change.items });
      return;
    default:
      services.tasks[change.action](p, change.taskId);
  }
}

/**
 * The assistant panel: a suggested working order and a chat about the board. The model only
 * proposes; changes happen when the owner applies them, and are recorded as `ai:assistant`.
 * Owner only: it spends the owner's AI credit, and agents with tokens have their own models.
 */
export const assistantModule: HelmModule = {
  name: 'assistant',
  register({ api, services, providers, config }) {
    const { llm } = providers;
    const inProgressLimit = config.rules.inProgressLimit;
    const needLlm = () => {
      if (!llm) throw new HelmError('unavailable', providers.reasons.llm ?? 'The assistant is off.');
      return llm;
    };
    const tz = (c: Context<AppEnv>) => timeZoneOf(c);

    api.get('/assistant', (c) => {
      assertOwner(c.var.principal);
      const status: AssistantStatus = llm ? { available: true } : { available: false, reason: providers.reasons.llm };
      return c.json(status);
    });

    api.post('/assistant/prioritize', async (c) => {
      const p = c.var.principal;
      assertOwner(p);
      const model = needLlm();
      const now = new Date();
      try {
        return c.json(
          await suggestOrder(model, snapshotFor(services, p, now, tz(c)), {
            today: today(now, tz(c)),
            inProgressLimit,
            signal: c.req.raw.signal,
          }),
        );
      } catch (e) {
        if (e instanceof ProviderError) throw new HelmError('upstream', e.message);
        throw e;
      }
    });

    api.post('/assistant/chat', async (c) => {
      const p = c.var.principal;
      assertOwner(p);
      const model = needLlm();
      const { messages } = parse(AssistantChatInput, await c.req.json().catch(() => null));
      if (messages.at(-1)?.role !== 'user') throw new HelmError('invalid', 'The last message must be from the user.');
      const now = new Date();
      const snapshot = snapshotFor(services, p, now, tz(c));

      c.header('content-type', 'application/x-ndjson; charset=utf-8');
      c.header('cache-control', 'no-cache');
      return stream(c, async (s) => {
        const ctrl = new AbortController();
        s.onAbort(() => ctrl.abort());
        const send = (e: ChatStreamEvent) => s.write(JSON.stringify(e) + '\n');
        try {
          for await (const e of chatReply(model, messages, snapshot, {
            today: today(now, tz(c)),
            inProgressLimit,
            signal: ctrl.signal,
          })) {
            await send(e);
          }
          await send({ type: 'done' });
        } catch (e) {
          if (ctrl.signal.aborted) return;
          const message = e instanceof ProviderError ? e.message : 'The assistant stopped unexpectedly. Try again.';
          if (!(e instanceof ProviderError)) console.error(e);
          await send({ type: 'error', message });
        }
      });
    });

    api.post('/assistant/apply', async (c) => {
      assertOwner(c.var.principal);
      const { changes } = parse(ApplyChangesInput, await c.req.json().catch(() => null));
      const results: ApplyResult['results'] = changes.map((change) => {
        try {
          applyOne(services, change);
          return { ok: true };
        } catch (e) {
          if (e instanceof HelmError) return { ok: false, error: e.message };
          throw e;
        }
      });
      return c.json({ results } satisfies ApplyResult);
    });
  },
};
