import { useMemo, useState } from 'react';
import { buildTree, dayKey, MAX_TODAY_MAIN, type Project, type Task, type TaskNode, type TodaySlot } from '@helm/shared';
import { formatMinutes } from '../../lib/format.ts';
import { useAllProjects, useDoneLog, useSetToday, useTaskAction, useTasks } from '../../lib/queries.ts';
import { hrefFor } from '../../lib/route.ts';
import { useCompleteTask } from '../../lib/useCompleteTask.ts';
import { useDeleteTask } from '../../lib/useDeleteTask.ts';
import { useNow } from '../../lib/useNow.ts';
import { useToast } from '../../ui/Toast.tsx';
import { projectIcon } from '../board/project-icon.ts';
import { isWorking, TaskCard } from '../board/TaskCard.tsx';
import { useSwipe } from '../board/useSwipe.ts';
import { useEditor } from '../task-editor/EditorContext.tsx';
import { PickSheet } from './PickSheet.tsx';
import { PlanAdd } from './PlanAdd.tsx';
import { carriedFrom, doneToday, minutesLeft, startOfDay, todayLists } from './today-model.ts';
import '../board/board.css';
import './today.css';

const MAIN_FULL = `Main has ${MAX_TODAY_MAIN} already. Move one to Secondary first.`;

/**
 * The day's plan: up to three main tasks that make the day, and secondary ones if there's time.
 * Board tasks keep living on the board; Today-only ones live just here. Unfinished tasks stay on
 * Today the next day, marked with the day they were planned.
 */
