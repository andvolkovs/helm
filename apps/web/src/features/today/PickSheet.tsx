import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDay, MAX_TODAY_MAIN, shownDayOf, type Priority, type TaskNode, type TodaySlot } from '@helm/shared';
import { formatMinutes } from '../../lib/format.ts';
import { useProjects, useSetToday } from '../../lib/queries.ts';
import { KeyedTitle } from '../../ui/KeyedTitle.tsx';
import { LineInput } from '../../ui/LineInput.tsx';
import { projectIcon } from '../board/project-icon.ts';

const PRIORITY_LABEL: Record<Priority, string> = { now: 'Now', soon: 'Soon', someday: 'Someday' };
const RANK: Record<Priority, number> = { now: 0, soon: 1, someday: 2 };

interface Props {
  roots: TaskNode[];
  /** The day to plan them for, `YYYY-MM-DD`. */
  day: string;
  today: string;
  mainFull: boolean;
  onClose: () => void;
}

/**
 * Open board tasks, by project, to put on a day of the plan (Today, or a later day from the Week).
 * Tasks planned for another day are listed too, marked with it: picking one moves it. Stays open
 * so several can be picked in a row; each one leaves the list as it's added.
 */
export function PickSheet({ roots, day, today, mainFull, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const projects = useProjects();
  const setToday = useSetToday();
  const [query, setQuery] = useState('');

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const open = roots
      .filter((t) => !t.todayOnly && t.status !== 'done' && !t.deletedAt && shownDayOf(t, today) !== day)
      .filter((t) => !q || t.title.toLowerCase().includes(q))
      .sort((a, b) => RANK[a.priority] - RANK[b.priority]);
    return [null, ...(projects.data ?? [])]
      .map((p) => ({ project: p, tasks: open.filter((t) => t.projectId === (p?.id ?? null)) }))
      .filter((g) => g.tasks.length > 0);
  }, [roots, projects.data, query, day, today]);

  const pick = (t: TaskNode, to: TodaySlot) => setToday.mutate({ id: t.id, today: to, planDate: day });
  const dayName = day === today ? 'Today' : formatDay(day, { weekday: 'long' });
  const plannedFor = (t: TaskNode) => {
    const d = shownDayOf(t, today);
    return d === null ? null : d === today ? 'On Today' : `Planned ${formatDay(d, { weekday: 'short' })}`;
  };

  return (
    <dialog
      ref={dialogRef}
      className="today-sheet"
      aria-labelledby="pick-heading"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current.close(); // backdrop
      }}
    >
      <header className="today-sheet-head">
        <h2 id="pick-heading">{day === today ? 'Pick from the board' : `Pick for ${dayName}`}</h2>
        <button type="button" className="btn btn-primary" onClick={() => dialogRef.current?.close()}>
          Done
        </button>
      </header>
      <LineInput
        className="today-sheet-search"
        aria-label="Find a task"
        placeholder="Find a task…"
        value={query}
        onValueChange={setQuery}
        onEnter={() => {}}
      />
      {mainFull && (
        <p className="today-sheet-note">
          {dayName}’s Main has {MAX_TODAY_MAIN} already. You can still add to Secondary.
        </p>
      )}
      <div className="today-sheet-body">
        {groups.length === 0 && (
          <p className="today-empty">
            {query ? 'No open task matches.' : `Everything open is already on ${day === today ? 'Today' : dayName}.`}
          </p>
        )}
        {groups.map(({ project, tasks }) => (
          <section key={project?.id ?? 'inbox'}>
            <h3 className="today-sheet-group">{project ? `${projectIcon(project)} ${project.name}` : '📥 Inbox'}</h3>
            <ul className="today-sheet-list">
              {tasks.map((t) => (
                <li key={t.id}>
                  <div className="today-sheet-task">
                    <span className="today-sheet-title">
                      <KeyedTitle title={t.title} words={t.keyWords} />
                    </span>
                    <span className={`today-sheet-meta prio-${t.priority}`}>
                      {PRIORITY_LABEL[t.priority]}
                      {t.estimateMinutes ? ` · ${formatMinutes(t.estimateMinutes)}` : ''}
                      {plannedFor(t) ? ` · ${plannedFor(t)}` : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="today-pill is-main"
                    disabled={mainFull}
                    onClick={() => pick(t, 'main')}
                    aria-label={`Add to Main: ${t.title}`}
                  >
                    Main
                  </button>
                  <button type="button" className="today-pill" onClick={() => pick(t, 'side')} aria-label={`Add to Secondary: ${t.title}`}>
                    2nd
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </dialog>
  );
}
