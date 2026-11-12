import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { INBOX, type Project, type Task } from '@helm/shared';
import { clockTime, formatMinutes } from '../../lib/format.ts';
import { keys, useAllProjects, useDoneLog, useTaskAction, useTasks } from '../../lib/queries.ts';
import { readHashParams, writeHashParams } from '../../lib/route.ts';
import { ProjectLabel, type ProjectMap } from '../../ui/ProjectLabel.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { LogTabs } from '../activity/LogTabs.tsx';
import {
  DONE_QUERY_MAX,
  RANGES,
  RANGE_LABEL,
  buildLog,
  dayKey,
  dayLabel,
  entryHolds,
  filterFromParams,
  filterToParams,
  rangeBounds,
  startOfDay,
  type DoneFilter,
  type LogEntry,
} from './done-model.ts';
import '../task-editor/editor.css';
import './done.css';

/** Current date, refreshed at midnight so "Today" and relative ranges roll over on a wall display. */
function useToday(): Date {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const next = startOfDay(today);
    next.setDate(next.getDate() + 1);
    const t = setTimeout(() => setToday(new Date()), next.getTime() - Date.now() + 1000);
    return () => clearTimeout(t);
  }, [today]);
  return today;
}

export function DoneView() {
  const today = useToday();
  const [filter, setFilter] = useState<DoneFilter>(() => filterFromParams(readHashParams()));
  const projects = useAllProjects();
  const board = useTasks();

  useEffect(() => writeHashParams(filterToParams(filter)), [filter]);
  // A link into Done while it is already open (search picks a finished task) changes only the hash.
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash.startsWith('#/done')) setFilter(filterFromParams(readHashParams()));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const bounds = useMemo(() => rangeBounds(filter, today), [filter, today]);
  const log = useDoneLog({
    ...bounds,
    projectId: filter.project ?? undefined,
    q: filter.q ?? undefined,
    includeSubtasks: true,
  });

  const projectMap: ProjectMap = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);
  const days = useMemo(() => {
    const done = log.data?.pages.flatMap((pg) => pg.tasks) ?? [];
    const open = new Map((board.data ?? []).map((t) => [t.id, t]));
    return buildLog(done, (id) => open.get(id));
  }, [log.data, board.data]);
  const count = days.reduce((n, d) => n + d.entries.length, 0);

  // Any other change of filter means the pointed-out task has done its job.
  const update = useCallback(
    (patch: Partial<DoneFilter>) => setFilter((f) => ({ ...f, task: null, ...patch })),
    [],
  );

  // Bring the pointed-out task into view once it has loaded.
  const pointedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!filter.task || pointedAt.current === filter.task || log.isPending) return;
    const el = document.querySelector<HTMLElement>('.log-entry.is-picked');
    if (!el) return;
    pointedAt.current = filter.task;
    el.scrollIntoView({ block: 'center' });
  }, [filter.task, days, log.isPending]);

  return (
    <main className="log">
      <LogTabs current="done" />
      <header className="log-head">
        <h1 className="log-summary" aria-live="polite">
          {log.isPending ? 'Done' : summary(count, log.hasNextPage, filter, projectMap)}
        </h1>
        <Filters filter={filter} today={today} projects={projects.data ?? []} onChange={update} />
      </header>

      {log.isError ? (
        <p className="log-empty">
          The log didn’t load.{' '}
          <button className="link-btn" onClick={() => void log.refetch()}>
            Try again
          </button>
        </p>
      ) : !log.isPending && count === 0 ? (
        <p className="log-empty">
          {filter.q
            ? 'No finished task has those words. Try fewer, or a longer range.'
            : filter.range === 'all' && !filter.project
              ? 'Tasks you mark done land here, with the time you finished them.'
              : 'Try a longer range or another project.'}
        </p>
      ) : (
        days.map((day) => (
          <section key={day.key} className="log-day" aria-labelledby={`day-${day.key}`}>
            <h2 className="log-date" id={`day-${day.key}`}>
              <span>{dayLabel(day.key, today)}</span>
              <span className="log-date-stats">
                {plural(day.entries.length, 'task')}
                {day.estimateMinutes > 0 && `, ${formatMinutes(day.estimateMinutes)}`}
              </span>
            </h2>
            <ol className="log-entries">
              {day.entries.map((e) => (
                <Entry key={e.task.id} entry={e} projects={projectMap} picked={entryHolds(e, filter.task)} />
              ))}
            </ol>
          </section>
        ))
      )}

      {log.hasNextPage && (
        <div className="log-more">
          <button className="btn" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
            {log.isFetchingNextPage ? 'Loading…' : 'Show older'}
          </button>
        </div>
      )}
    </main>
  );
}

