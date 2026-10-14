import type { Context } from 'hono';
import type { Principal } from '../core/auth/principal.ts';
import { invalid } from '../core/errors.ts';

export interface AppEnv {
  Variables: {
    principal: Principal;
  };
}

/** Read a JSON body; empty body = {}. */
export async function jsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw invalid('Body must be valid JSON');
  }
}

/**
 * The user's time zone, sent by the app as `X-Time-Zone` (or `?tz=`), so "today" is their day.
 * undefined when missing or not a zone this server knows.
 */
export function timeZoneOf(c: Context): string | undefined {
  const tz = c.req.header('x-time-zone') || c.req.query('tz');
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}
