import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { OWNER, type Principal } from '../core/auth/principal.ts';
import { HelmError, parse } from '../core/errors.ts';
import type { SettingsService } from '../core/services/settings.service.ts';
import { jsonBody, type AppEnv } from './env.ts';

const COOKIE = 'helm_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Resolves `Authorization: Bearer <token>` to a principal. Plugged in by the tokens step. */
export type TokenResolver = (token: string) => Principal | null;

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

function passwordMatches(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

/** Stored so a changed password can sign every device out; keyed, so it says nothing about the password. */
export function passwordFingerprint(config: Config): string {
  return createHmac('sha256', config.sessionSecret).update(config.ownerPassword).digest('hex');
}

async function hasValidSession(c: Context, config: Config, settings: SettingsService): Promise<boolean> {
  const value = await getSignedCookie(c, config.sessionSecret, COOKIE);
  if (typeof value !== 'string') return false;
  const m = /^v1\.(\d+)$/.exec(value);
  if (!m) return false;
  const issuedAt = Number(m[1]);
  return Date.now() - issuedAt < SESSION_TTL_MS && settings.sessionIsLive(issuedAt);
}

/** Sets `principal` from a session cookie or bearer token; 401 otherwise. */
export function authenticate(
  config: Config,
  resolveToken: TokenResolver,
  settings: SettingsService,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (header?.toLowerCase().startsWith('bearer ')) {
      const principal = resolveToken(header.slice(7).trim());
      if (!principal) throw new HelmError('unauthorized', 'Invalid or revoked token');
      c.set('principal', principal);
      return next();
    }
    if (await hasValidSession(c, config, settings)) {
      c.set('principal', OWNER);
      return next();
    }
    throw new HelmError('unauthorized', 'Not signed in');
  };
}

/** Very small in-memory brute-force brake for the owner password. */
class LoginLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  /** Forget windows that have run out, so the map stays small whatever is thrown at it. */
  private prune(now: number): void {
    if (this.attempts.size < 500) return;
    for (const [key, a] of this.attempts) if (a.resetAt < now) this.attempts.delete(key);
  }

  blocked(key: string): boolean {
    const a = this.attempts.get(key);
    if (!a || a.resetAt < Date.now()) return false;
    return a.count >= this.max;
  }

  fail(key: string): void {
    const now = Date.now();
    this.prune(now);
    const a = this.attempts.get(key);
    if (!a || a.resetAt < now) this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    else a.count++;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Who is knocking, for the login brake: the address of the connection itself, which a client
 * can't choose. `X-Forwarded-For` is believed only when the connection comes from this machine
 * (a proxy such as `tailscale serve`), and then only its last entry: the one the proxy wrote,
 * not whatever the client sent ahead of it.
 */
export function clientKey(c: Context): string {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    // No socket (tests calling the app directly).
  }
  if (!peer) return 'local';
  if (!LOOPBACK.has(peer)) return peer;
  const hops = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return hops.at(-1) ?? peer;
}

/** Public auth routes: login / logout / me. Mounted before `authenticate`. */
export function authRoutes(config: Config, settings: SettingsService): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const limiter = new LoginLimiter();
  // A ceiling on wrong guesses from everywhere at once, however many addresses they come from.
  const overall = new LoginLimiter(100);
  const ALL = '*';

  r.post('/login', async (c) => {
    const key = clientKey(c);
    if (limiter.blocked(key) || overall.blocked(ALL)) {
      return c.json({ error: { code: 'rate_limited', message: 'Too many attempts. Try again later.' } }, 429);
    }
    const { password } = parse(z.object({ password: z.string() }), await jsonBody(c));
    if (!passwordMatches(password, config.ownerPassword)) {
      limiter.fail(key);
      overall.fail(ALL);
      throw new HelmError('unauthorized', 'Wrong password');
    }
    limiter.reset(key);
    await setSignedCookie(c, COOKIE, `v1.${Date.now()}`, config.sessionSecret, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.json({ ok: true });
  });

  r.post('/logout', (c) => {
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  /** Sign out everywhere: every session cookie issued so far stops working, this one included. */
  r.post('/logout-all', async (c) => {
    if (!(await hasValidSession(c, config, settings))) throw new HelmError('unauthorized', 'Not signed in');
    settings.revokeSessions();
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  r.get('/me', async (c) => c.json({ signedIn: await hasValidSession(c, config, settings) }));

  return r;
}
