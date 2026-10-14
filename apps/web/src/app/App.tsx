import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ActivityView } from '../features/activity/ActivityView.tsx';
import { AssistantProvider, useAssistant } from '../features/assistant/AssistantContext.tsx';
import { AssistantIcon, AssistantPanel } from '../features/assistant/AssistantPanel.tsx';
import { BoardView } from '../features/board/BoardView.tsx';
import { DoneView } from '../features/done/DoneView.tsx';
import { FocusView } from '../features/focus/FocusView.tsx';
import { SettingsView } from '../features/settings/SettingsView.tsx';
import { EditorProvider, useEditor } from '../features/task-editor/EditorContext.tsx';
import { TimerChip } from '../features/timer/TimerCard.tsx';
import { TodayView } from '../features/today/TodayView.tsx';
import { WeekView } from '../features/week/WeekView.tsx';
import { TimerProvider } from '../features/timer/TimerContext.tsx';
import { MicIcon, VoiceCapture } from '../features/voice/VoiceCapture.tsx';
import { api, ApiError } from '../lib/api.ts';
import { clearUserData, keys } from '../lib/queries.ts';
import { hrefFor, useRoute, type Route } from '../lib/route.ts';
import { useLiveSync, type SyncState } from '../lib/sync.ts';
import { ToastProvider, useToast } from '../ui/Toast.tsx';
import { Login } from './Login.tsx';
import './app.css';

const SYNC_LABEL: Record<SyncState, string> = {
  connecting: 'Connecting',
  live: 'Live',
  offline: 'Offline',
};

const NAV: { route: Route; label: string; key: string }[] = [
  { route: 'board', label: 'Board', key: 'b' },
  { route: 'today', label: 'Today', key: 't' },
  { route: 'week', label: 'Week', key: 'w' },
  { route: 'focus', label: 'Focus', key: 'f' },
  { route: 'done', label: 'Done', key: 'd' },
];

const LAUNCH_KEY = 'helm.launchAction';

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function App() {
  const qc = useQueryClient();
  // Re-checked on every launch; a cached answer lets the installed app open offline.
  const me = useQuery({ queryKey: keys.me, queryFn: api.me, staleTime: 0 });
  const signedIn = me.data?.signedIn === true;
  const sync = useLiveSync(signedIn);

  useEffect(() => {
    if (me.data?.signedIn === false) clearUserData(qc);
  }, [me.data, qc]);

  if (me.isPending) {
    // First launch with no connection: nothing cached to show yet.
    return me.fetchStatus === 'paused' ? (
      <main className="login">
        <p className="login-offline">Helm needs a connection the first time it opens. It will load once you’re back online.</p>
      </main>
    ) : null;
  }
  if (!signedIn) return <Login onSignedIn={() => qc.invalidateQueries({ queryKey: keys.me })} />;

  return (
    <ToastProvider>
      <EditorProvider>
        <AssistantProvider>
          <TimerProvider>
            <Shell sync={sync} />
          </TimerProvider>
        </AssistantProvider>
      </EditorProvider>
    </ToastProvider>
  );
}

/** Background changes (done, start, drag, collapse) have no form to show errors in; toast them. */
function useMutationErrorToasts() {
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(
    () =>
      qc.getMutationCache().subscribe((e) => {
        if (e.type !== 'updated' || e.action.type !== 'error') return;
        // Dialogs show their own errors inline.
        if (document.querySelector('dialog[open]')) return;
        const err = e.action.error;
        toast({
          message:
            err instanceof ApiError && err.status === 0
              ? 'Not saved: can’t reach Helm. Check your connection.'
              : `Not saved: ${err instanceof Error ? err.message : 'something went wrong'}`,
        });
      }),
    [qc, toast],
  );
}

