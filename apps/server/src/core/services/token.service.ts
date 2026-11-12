import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { apiTokens } from '@helm/db';
import { CreateTokenInput, type ApiToken, type CreatedToken } from '@helm/shared';
import { ulid } from 'ulidx';
import { assertOwner, type Principal } from '../auth/principal.ts';
import { HelmError, notFound, parse } from '../errors.ts';
import { mutate, type ServiceContext } from './context.ts';
import { toApiToken } from './mappers.ts';
import { getLiveProject } from './project.service.ts';

const SECRET_PREFIX = 'helm_';
const SECRET_FORMAT = /^helm_[A-Za-z0-9_-]{43}$/;
/** Characters of the secret kept in clear, to tell tokens apart in the UI. */
const SHOWN_CHARS = 12;
/** Don't write `last_used_at` on every request. */
const LAST_USED_RESOLUTION_MS = 60_000;

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * API tokens for agents and scripts. Only the owner manages them. A token's secret is
 * 256 random bits, returned once at creation; only its SHA-256 is stored.
 */
export class TokenService {
  constructor(private readonly ctx: ServiceContext) {}

  list(p: Principal): ApiToken[] {
    assertOwner(p);
    return this.ctx.db.select().from(apiTokens).orderBy(desc(apiTokens.createdAt)).all().map(toApiToken);
  }

  create(p: Principal, input: unknown): CreatedToken {
    assertOwner(p);
    const i = parse(CreateTokenInput, input);
    return mutate(this.ctx, p, (tx, emit) => {
      // The name is how events and task sources attribute an agent's work, so keep it unambiguous.
      const clash = tx
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(and(eq(apiTokens.name, i.name), isNull(apiTokens.revokedAt)))
        .get();
      if (clash) throw new HelmError('conflict', `An active token is already called "${i.name}"`);
      const projectIds = i.projectIds ? [...new Set(i.projectIds)] : null;
      for (const id of projectIds ?? []) getLiveProject(tx, id);

      const secret = SECRET_PREFIX + randomBytes(32).toString('base64url');
      const now = this.ctx.now();
      const row = tx
        .insert(apiTokens)
        .values({
          id: ulid(),
          name: i.name,
          prefix: secret.slice(0, SHOWN_CHARS),
          tokenHash: hashSecret(secret),
          scope: i.scope,
          projectIds,
          createdAt: now,
          expiresAt: i.expiresInDays ? new Date(now.getTime() + i.expiresInDays * 86_400_000) : null,
        })
        .returning()
        .get();
      const token = toApiToken(row);
      emit({ entity: 'token', entityId: row.id, projectId: null, action: 'created', data: token });
      return { token, secret };
    });
  }

  /** Revoking is final; open live streams using the token are closed. */
  revoke(p: Principal, id: string): ApiToken {
    assertOwner(p);
    return mutate(this.ctx, p, (tx, emit) => {
      const row = tx.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
      if (!row) throw notFound('Token');
      if (row.revokedAt) return toApiToken(row);
      const updated = tx
        .update(apiTokens)
        .set({ revokedAt: this.ctx.now() })
        .where(eq(apiTokens.id, id))
        .returning()
        .get();
      const token = toApiToken(updated);
      emit({ entity: 'token', entityId: id, projectId: null, action: 'revoked', data: token });
      return token;
    });
  }

  /** Bearer secret → principal, or null if unknown, revoked or expired. */
  resolve(secret: string): Principal | null {
    if (!SECRET_FORMAT.test(secret)) return null;
    const row = this.ctx.db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hashSecret(secret))).get();
    const now = this.ctx.now();
    if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= now)) return null;
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
      this.ctx.db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id)).run();
    }
    return { kind: 'token', tokenId: row.id, name: row.name, scope: row.scope, projectIds: row.projectIds ?? null, expiresAt: row.expiresAt };
  }
}