export function TodayView() {
  const tasks = useTasks();
  const projects = useAllProjects();
  const now = new Date(useNow(60_000));
  const since = startOfDay(now).toISOString();
  const todayKey = dayKey(now);
  const doneLog = useDoneLog({ from: since });
  const setToday = useSetToday();
  const action = useTaskAction();
  const complete = useCompleteTask();
  const deleteTask = useDeleteTask();
  const editor = useEditor();
  const toast = useToast();
  const [picking, setPicking] = useState(false);

  const roots = useMemo(() => buildTree(tasks.data ?? []), [tasks.data]);
  const { main, side } = useMemo(() => todayLists(roots, todayKey), [roots, todayKey]);
  const done = useMemo(
    () => doneToday(tasks.data ?? [], doneLog.data?.pages.flatMap((p) => p.tasks) ?? [], now),
    // `since` changes at midnight, which is when the list should start over.
    [tasks.data, doneLog.data, since],
  );
  const projectMap = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);
  const mainFull = main.length >= MAX_TODAY_MAIN;

  if (tasks.isPending) return <main className="today" aria-busy="true" />;

  const total = main.length + side.length + done.length;
  const left = minutesLeft([...main, ...side]);
  const dateLabel = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });

  function move(t: TaskNode, to: TodaySlot) {
    if (to === 'main' && mainFull) return toast({ message: MAIN_FULL });
    setToday.mutate({ id: t.id, today: to });
  }

  async function takeOff(t: TaskNode) {
    if (t.todayOnly) {
      // It lives only here: taking it off deletes it (with Undo).
      try {
        await deleteTask(t);
      } catch (err) {
        toast({ message: `Couldn’t remove “${t.title}”: ${(err as Error).message}` });
      }
      return;
    }
    const was = t.today!;
    const wasDay = t.planDate ?? undefined;
    const place = t.projectId ? (projectMap.get(t.projectId)?.name ?? 'its project') : 'the Inbox';
    setToday.mutate(
      { id: t.id, today: null },
      {
        onSuccess: () =>
          toast({
            message: `Off Today. Still in ${place}.`,
            action: { label: 'Undo', run: () => setToday.mutate({ id: t.id, today: was, planDate: wasDay }) },
          }),
      },
    );
  }

  /** Swiped left: start it, or pause what's in progress. */
  function toggleWork(t: TaskNode) {
    const working = t.status === 'in_progress' ? t : t.subtasks.find((s) => s.status === 'in_progress');
    action.mutate(
      { id: working?.id ?? t.id, action: working ? 'stop' : 'start' },
      {
        onSuccess: () =>
          toast(
            working
              ? { message: `Paused: ${t.title}` }
              : { message: `Started: ${t.title}`, action: { label: 'Focus', run: () => (window.location.hash = hrefFor('focus')) } },
          ),
      },
    );
  }

  const row = (t: TaskNode, i?: number) => (
    <TodayRow
      key={t.id}
      task={t}
      number={i}
      project={t.projectId ? projectMap.get(t.projectId) : undefined}
      carried={carriedFrom(t, now)}
      canPromote={!mainFull}
      onComplete={() => complete(t)}
      onEdit={() => editor.openEdit(t.id)}
      onToggleSubtask={(s) => action.mutate({ id: s.id, action: s.status === 'done' ? 'reopen' : 'complete' })}
      onToggleWork={() => toggleWork(t)}
      onMove={(to) => move(t, to)}
      onTakeOff={() => void takeOff(t)}
    />
  );

  return (
    <main className="today">
      <header className="today-head">
        <div>
          <h1 className="today-title">Today</h1>
          <p className="today-date">{dateLabel}</p>
        </div>
        {total > 0 && (
          <p className="today-progress">
            <b>
              {done.length} of {total} done
            </b>
            <span>{left ? `About ${formatMinutes(left)} left` : main.length + side.length ? 'No estimates' : 'All clear'}</span>
          </p>
        )}
      </header>
      {total > 0 && (
        <div className="today-bar" role="presentation">
          <i style={{ width: `${(done.length / total) * 100}%` }} />
        </div>
      )}

      <section className="today-section today-main" aria-labelledby="today-main">
        <h2 id="today-main" className="today-label">
          Main <span className="today-count">{main.length} / {MAX_TODAY_MAIN}</span>
        </h2>
        {main.length ? (
          <ol className="today-list">{main.map((t, i) => row(t, i + 1))}</ol>
        ) : (
          <p className="today-empty">Pick up to three things that would make today a good day.</p>
        )}
      </section>

      <section className="today-section" aria-labelledby="today-side">
        <h2 id="today-side" className="today-label">
          Secondary <span className="today-count">{side.length}</span>
        </h2>
        {side.length ? (
          <ul className="today-list">{side.map((t) => row(t))}</ul>
        ) : (
          <p className="today-empty">If there’s time. Nice-to-haves go here.</p>
        )}
      </section>

      <PlanAdd dayName="today" mainFull={mainFull} mainEmpty={main.length === 0} projects={projects.data ?? []} />
      <button type="button" className="btn today-pick" onClick={() => setPicking(true)}>
        Pick from the board
      </button>

      {done.length > 0 && (
        <details className="today-done" open>
          <summary>Done today ({done.length})</summary>
          <ul className="today-done-list">
            {done.map((t) => (
              <li key={t.id}>
                <button
                  className="today-done-check"
                  aria-label={`Not done: ${t.title}`}
                  title="Not done after all"
                  onClick={() => action.mutate({ id: t.id, action: 'reopen' })}
                >
                  ✓
                </button>
                <button className="today-done-title" onClick={() => editor.openEdit(t.id)}>
                  {t.title}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {picking && (
        <PickSheet roots={roots} day={todayKey} today={todayKey} mainFull={mainFull} onClose={() => setPicking(false)} />
      )}
    </main>
  );
}

interface RowProps {
  task: TaskNode;
  /** 1-based, for main tasks. */
  number?: number;
  project: Project | undefined;
  /** The day it was planned, when that was before today. */
  carried: string | null;
  canPromote: boolean;
  onComplete: () => void;
  onEdit: () => void;
  onToggleSubtask: (sub: Task) => void;
  onToggleWork: () => void;
  onMove: (to: TodaySlot) => void;
  onTakeOff: () => void;
}

/** A task on Today: the board's card, plus where it lives and buttons to move it. Swipes like on the board. */
function TodayRow({ task, number, project, carried, canPromote, ...on }: RowProps) {
  const main = task.today === 'main';
  const swipe = useSwipe({ enabled: true, onRight: on.onComplete, onLeft: on.onToggleWork });
  const swipeSide = swipe.dx > 0 ? 'done' : 'work';

  return (
    <li className={`card-slot today-slot ${swipe.dx ? 'is-swiping' : ''}`} {...swipe.handlers}>
      {swipe.dx !== 0 && (
        <div className={`swipe-under swipe-${swipeSide}${swipe.past ? ' is-past' : ''}`} aria-hidden="true">
          <span className="swipe-label">{swipeSide === 'done' ? '✓ Done' : isWorking(task) ? '❚❚ Pause' : '▶ Start'}</span>
        </div>
      )}
      <div
        className={`card-swipe${swipe.settling ? ' is-settling' : ''}`}
        style={swipe.dx ? { transform: `translateX(${swipe.dx}px)` } : undefined}
      >
        <TaskCard
          task={task}
          className={main ? 'today-card is-main' : 'today-card'}
          lead={number !== undefined ? <span className="today-num" aria-hidden="true">{number}</span> : undefined}
          meta={
            <>
              {task.todayOnly ? (
                <span className="today-only">Today only</span>
              ) : (
                <span className="today-where">{project ? `${projectIcon(project)} ${project.name}` : 'Inbox'}</span>
              )}
              {carried && <span className="today-carried">from {carried}</span>}
            </>
          }
          end={
            <div className="today-actions">
              {main ? (
                <button className="icon-btn" title="Move to Secondary" aria-label={`Move to Secondary: ${task.title}`} onClick={() => on.onMove('side')}>
                  ↓
                </button>
              ) : (
                <button
                  className="icon-btn"
                  title={canPromote ? 'Make it main' : `Main has ${MAX_TODAY_MAIN} already`}
                  aria-label={`Make it main: ${task.title}`}
                  aria-disabled={!canPromote}
                  onClick={() => on.onMove('main')}
                >
                  ↑
                </button>
              )}
              <button
                className="icon-btn"
                title={task.todayOnly ? 'Remove' : 'Take off Today'}
                aria-label={`${task.todayOnly ? 'Remove' : 'Take off Today'}: ${task.title}`}
                onClick={on.onTakeOff}
              >
                ✕
              </button>
            </div>
          }
          onEdit={on.onEdit}
          onComplete={on.onComplete}
          onToggleSubtask={on.onToggleSubtask}
          onToggleWork={on.onToggleWork}
        />
      </div>
    </li>
  );
}
