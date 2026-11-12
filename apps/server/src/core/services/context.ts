import { events, type Db, type EventRow, type Tx } from '@helm/db';
import type { ApiToken, EventEntity, HelmEvent, Project, Task, Timer } from '@helm/shared';
import { ulid } from 'ulidx';
import type { TaskRules } from '../../config.ts';
import { actorOf, type Principal } from '../auth/principal.ts';
import type { EventBus } from '../events/bus.ts';

export interface ServiceContext {
  db: Db;
  bus: EventBus;
  rules: TaskRules;
  now: () => Date;
  /** Days of activity history to keep and show; 0 or absent = all of it. */
  historyKeepDays?: number;
}

export interface EmitInput {
  entity: EventEntity;
  entityId: string;
  projectId: string | null;
  action: string;
  data: Task | Project | ApiToken | Timer;
}

export type Emit = (e: EmitInput) => void;

export function toHelmEvent(r: EventRow): HelmEvent {
  return {
    id: r.id,
    at: r.at.toISOString(),
    actor: r.actor,
    entity: r.entity,
    entityId: r.entityId,
    action: r.action,
    data: r.data as HelmEvent['data'],
  };
}

/**
 * Run a write in one transaction. Events emitted inside are stored in the same transaction
 * and published to the bus only after commit, so subscribers never see rolled-back changes.
 * They share a batch id, so the activity log shows (and undoes) them as one step.
 */
export function mutate<T>(
  ctx: ServiceContext,
  p: Principal,
  fn: (tx: Tx, emit: Emit) => T,
  o: { undoOf?: string } = {},
): T {
  const committed: HelmEvent[] = [];
  const batchId = ulid();
  const result = ctx.db.transaction((tx) => {
    const actor = actorOf(p);
    const emit: Emit = (e) => {
      const row = tx
        .insert(events)
        .values({ at: ctx.now(), actor, ...e, batchId, undoOf: o.undoOf ?? null })
        .returning()
        .get();
      committed.push(toHelmEvent(row));
    };
    return fn(tx, emit);
  });
  ctx.bus.publish(committed);
  return result;
}
