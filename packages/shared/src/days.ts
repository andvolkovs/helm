import type { TodaySlot } from './schemas.ts';

/** What says where a task is on the plan; a database row (dates as Date) also fits. */
export interface Planned {
  today: TodaySlot | null;
  todayAt: string | Date | null;
  planDate?: string | null;
}

/**
 * Calendar days as `YYYY-MM-DD` strings, in the user's own time zone. They sort as text, and the
 * arithmetic below runs on UTC noon so clock changes never shift a day.
 */

const formats = new Map<string, Intl.DateTimeFormat>();

/** The day `d` falls on in `timeZone` (default: this machine's zone). */
export function dayKey(d: Date, timeZone?: string): string {
  const k = timeZone ?? '';
  let f = formats.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formats.set(k, f);
  }
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const noon = (day: string) => new Date(`${day}T12:00:00Z`);

/** A real calendar day in `YYYY-MM-DD` form. */
export function isDayKey(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(noon(s).getTime()) && noon(s).toISOString().startsWith(s);
}

export function addDays(day: string, n: number): string {
  const d = noon(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export const daysBetween = (a: string, b: string) => Math.round((noon(b).getTime() - noon(a).getTime()) / 86_400_000);

/** The Monday of the week `day` is in. */
export function weekStart(day: string): string {
  return addDays(day, -((noon(day).getUTCDay() + 6) % 7));
}

/** Format a day without the time zone moving it: `{ weekday: 'short' }` → "Thu". */
export function formatDay(day: string, o: Intl.DateTimeFormatOptions, locale?: string | string[]): string {
  return noon(day).toLocaleDateString(locale, { ...o, timeZone: 'UTC' });
}

/** "Thu 15", in that order whatever the locale (some put the day first: "15 Thu"). */
export function shortDay(day: string, locale?: string | string[]): string {
  return `${formatDay(day, { weekday: 'short' }, locale)} ${formatDay(day, { day: 'numeric' }, locale)}`;
}

/** "12 – 18 October" (or "October 12 – 18"), as the locale writes a range of days. */
export function dayRange(first: string, last: string, locale?: string | string[]): string {
  const f = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' });
  return f.formatRange(new Date(`${first}T12:00:00Z`), new Date(`${last}T12:00:00Z`));
}

/**
 * The day a task is planned for, or null when it isn't on the plan. Tasks from before planning
 * ahead existed have no `planDate`: they belong to the day they went on Today.
 */
export function planDayOf(t: Planned, timeZone?: string): string | null {
  if (!t.today) return null;
  if (t.planDate) return t.planDate;
  return t.todayAt ? dayKey(new Date(t.todayAt), timeZone) : null;
}

/**
 * Where an open planned task shows: its own day, or today when that day has passed (it carries
 * over). Null when it isn't planned.
 */
export function shownDayOf(t: Planned, today: string, timeZone?: string): string | null {
  const day = planDayOf(t, timeZone);
  if (!t.today) return null;
  return !day || day < today ? today : day;
}
