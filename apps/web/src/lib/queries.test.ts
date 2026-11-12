import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { refetchAfterInFlight } from './queries.ts';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A query on screen (as `useTasks` is), counting its requests. */
function mounted(qc: QueryClient, ms: number) {
  const seen = { calls: 0 };
  const observer = new QueryObserver(qc, {
    queryKey: ['tasks'],
    queryFn: async () => {
      const n = ++seen.calls;
      await tick(ms);
      return n;
    },
    staleTime: Infinity,
  });
  const stop = observer.subscribe(() => {});
  return { seen, stop };
}

describe('refetchAfterInFlight', () => {
  it('fetches once more after the request in flight, however many events arrive meanwhile', async () => {
    const qc = new QueryClient();
    const { seen, stop } = mounted(qc, 30);
    expect(qc.isFetching({ queryKey: ['tasks'] })).toBe(1);

    // A burst of live events while the snapshot is on its way.
    for (let i = 0; i < 20; i++) refetchAfterInFlight(qc, ['tasks']);
    await tick(150);

    // The snapshot, then one more to be sure it isn't older than the events. Not twenty.
    expect(seen.calls).toBe(2);
    expect(qc.getQueryData(['tasks'])).toBe(2);
    stop();
  });

  it('does nothing when no request is in flight', async () => {
    const qc = new QueryClient();
    const { seen, stop } = mounted(qc, 1);
    await tick(30);
    refetchAfterInFlight(qc, ['tasks']);
    await tick(30);
    expect(seen.calls).toBe(1);
    stop();
  });
});
