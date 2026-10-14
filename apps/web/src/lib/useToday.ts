import { dayKey } from '@helm/shared';
import { useNow } from './useNow.ts';

/** Today on this device, `YYYY-MM-DD`; changes at midnight (checked every minute). */
export function useToday(): string {
  return dayKey(new Date(useNow(60_000)));
}
