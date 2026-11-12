import { openDb } from '@helm/db';
import type { HelmEvent } from '@helm/shared';
import type { Config, TaskRules } from '../src/config.ts';
import type { Principal } from '../src/core/auth/principal.ts';
import { EventBus } from '../src/core/events/bus.ts';
import { createServices, type ServiceContext } from '../src/core/services/index.ts';

export function setup(rules: Partial<TaskRules> = {}) {
  const { db, close } = openDb({ path: ':memory:' });
  // Deterministic clock: each call advances one second.
  let t = Date.parse('2026-09-23T09:00:00.000Z');
  const clock = {
    now: () => new Date((t += 1000)),
    set: (iso: string) => {
      t = Date.parse(iso);
    },
  };
  const bus = new EventBus();
  const published: HelmEvent[] = [];
  bus.subscribe((e) => published.push(e));
  const ctx: ServiceContext = {
    db,
    bus,
    rules: { inProgressLimit: 1, maxSubtaskDepth: 1, ...rules },
    now: clock.now,
  };
  return { ctx, services: createServices(ctx), published, clock, close };
}

export const testConfig: Config = {
  port: 0,
  host: '127.0.0.1',
  dbPath: ':memory:',
  backups: { dir: '', keep: 0 },
  historyKeepDays: 0,
  ownerPassword: 'correct horse battery staple',
  sessionSecret: 'test-secret-test-secret-test-secret',
  cookieSecure: false,
  rules: { inProgressLimit: 1, maxSubtaskDepth: 1 },
  ai: { llm: { provider: 'none', model: '' }, stt: { provider: 'none', model: '' }, openai: {} },
};

export function token(p: Partial<Extract<Principal, { kind: 'token' }>> = {}): Principal {
  return { kind: 'token', tokenId: 't1', name: 'Claude Desktop', scope: 'read_write', projectIds: null, ...p };
}
