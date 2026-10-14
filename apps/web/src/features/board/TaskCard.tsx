import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { formatDay, shownDayOf, type Task, type TaskNode } from '@helm/shared';
import { formatMinutes } from '../../lib/format.ts';
import { KeyedTitle } from '../../ui/KeyedTitle.tsx';
import { agentBadge } from './agent-badge.ts';
import { useSwipe } from './useSwipe.ts';

export interface CardActions {
  onEdit: (task: Task) => void;
  onComplete: (task: Task) => void | Promise<unknown>;
  onToggleSubtask: (sub: Task) => void;
  /** Start the task, or pause it (or its subtask) if it's in progress. */
  onToggleWork: (task: TaskNode) => void;
  /** The ☀ button: put the task on Today, or take it off. */
  onToggleToday?: (task: TaskNode) => void;
  /** Today, `YYYY-MM-DD`: the ☀ button names the day of a task planned for later. */
  today?: string;
}

/** In progress itself, or one of its subtasks is. */
export const isWorking = (task: TaskNode) =>
  task.status === 'in_progress' || task.subtasks.some((s) => s.status === 'in_progress');

interface CardProps extends CardActions {
  task: TaskNode;
  /** Rendered inside the drag overlay: no sortable wiring, lifted look. */
  overlay?: boolean;
  /** Before the check, e.g. a number. */
  lead?: ReactNode;
  /** More details after the card's own. */
  meta?: ReactNode;
  /** After the body, e.g. buttons. */
  end?: ReactNode;
  className?: string;
}

export function TaskCard({
  task,
  overlay = false,
  onEdit,
  onComplete,
  onToggleSubtask,
  onToggleToday,
  today,
  lead,
  meta,
  end,
  className,
}: CardProps) {
  const [open, setOpen] = useState(false);
  const active = isWorking(task);
  const agent = agentBadge(task);
  const shown = today ? shownDayOf(task, today) : null;
  const later = shown && today && shown > today ? shown : null;

  return (
    <article className={`card ${active ? 'is-active' : ''} ${overlay ? 'is-overlay' : ''} ${className ?? ''}`}>
      {lead}
      <button
        className="card-check"
        aria-label={`Mark done: ${task.title}`}
        onClick={() => void onComplete(task)}
        tabIndex={overlay ? -1 : 0}
      />
      <div className="card-body">
        <button className="card-title" onClick={() => onEdit(task)} tabIndex={overlay ? -1 : 0}>
          <KeyedTitle title={task.title} words={task.keyWords} />
        </button>
        <div className="card-meta">
          {active && <span className="card-live">In progress</span>}
          {agent && <span className={`card-agent card-agent-${task.agentState}`}>{agent}</span>}
          {task.estimateMinutes && <span>{formatMinutes(task.estimateMinutes)}</span>}
          {task.progress && (
            <button
              className="card-subs-toggle"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              tabIndex={overlay ? -1 : 0}
            >
              <span className="progress-pips" aria-hidden="true">
                {task.subtasks.map((s) => (
                  <i key={s.id} className={s.status === 'done' ? 'on' : undefined} />
                ))}
              </span>
              {task.progress.done}/{task.progress.total}
              <span className="visually-hidden"> subtasks done. {open ? 'Hide' : 'Show'} subtasks</span>
            </button>
          )}
          {meta}
        </div>
        {open && !overlay && (
          <ul className="card-subs">
            {task.subtasks.map((s) => (
              <li key={s.id}>
                <label className={s.status === 'done' ? 'is-done' : undefined}>
                  <input
                    type="checkbox"
                    checked={s.status === 'done'}
                    onChange={() => onToggleSubtask(s)}
                  />
                  <span>{s.title}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      {end}
      {onToggleToday && (
        <button
          className={`card-sun${task.today ? ' is-on' : ''}${later ? ' is-later' : ''}`}
          aria-pressed={Boolean(task.today)}
          aria-label={
            later
              ? `Planned for ${formatDay(later, { weekday: 'long' })}. Take it off the plan`
              : task.today
                ? `On Today (${task.today === 'main' ? 'main' : 'secondary'}). Take off Today`
                : 'Add to Today'
          }
          title={
            later
              ? `Planned for ${formatDay(later, { weekday: 'long', day: 'numeric', month: 'short' })}. Click to take it off`
              : task.today
                ? 'On Today. Click to take it off'
                : 'Add to Today'
          }
          onClick={() => onToggleToday(task)}
          tabIndex={overlay ? -1 : 0}
        >
          {later ? (
            <span className="card-sun-main">{formatDay(later, { weekday: 'short' })}</span>
          ) : (
            <>
              <SunIcon />
              {task.today === 'main' && <span className="card-sun-main">Main</span>}
            </>
          )}
        </button>
      )}
    </article>
  );
}

export function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
      </g>
    </svg>
  );
}

/**
 * A card that can be dragged within and between groups/bins (long press on touch), and swiped:
 * right to mark it done, left to start or pause it.
 */
export function SortableTaskCard(props: CardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.task.id,
  });
  const { onKeyDown, ...pointerListeners } = listeners ?? {};
  const working = isWorking(props.task);
  const swipe = useSwipe({
    enabled: !isDragging,
    onRight: () => props.onComplete(props.task),
    onLeft: () => props.onToggleWork(props.task),
  });
  const side = swipe.dx > 0 ? 'done' : 'work';

  return (
    <li
      ref={setNodeRef}
      className={`card-slot ${isDragging ? 'is-placeholder' : ''} ${swipe.dx ? 'is-swiping' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      aria-roledescription="draggable task"
      aria-label={`${props.task.title}. Press space to move.`}
      {...pointerListeners}
      {...swipe.handlers}
      // Keyboard drag only from the card itself, not when Enter/Space hits a button inside it.
      onKeyDown={(e: KeyboardEvent<HTMLLIElement>) => {
        if (e.target === e.currentTarget) onKeyDown?.(e);
      }}
    >
      {swipe.dx !== 0 && (
        <div className={`swipe-under swipe-${side}${swipe.past ? ' is-past' : ''}`} aria-hidden="true">
          <span className="swipe-label">{side === 'done' ? '✓ Done' : working ? '❚❚ Pause' : '▶ Start'}</span>
        </div>
      )}
      <div
        className={`card-swipe${swipe.settling ? ' is-settling' : ''}`}
        style={swipe.dx ? { transform: `translateX(${swipe.dx}px)` } : undefined}
      >
        <TaskCard {...props} />
      </div>
    </li>
  );
}
