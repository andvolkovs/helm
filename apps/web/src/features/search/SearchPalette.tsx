import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { addDays, dayKey, formatDay, shownDayOf, shortDay, type Task } from '@helm/shared';
import { useAllProjects, useFoundDone, useTasks } from '../../lib/queries.ts';
import { hrefFor } from '../../lib/route.ts';
import { useToday } from '../../lib/useToday.ts';
import { KeyedTitle } from '../../ui/KeyedTitle.tsx';
import { projectTitle } from '../board/project-icon.ts';
import { useEditor } from '../task-editor/EditorContext.tsx';
import {
  buildEntries,
  DONE_MIN_CHARS,
  DONE_SHOWN,
  searchOpen,
  QUERY_MAX,
  type Entry,
  type ViewLink,
} from './search-model.ts';
import './search.css';

/** A value that follows `value` after it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Find a task by its words, or jump somewhere. A native modal dialog, so focus is trapped while it
 * is open and returns to where it was when it closes. Open tasks come from the cache and are
 * instant; done ones are asked from the server once typing pauses.
 */
export function SearchPalette({ views, onClose }: { views: readonly ViewLink[]; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const editor = useEditor();
  const tasks = useTasks();
  const projects = useAllProjects();
  const today = useToday();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const uid = useId();
  const listId = `${uid}-list`;

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  }, []);
  const close = () => dialogRef.current?.close();

  const q = query.trim();
  const settled = useDebounced(q, 200);
  // Only ask once typing has paused, and only show the answer for what is typed now.
  const wantsDone = settled.length >= DONE_MIN_CHARS;
  const found = useFoundDone(settled, wantsDone);
  // While the next answer is on its way the last one stays, so the list doesn't blink per key.
  const done = wantsDone && q.length >= DONE_MIN_CHARS ? (found.data?.tasks ?? []).slice(0, DONE_SHOWN) : [];

  const titleOf = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t.title])), [tasks.data]);
  const projectName = useMemo(() => {
    const byId = new Map((projects.data ?? []).map((p) => [p.id, p]));
    return (t: Task) => projectTitle(t.projectId ? (byId.get(t.projectId) ?? null) : null);
  }, [projects.data]);

  const open = useMemo(() => searchOpen(tasks.data ?? [], q), [tasks.data, q]);
  const entries = useMemo(() => buildEntries(open, done, views, q), [open, done, views, q]);
  // The list can shrink under the highlight (done results arriving or leaving).
  const at = Math.min(active, entries.length - 1);
  const idOf = (e: Entry) => `${uid}-${e.id}`;

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at, entries]);

  function run(e: Entry) {
    close();
    if (e.kind === 'open') editor.openEdit(e.task.id);
    // The editor only knows tasks on the board; finished ones are in the Done log.
    else if (e.kind === 'done') window.location.hash = hrefFor('done');
    else if (e.kind === 'new') editor.openCreate(e.title ? { title: e.title } : undefined);
    else window.location.hash = hrefFor(e.view.route);
  }

  function onKeyDown(ev: KeyboardEvent) {
    if (ev.nativeEvent.isComposing) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const n = entries.length;
      setActive((ev.key === 'ArrowDown' ? at + 1 : at - 1 + n) % n);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const e = ev.ctrlKey || ev.metaKey ? entries.find((x) => x.kind === 'new') : entries[at];
      if (e) run(e);
    }
  }

  /** "Today", "Tomorrow", "Fri 13" or a date, for the day a task is planned. */
  const dayLabel = (day: string) =>
    day === today
      ? 'Today'
      : day === addDays(today, 1)
        ? 'Tomorrow'
        : day > today && day <= addDays(today, 6)
          ? shortDay(day)
          : formatDay(day, { day: 'numeric', month: 'short' });

  const row = (e: Entry, label: ReactNode, meta: string, key?: string) => {
    const i = entries.indexOf(e);
    return (
      <div
        key={e.id}
        id={idOf(e)}
        role="option"
        aria-selected={i === at}
        className={`search-row${i === at ? ' is-active' : ''}`}
        // Keep focus in the input while clicking.
        onMouseDown={(ev) => ev.preventDefault()}
        onPointerMove={() => i !== at && setActive(i)}
        onClick={() => run(e)}
      >
        <span className="search-main">{label}</span>
        {meta && <span className="search-meta">{meta}</span>}
        {key && <kbd className="search-key">{key}</kbd>}
      </div>
    );
  };

  const taskRow = (e: Extract<Entry, { kind: 'open' | 'done' }>) => {
    const t = e.task;
    const planned = e.kind === 'open' ? shownDayOf(t, today) : null;
    const finished = e.kind === 'done' && t.completedAt ? dayKey(new Date(t.completedAt)) : null;
    const parts = [
      t.parentTaskId ? `Part of ${titleOf.get(t.parentTaskId) ?? 'a task'}` : null,
      projectName(t),
      finished ? `Done ${formatDay(finished, { day: 'numeric', month: 'short' })}` : null,
      planned ? dayLabel(planned) : null,
    ].filter(Boolean);
    return row(e, <KeyedTitle title={t.title} words={t.keyWords} />, parts.join(' · '));
  };

  const openRows = entries.filter((e): e is Extract<Entry, { kind: 'open' }> => e.kind === 'open');
  const doneRows = entries.filter((e): e is Extract<Entry, { kind: 'done' }> => e.kind === 'done');
  // A view named outright comes first (see buildEntries), so it shows first too.
  const topView = entries[0]?.kind === 'view' ? entries[0] : null;
  const actionRows = entries.filter((e) => (e.kind === 'new' || e.kind === 'view') && e !== topView);
  const nothing = q.length > 0 && !openRows.length && !doneRows.length && !found.isFetching && settled === q;

  return (
    <dialog
      ref={dialogRef}
      className="search-sheet"
      aria-label="Search"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) close(); // backdrop
      }}
    >
      <div className="search-box">
        <svg viewBox="0 0 24 24" aria-hidden className="search-glass">
          <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M16 16 L20.5 20.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <input
          className="search-input"
          type="text"
          role="combobox"
          aria-label="Search tasks or jump to a view"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={entries[at] ? idOf(entries[at]!) : undefined}
          placeholder="Search tasks, or jump to…"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          autoFocus
          maxLength={QUERY_MAX}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd className="search-esc" aria-hidden>
          Esc
        </kbd>
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="search-list">
        {topView?.kind === 'view' && (
          <div role="group" aria-labelledby={`${uid}-h-top`}>
            <h2 id={`${uid}-h-top`} className="search-group">
              Jump to
            </h2>
            {row(topView, `Go to ${topView.view.label}`, '', topView.view.key.toUpperCase())}
          </div>
        )}
        {openRows.length > 0 && (
          <div role="group" aria-labelledby={`${uid}-h-open`}>
            <h2 id={`${uid}-h-open`} className="search-group">
              Open tasks
            </h2>
            {openRows.map(taskRow)}
          </div>
        )}
        {doneRows.length > 0 && (
          <div role="group" aria-labelledby={`${uid}-h-done`}>
            <h2 id={`${uid}-h-done`} className="search-group">
              Done
            </h2>
            {doneRows.map(taskRow)}
          </div>
        )}
        {nothing && (
          <p className="search-none" role="status">
            No task matches.
          </p>
        )}
        <div role="group" aria-labelledby={`${uid}-h-act`}>
          <h2 id={`${uid}-h-act`} className="search-group">
            Actions
          </h2>
          {actionRows.map((e) =>
            e.kind === 'new'
              ? row(e, e.title ? `New task “${e.title}”` : 'New task', '', e.title ? 'Ctrl ↵' : 'N')
              : e.kind === 'view'
                ? row(e, `Go to ${e.view.label}`, '', e.view.key.toUpperCase())
                : null,
          )}
        </div>
      </div>
    </dialog>
  );
}

/** The magnifying glass for the top bar. */
export function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M16 16 L20.5 20.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
