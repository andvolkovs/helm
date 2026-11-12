import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ApiToken, HelmEvent, Project, Task, Timer } from '@helm/shared';
import { keys, refetchAfterInFlight, refreshActivity, removeProject, setTimer, upsertProject, upsertTask, upsertToken } from './queries.ts';

export type SyncState = 'connecting' | 'live' | 'offline';

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;
/** How long EventSource may keep retrying before we call it offline rather than connecting. */
const GRACE_MS = 10_000;

/**
 * Keeps the query cache in step with the server over SSE. EventSource retries dropped
 * connections itself and resends Last-Event-ID, so missed events are replayed by the server.
 * It gives up for good on an HTTP error (server down behind a proxy, expired session), so
 * we then reopen it ourselves with backoff, and straight away when the device comes back online.
 */
export function useLiveSync(enabled: boolean): SyncState {
  const qc = useQueryClient();
  const [state, setState] = useState<SyncState>(() => (navigator.onLine ? 'connecting' : 'offline'));

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = RETRY_MIN_MS;
    let downSince: number | null = null;

    const refetchAll = () => {
      void qc.invalidateQueries({ queryKey: keys.tasks });
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: keys.done });
      void qc.invalidateQueries({ queryKey: keys.timer });
      void qc.invalidateQueries({ queryKey: keys.activity });
    };

    const onChange = (msg: MessageEvent<string>) => {
      const e = JSON.parse(msg.data) as HelmEvent;
      if (e.entity === 'task') {
        const task = e.data as Task;
        // A task reopened from the log returns to the board without its done subtasks; take a snapshot.
        const returning = e.action === 'reopened' && !qc.getQueryData<Task[]>(keys.tasks)?.some((t) => t.id === task.id);
        upsertTask(qc, task);
        if (returning) void qc.invalidateQueries({ queryKey: keys.tasks });
      } else if (e.entity === 'project') {
        if (e.action === 'deleted') removeProject(qc, e.entityId);
        else upsertProject(qc, e.data as Project);
        // Unarchived (undo): its tasks weren't in the board snapshot.
        if (e.action === 'restored') void qc.invalidateQueries({ queryKey: keys.tasks });
      } else if (e.entity === 'timer') setTimer(qc, e.data as Timer);
      else upsertToken(qc, e.data as ApiToken);
      if ((e.entity === 'task' && e.action !== 'keyed') || e.entity === 'project') refreshActivity(qc);
      // A snapshot request in flight may predate this event; fetch again once it lands.
      const key = keys[e.entity === 'task' ? 'tasks' : e.entity === 'project' ? 'projects' : e.entity === 'timer' ? 'timer' : 'tokens'];
      refetchAfterInFlight(qc, key);
    };

    const connect = () => {
      clearTimeout(retry);
      es?.close();
      const source = new EventSource('/api/v1/events');
      es = source;
      source.addEventListener('open', () => {
        delay = RETRY_MIN_MS;
        downSince = null;
        setState('live');
      });
      source.addEventListener('error', () => {
        downSince ??= Date.now();
        if (source.readyState !== EventSource.CLOSED) {
          setState(navigator.onLine && Date.now() - downSince < GRACE_MS ? 'connecting' : 'offline');
          return;
        }
        setState('offline');
        // Maybe the session ended: re-check, which shows the sign-in screen if so.
        void qc.invalidateQueries({ queryKey: keys.me });
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      });
      // Fresh connection or too far behind: take a new snapshot.
      source.addEventListener('ready', refetchAll);
      source.addEventListener('reset', refetchAll);
      source.addEventListener('change', onChange as EventListener);
    };

    const onOnline = () => {
      delay = RETRY_MIN_MS;
      if (es?.readyState !== EventSource.OPEN) connect();
    };
    const onOffline = () => setState('offline');

    connect();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      clearTimeout(retry);
      es?.close();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [enabled, qc]);

  return state;
}