function Shell({ sync }: { sync: SyncState }) {
  const editor = useEditor();
  const route = useRoute();
  const [voiceOpen, setVoiceOpen] = useState(false);
  const assistant = useAssistant();
  useMutationErrorToasts();

  // Home-screen shortcuts open straight into adding a task: /?action=add or /?action=voice.
  // The action is also kept for a few seconds in sessionStorage: launching can install a new build,
  // which reloads the page once, and the form should still be there after that.
  useEffect(() => {
    const url = new URL(window.location.href);
    let action = url.searchParams.get('action');
    if (action) {
      url.searchParams.delete('action');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
      try {
        sessionStorage.setItem(LAUNCH_KEY, JSON.stringify({ action, at: Date.now() }));
      } catch {
        // Storage off: the reload case is lost, the normal one still works.
      }
    } else {
      try {
        const saved = JSON.parse(sessionStorage.getItem(LAUNCH_KEY) ?? 'null') as { action: string; at: number } | null;
        if (saved && Date.now() - saved.at < 15_000) action = saved.action;
      } catch {
        // Nothing saved.
      }
    }
    if (action) {
      setTimeout(() => {
        try {
          sessionStorage.removeItem(LAUNCH_KEY);
        } catch {
          // Storage off.
        }
      }, 15_000);
    }
    if (action === 'add') editor.openCreate();
    else if (action === 'voice') setVoiceOpen(true);
    // Once, on launch.
  }, []);

  // Single-key shortcuts: N new task, V voice, A assistant, B board, T today, W week, F focus, D done
  // (not while typing or in a dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.key === 'n') {
        e.preventDefault();
        editor.openCreate();
        return;
      }
      if (e.key === 'v') {
        e.preventDefault();
        setVoiceOpen(true);
        return;
      }
      if (e.key === 'a') {
        e.preventDefault();
        if (assistant.isOpen) assistant.hide();
        else assistant.show();
        return;
      }
      const nav = NAV.find((n) => n.key === e.key);
      if (nav) window.location.hash = hrefFor(nav.route);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, assistant]);

  return (
    <div className={`shell shell-${route}${assistant.isOpen ? ' has-assistant' : ''}`}>
      <header className="topbar">
        <span className="wordmark">Helm</span>
        <nav className="nav" aria-label="Views">
          {NAV.map((n) => (
            <a
              key={n.route}
              href={hrefFor(n.route)}
              // Activity lives under the Done tab.
              aria-current={route === n.route || (n.route === 'done' && route === 'activity') ? 'page' : undefined}
              aria-keyshortcuts={n.key}
            >
              {n.label}
            </a>
          ))}
        </nav>
        <div className="topbar-end">
          {route !== 'focus' && <TimerChip />}
          <span className={`sync sync-${sync}`} role="status">
            {SYNC_LABEL[sync]}
          </span>
          <a
            href={hrefFor('settings')}
            className="topbar-icon"
            aria-label="Settings"
            title="Settings"
            aria-current={route === 'settings' ? 'page' : undefined}
          >
            <svg viewBox="0 0 24 24" aria-hidden>
              <path
                d="M19.08 9.85 L21.38 9.94 L21.38 14.06 L19.08 14.15 L18.53 15.49 L20.09 17.18 L17.18 20.09 L15.49 18.53 L14.15 19.08 L14.06 21.38 L9.94 21.38 L9.85 19.08 L8.51 18.53 L6.82 20.09 L3.91 17.18 L5.47 15.49 L4.92 14.15 L2.62 14.06 L2.62 9.94 L4.92 9.85 L5.47 8.51 L3.91 6.82 L6.82 3.91 L8.51 5.47 L9.85 4.92 L9.94 2.62 L14.06 2.62 L14.15 4.92 L15.49 5.47 L17.18 3.91 L20.09 6.82 L18.53 8.51 Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </a>
          <button
            className="topbar-icon"
            onClick={() => (assistant.isOpen ? assistant.hide() : assistant.show())}
            aria-label="Assistant"
            title="Assistant (A)"
            aria-expanded={assistant.isOpen}
            aria-keyshortcuts="a"
          >
            <AssistantIcon />
          </button>
          <button
            className="topbar-icon voice-btn"
            onClick={() => setVoiceOpen(true)}
            aria-label="Add a task by voice"
            title="Add a task by voice (V)"
            aria-keyshortcuts="v"
          >
            <MicIcon />
          </button>
          <button className="btn topbar-add" onClick={() => editor.openCreate()} aria-keyshortcuts="n">
            <span className="topbar-add-plus" aria-hidden>
              +
            </span>
            <span className="topbar-add-label">Add task</span>
          </button>
        </div>
      </header>
      {route === 'board' ? (
        <BoardView />
      ) : route === 'today' ? (
        <TodayView />
      ) : route === 'week' ? (
        <WeekView />
      ) : route === 'done' ? (
        <DoneView />
      ) : route === 'activity' ? (
        <ActivityView />
      ) : route === 'settings' ? (
        <SettingsView />
      ) : (
        <FocusView />
      )}
      <AssistantPanel />
      {voiceOpen && (
        <VoiceCapture
          onResult={(r) => {
            setVoiceOpen(false);
            editor.openSuggestions(r);
          }}
          onClose={() => setVoiceOpen(false)}
        />
      )}
    </div>
  );
}