function Filters({
  filter,
  today,
  projects,
  onChange,
}: {
  filter: DoneFilter;
  today: Date;
  projects: Project[];
  onChange: (patch: Partial<DoneFilter>) => void;
}) {
  const projectId = useId();
  const fromId = useId();
  const toId = useId();
  const wordsId = useId();
  // Typed words reach the filter (and the server) once typing pauses.
  const [words, setWords] = useState(filter.q ?? '');
  const sent = useRef(filter.q);
  useEffect(() => {
    // Follow a change from outside (a link from search), without fighting what is being typed.
    if (filter.q !== sent.current) {
      sent.current = filter.q;
      setWords(filter.q ?? '');
    }
  }, [filter.q]);
  useEffect(() => {
    const q = words.trim() || null;
    if (q === (sent.current ?? null)) return;
    const t = setTimeout(() => {
      sent.current = q;
      onChange({ q });
    }, 250);
    return () => clearTimeout(t);
  }, [words, onChange]);
  const live = projects.filter((p) => !p.archivedAt);
  const archived = projects.filter((p) => p.archivedAt);

  const pickRange = (range: DoneFilter['range']) => {
    if (range === 'custom' && !filter.from && !filter.to) {
      // Start the custom range as the last week, ready to adjust.
      const from = new Date(today);
      from.setDate(from.getDate() - 6);
      onChange({ range, from: dayKey(from), to: dayKey(today) });
    } else onChange({ range });
  };

  return (
    <div className="log-filters">
      <fieldset className="log-ranges">
        <legend className="visually-hidden">Date range</legend>
        <div className="chips">
          {RANGES.map((r) => (
            <label key={r} className="chip">
              <input
                type="radio"
                name="done-range"
                value={r}
                checked={filter.range === r}
                onChange={() => pickRange(r)}
              />
              <span>{RANGE_LABEL[r]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="log-words">
        <label htmlFor={wordsId} className="visually-hidden">
          Words in the title or notes
        </label>
        <input
          id={wordsId}
          type="search"
          className="log-select log-words-input"
          placeholder="Find…"
          autoComplete="off"
          spellCheck={false}
          maxLength={DONE_QUERY_MAX}
          value={words}
          onChange={(e) => setWords(e.target.value)}
        />
      </div>

      <div className="log-project">
        <label htmlFor={projectId} className="visually-hidden">
          Project
        </label>
        <select
          id={projectId}
          className="log-select"
          value={filter.project ?? ''}
          onChange={(e) => onChange({ project: e.target.value || null })}
        >
          <option value="">All projects</option>
          <option value={INBOX}>Inbox</option>
          {live.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {archived.length > 0 && (
            <optgroup label="Archived">
              {archived.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      {filter.range === 'custom' && (
        <div className="log-dates">
          <label htmlFor={fromId}>From</label>
          <input
            id={fromId}
            type="date"
            className="log-select"
            value={filter.from ?? ''}
            max={dayKey(today)}
            onChange={(e) => onChange({ from: e.target.value || null })}
          />
          <label htmlFor={toId}>to</label>
          <input
            id={toId}
            type="date"
            className="log-select"
            value={filter.to ?? ''}
            max={dayKey(today)}
            onChange={(e) => onChange({ to: e.target.value || null })}
          />
        </div>
      )}
    </div>
  );
}

function Entry({ entry, projects, picked }: { entry: LogEntry; projects: ProjectMap; picked: boolean }) {
  const { task, subtasks, partOf } = entry;
  const qc = useQueryClient();
  const action = useTaskAction();
  const toast = useToast();

  const reopen = () =>
    action.mutate(
      { id: task.id, action: 'reopen' },
      {
        onSuccess: () => {
          // Back on the board; its done subtasks aren't in the board snapshot yet.
          void qc.invalidateQueries({ queryKey: keys.tasks });
          toast({
            message: `Reopened: ${task.title}`,
            action: { label: 'Undo', run: () => action.mutate({ id: task.id, action: 'complete' }) },
          });
        },
      },
    );

  return (
    <li className={`log-entry${picked ? ' is-picked' : ''}`} aria-current={picked ? 'true' : undefined}>
      <time className="log-time" dateTime={task.completedAt!}>
        {clockTime(task.completedAt!)}
      </time>
      <span className="log-fix" aria-hidden />
      <div className="log-body">
        <p className="log-title">{task.title}</p>
        <p className="log-meta">
          <ProjectLabel projectId={task.projectId} projects={projects} />
          {partOf && <span>Part of {partOf.title}</span>}
          {task.estimateMinutes != null && <span>{formatMinutes(task.estimateMinutes)}</span>}
          {task.source !== 'manual' && <span>{sourceLabel(task.source)}</span>}
        </p>
        {subtasks.length > 0 && (
          <ul className="log-subs" aria-label={`${plural(subtasks.length, 'subtask')} done`}>
            {subtasks.map((s) => (
              <li key={s.id}>{s.title}</li>
            ))}
          </ul>
        )}
      </div>
      <button
        className="btn btn-quiet log-reopen"
        disabled={action.isPending}
        onClick={reopen}
        aria-label={`Reopen ${task.title}`}
        title="Reopen"
      >
        <svg className="log-reopen-icon" viewBox="0 0 20 20" aria-hidden>
          <path d="M4.5 9.5a6 6 0 1 0 1.8-4.3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M5.5 1.8v3.8h3.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="log-reopen-text">Reopen</span>
      </button>
    </li>
  );
}

// ---------- Copy ----------

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function sourceLabel(source: Task['source']): string {
  if (source === 'voice') return 'Added by voice';
  if (source === 'ai:assistant') return 'Added by the assistant';
  return `Added by ${source.slice('ai:'.length)}`;
}

function shortDate(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function summary(count: number, more: boolean, f: DoneFilter, projects: ProjectMap): string {
  let where =
    f.project === null
      ? ''
      : f.project === INBOX
        ? ' in the Inbox'
        : ` in ${projects.get(f.project)?.name ?? 'this project'}`;
  let when: string;
  switch (f.range) {
    case 'today':
      when = ' today';
      break;
    case 'week':
      when = ' in the last 7 days';
      break;
    case 'month':
      when = ' in the last 30 days';
      break;
    case 'all':
      when = '';
      break;
    case 'custom': {
      let [a, b] = [f.from, f.to];
      if (a && b && a > b) [a, b] = [b, a];
      when =
        a && b
          ? a === b
            ? ` on ${shortDate(a)}`
            : ` from ${shortDate(a)} to ${shortDate(b)}`
          : a
            ? ` since ${shortDate(a)}`
            : b
              ? ` up to ${shortDate(b)}`
              : '';
    }
  }
  if (f.q) where = ` matching “${f.q}”${where}`;
  if (count === 0) return f.range === 'today' ? `Nothing done${where} yet today` : `Nothing done${where}${when}`;
  return `${more ? `${count}+ tasks` : plural(count, 'task')} done${where}${when}`;
}
