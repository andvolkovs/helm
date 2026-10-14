import type { ApiTokenRow, ProjectRow, TaskRow, TimerRow } from '@helm/db';
import type { ApiToken, Project, Task, Timer } from '@helm/shared';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    projectId: r.projectId,
    priority: r.priority,
    estimateMinutes: r.estimateMinutes,
    status: r.status,
    parentTaskId: r.parentTaskId,
    position: r.position,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    startedAt: iso(r.startedAt),
    completedAt: iso(r.completedAt),
    deletedAt: iso(r.deletedAt),
    agentState: r.agentState ?? null,
    agentClaimedBy: r.agentClaimedBy ?? null,
    today: r.today ?? null,
    todayAt: iso(r.todayAt),
    planDate: r.planDate ?? null,
    todayOnly: r.todayOnly,
    keyWords: r.keyWords ?? null,
  };
}

export function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    icon: r.icon ?? null,
    collapsed: r.collapsed,
    position: r.position,
    archivedAt: iso(r.archivedAt),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toApiToken(r: ApiTokenRow): ApiToken {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scope: r.scope,
    projectIds: r.projectIds ?? null,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: iso(r.lastUsedAt),
    expiresAt: iso(r.expiresAt),
    revokedAt: iso(r.revokedAt),
  };
}

export function toTimer(r: TimerRow): Timer {
  return {
    id: r.id,
    label: r.label,
    taskId: r.taskId,
    durationMs: r.durationMs,
    status: r.finishedAt ? 'finished' : r.endsAt ? 'running' : 'paused',
    endsAt: iso(r.finishedAt ?? r.endsAt),
    remainingMs: r.finishedAt ? null : r.remainingMs,
    ended: r.endedAt !== null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
