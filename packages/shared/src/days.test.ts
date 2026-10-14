import { describe, expect, it } from 'vitest';
import { addDays, dayKey, daysBetween, formatDay, isDayKey, planDayOf, shownDayOf, weekStart } from './days.ts';

describe('days', () => {
  it('reads the day in a time zone', () => {
    const late = new Date('2026-10-14T23:30:00.000Z');
    expect(dayKey(late, 'UTC')).toBe('2026-10-14');
    expect(dayKey(late, 'Pacific/Auckland')).toBe('2026-10-15');
    expect(dayKey(late, 'America/Los_Angeles')).toBe('2026-10-14');
  });

  it('counts days across months and clock changes', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(weekStart('2026-10-14')).toBe('2026-10-12');
    expect(weekStart('2026-10-18')).toBe('2026-10-12');
    expect(weekStart('2026-10-12')).toBe('2026-10-12');
  });

  it('checks for real days', () => {
    expect(isDayKey('2026-10-14')).toBe(true);
    expect(isDayKey('2026-02-30')).toBe(false);
    expect(isDayKey('2026-1-4')).toBe(false);
    expect(formatDay('2026-10-15', { weekday: 'long' }, 'en-GB')).toBe('Thursday');
  });

  it('finds where a planned task shows', () => {
    const t = { today: 'side' as const, todayAt: '2026-10-12T09:00:00.000Z', planDate: '2026-10-16' };
    expect(planDayOf(t)).toBe('2026-10-16');
    expect(shownDayOf(t, '2026-10-14')).toBe('2026-10-16');
    // Its day has passed: it carries over to today.
    expect(shownDayOf(t, '2026-10-18')).toBe('2026-10-18');
    // Planned before days existed: the day it went on Today.
    expect(planDayOf({ today: 'main', todayAt: '2026-10-12T09:00:00.000Z' }, 'UTC')).toBe('2026-10-12');
    expect(shownDayOf({ today: null, todayAt: null, planDate: null }, '2026-10-14')).toBeNull();
  });
});
