import type { TokenScope } from '@helm/shared';
import { forbidden } from '../errors.ts';

export type { TokenScope };

/** Who is making a request. Every service call takes one. */
export type Principal =
  /** `via`: the owner accepted a change an agent proposed (e.g. the assistant panel). */
  | { kind: 'owner'; via?: string }
  | {
      kind: 'token';
      tokenId: string;
      name: string;
      scope: TokenScope;
      /** null = all projects (incl. Inbox); otherwise only these projects. */
      projectIds: string[] | null;
      /** When the token stops working; open live streams end then. */
      expiresAt?: Date | null;
    };

export const OWNER: Principal = { kind: 'owner' };
/** Changes from the assistant panel: owner rights, recorded as the assistant's. */
export const ASSISTANT: Principal = { kind: 'owner', via: 'assistant' };

/** Recorded on every event, e.g. `owner`, `ai:assistant` or `token:claude-desktop`. */
export function actorOf(p: Principal): string {
  if (p.kind === 'owner') return p.via ? `ai:${p.via}` : 'owner';
  return `token:${p.name}`;
}

/** Whether the principal can see tasks in a project (null = Inbox). */
export function canRead(p: Principal, projectId: string | null): boolean {
  if (p.kind === 'owner' || p.projectIds === null) return true;
  return projectId !== null && p.projectIds.includes(projectId);
}

export function canWrite(p: Principal, projectId: string | null): boolean {
  if (p.kind === 'owner') return true;
  return p.scope === 'read_write' && canRead(p, projectId);
}

export function assertRead(p: Principal, projectId: string | null): void {
  if (!canRead(p, projectId)) throw forbidden('Token has no access to this project');
}

export function assertWrite(p: Principal, projectId: string | null): void {
  if (!canRead(p, projectId)) throw forbidden('Token has no access to this project');
  if (!canWrite(p, projectId)) throw forbidden('Token is read-only');
}

/** Creating/reordering projects needs owner or an unscoped read-write token. */
export function assertGlobalWrite(p: Principal): void {
  if (p.kind === 'owner') return;
  if (p.scope !== 'read_write' || p.projectIds !== null) throw forbidden('Token cannot manage projects');
}

export function assertOwner(p: Principal): void {
  if (p.kind !== 'owner') throw forbidden('Owner only');
}

/** Project ids a scoped principal is limited to, or null when unrestricted. */
export function projectScope(p: Principal): string[] | null {
  return p.kind === 'owner' ? null : p.projectIds;
}
