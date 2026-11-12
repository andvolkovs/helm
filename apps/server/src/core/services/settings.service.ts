import { eq } from 'drizzle-orm';
import { settings } from '@helm/db';
import type { ServiceContext } from './context.ts';

const TIME_ZONE = 'owner_time_zone';
const SESSIONS_VALID_FROM = 'sessions_valid_from';
const PASSWORD_FINGERPRINT = 'owner_password_fingerprint';
const EVENTS_PRUNED_THROUGH = 'events_pruned_through';

/** Small values that must survive restarts: the owner's time zone and which sessions still count. */
export class SettingsService {
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly ctx: ServiceContext) {}

  private get(key: string): string | null {
    if (!this.cache.has(key)) {
      const row = this.ctx.db.select().from(settings).where(eq(settings.key, key)).get();
      this.cache.set(key, row?.value ?? null);
    }
    return this.cache.get(key) ?? null;
  }

  private set(key: string, value: string): void {
    this.ctx.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
    this.cache.set(key, value);
  }

  // ---------- The owner's time zone ----------

  /**
   * The zone the owner's app last reported. Agents send none, so "today" for them is the
   * owner's day rather than the server's (a container runs in UTC). undefined until the app
   * has been opened once.
   */
  ownerZone(): string | undefined {
    return this.get(TIME_ZONE) ?? undefined;
  }

  rememberOwnerZone(timeZone: string): void {
    if (this.get(TIME_ZONE) !== timeZone) this.set(TIME_ZONE, timeZone);
  }

  // ---------- Event log ----------

  /** The highest event id ever pruned. A live stream resuming from below it has a gap: it refetches. */
  eventsPrunedThrough(): number {
    return Number(this.get(EVENTS_PRUNED_THROUGH) ?? 0);
  }

  notePruned(throughId: number): void {
    if (throughId > this.eventsPrunedThrough()) this.set(EVENTS_PRUNED_THROUGH, String(throughId));
  }

  // ---------- Sessions ----------

  /** A session cookie issued at `issuedAt` (ms) is still good unless everything was signed out since. */
  sessionIsLive(issuedAt: number): boolean {
    return issuedAt >= Number(this.get(SESSIONS_VALID_FROM) ?? 0);
  }

  /** Sign out every device: cookies issued up to now stop working. */
  revokeSessions(): void {
    this.set(SESSIONS_VALID_FROM, String(Date.now() + 1));
  }

  /**
   * Called at start with a fingerprint of the owner password. A changed password signs every
   * device out, so a leaked cookie dies with the old password.
   */
  syncPassword(fingerprint: string): void {
    const stored = this.get(PASSWORD_FINGERPRINT);
    if (stored === fingerprint) return;
    if (stored !== null) this.revokeSessions();
    this.set(PASSWORD_FINGERPRINT, fingerprint);
  }
}
