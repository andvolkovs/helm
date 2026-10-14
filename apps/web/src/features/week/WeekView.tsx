import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  addDays,
  buildTree,
  formatDay,
  MAX_TODAY_MAIN,
  PRIORITIES,
  shortDay,
  shownDayOf,
  type Priority,
  type Project,
  type Task,
  type TaskNode,
  type TodaySlot,
} from '@helm/shared';
import { formatMinutes } from '../../lib/format.ts';
import { useAllProjects, useDoneLog, useSetToday, useTaskAction, useTasks } from '../../lib/queries.ts';
import { useCompleteTask } from '../../lib/useCompleteTask.ts';
import { useDeleteTask } from '../../lib/useDeleteTask.ts';
import { useToday } from '../../lib/useToday.ts';
import { KeyedTitle } from '../../ui/KeyedTitle.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { projectIcon } from '../board/project-icon.ts';
import { isWorking } from '../board/TaskCard.tsx';
import { useEditor } from '../task-editor/EditorContext.tsx';
import { PickSheet } from '../today/PickSheet.tsx';
import { PlanAdd } from '../today/PlanAdd.tsx';
import { carriedFrom } from '../today/today-model.ts';
import {
  donePlanned,
  loadText,
  mainFull,
  placement,
  startOfDayKey,
  unplanned,
  weekDays,
  weekPlan,
  weekRange,
  weekTitle,
  type DayPlan,
} from './week-model.ts';
import '../today/today.css';
import './week.css';

const VIEW_KEY = 'helm.week.view';
const BUDGET_KEY = 'helm.week.budget';
/** Day budgets to pick from, in minutes: 1 h to 10 h in half hours. */
const BUDGETS = Array.from({ length: 19 }, (_, i) => 60 + i * 30);
/** "By time": pixels per minute (an hour is 60 px), and the least a block is drawn. */
const PX_PER_MIN = 1;
const MIN_BLOCK = 26;
const PRIORITY_LABEL: Record<Priority, string> = { now: 'Now', soon: 'Soon', someday: 'Someday' };
/** How many unplanned tasks the shelf shows before "Show all". */
const SHELF_SHOWN = 10;

type View = 'cards' | 'time';
/** Where a card can be dropped. `keep`: a day in "By time", which keeps the task's slot. */
type Drop = { kind: 'day'; day: string; slot: TodaySlot | 'keep' } | { kind: 'shelf' };

/** A setting kept on this device. */
function usePref(key: string, fallback: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const set = (v: string) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      // Storage off: kept until reload.
    }
  };
  return [value, set];
}

/** Room for the whole week side by side. */
function useWide(): boolean {
  const query = '(min-width: 900px)';
  const [wide, setWide] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

const isWeekend = (day: string) => [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());

/** What a card can do. */
interface Acts {
  today: string;
  projectOf: (t: Task) => Project | undefined;
  edit: (t: Task) => void;
  complete: (t: Task) => void;
  reopen: (t: Task) => void;
  /** Open "Move to…" for it. */
  move: (t: TaskNode) => void;
}

/**
 * The week: each day's plan side by side (on a phone, a day at a time). Tasks are dragged onto
 * days from the shelf of unplanned ones or between days; finished days fold away so the width
 * goes to today and what's ahead. "By time" sizes tasks by their estimates against a day budget.
 */
export function WeekView() {
  const tasks = useTasks();
  const projects = useAllProjects();
  const today = useToday();
  const [offset, setOffset] = useState(0);
  const days = useMemo(() => weekDays(today, offset), [today, offset]);
  // From the start of the week, so finished days show what got done.
  const doneLog = useDoneLog({ from: startOfDayKey(days[0]!).toISOString() });
  const wide = useWide();
  const [viewPref, setView] = usePref(VIEW_KEY, 'cards');
  const view: View = viewPref === 'time' ? 'time' : 'cards';
  const [budgetPref, setBudget] = usePref(BUDGET_KEY, '240');
  const budget = BUDGETS.includes(Number(budgetPref)) ? Number(budgetPref) : 240;

  const setToday = useSetToday();
  const action = useTaskAction();
  const complete = useCompleteTask();
  const deleteTask = useDeleteTask();
  const editor = useEditor();
  const toast = useToast();

  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [moving, setMoving] = useState<TaskNode | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [priorities, setPriorities] = useState<ReadonlySet<Priority>>(new Set<Priority>(['now', 'soon']));
  const [dragging, setDragging] = useState<string | null>(null);

  const roots = useMemo(() => buildTree(tasks.data ?? []), [tasks.data]);
  const nodes = useMemo(() => new Map(roots.map((n) => [n.id, n])), [roots]);
  const done = useMemo(
    () => donePlanned(tasks.data ?? [], doneLog.data?.pages.flatMap((p) => p.tasks) ?? []),
    [tasks.data, doneLog.data],
  );
  const plan = useMemo(() => weekPlan(roots, done, days, today), [roots, done, days, today]);
  const shelf = useMemo(() => unplanned(roots, priorities), [roots, priorities]);
  const projectMap = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  if (tasks.isPending) return <main className="week" aria-busy="true" />;

  /** Any day's plan, also outside this week (for "Move to…"). */
  const planFor = (day: string): DayPlan => plan.find((d) => d.day === day) ?? weekPlan(roots, done, [day], today)[0]!;
  const nameOf = (day: string) =>
    day === today ? 'today' : day === addDays(today, 1) ? 'tomorrow' : formatDay(day, { weekday: 'long' });

  function place(t: Task, day: string, slot: TodaySlot | 'keep') {
    const to = placement(t, { day, slot }, today);
    if (!to) return;
    if (to.today === 'main' && mainFull(planFor(day), t.id)) {
      const Day = nameOf(day).replace(/^./, (c) => c.toUpperCase());
      toast({ message: `${Day}’s Main has ${MAX_TODAY_MAIN} already. Move one to Secondary first.` });
      return;
    }
    setToday.mutate({ id: t.id, ...to });
  }

  async function takeOff(t: TaskNode) {
    if (t.todayOnly) {
      // It lives only on the plan: taking it off deletes it (with Undo).
      try {
        await deleteTask(t);
      } catch (err) {
        toast({ message: `Couldn’t remove “${t.title}”: ${(err as Error).message}` });
      }
      return;
    }
    const was = t.today!;
    const wasDay = t.planDate ?? undefined;
    const home = t.projectId ? (projectMap.get(t.projectId)?.name ?? 'its project') : 'the Inbox';
    setToday.mutate(
      { id: t.id, today: null },
      {
        onSuccess: () =>
          toast({
            message: `Off the plan. Still in ${home}.`,
            action: { label: 'Undo', run: () => setToday.mutate({ id: t.id, today: was, planDate: wasDay }) },
          }),
      },
    );
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const t = nodes.get(String(e.active.id));
    const to = e.over?.data.current as Drop | undefined;
    if (!t || !to) return;
    if (to.kind === 'shelf') {
      if (t.today) void takeOff(t);
    } else {
      place(t, to.day, to.slot);
    }
  }

  const acts: Acts = {
    today,
    projectOf: (t) => (t.projectId ? projectMap.get(t.projectId) : undefined),
    edit: (t) => editor.openEdit(t.id),
    complete: (t) => void complete(t),
    reopen: (t) => action.mutate({ id: t.id, action: 'reopen' }),
    move: setMoving,
  };

  // The week at a glance, for the header.
  const ahead = plan.filter((d) => !d.past);
  const open = ahead.reduce((n, d) => n + d.main.length + d.side.length, 0);
  const doneCount = plan.reduce((n, d) => n + d.done.length, 0);
  const left = ahead.reduce((n, d) => n + d.minutes, 0);
  const over = ahead.filter((d) => d.minutes > budget);
  const overText =
    over.length === 1
      ? `${nameOf(over[0]!.day).replace(/^./, (c) => c.toUpperCase())} is over ${formatMinutes(budget)}`
      : over.length > 1
        ? `${over.length} days are over ${formatMinutes(budget)}`
        : null;

  const sel = selected && days.includes(selected) ? selected : days.includes(today) ? today : days[0]!;
  const folded = (d: DayPlan) => offset === 0 && d.past && !expanded.has(d.day);
  const columns = plan
    .map((d) =>
      folded(d)
        ? '4.75rem'
        : d.isToday
          ? 'minmax(0, 1.5fr)'
          : d.past
            ? 'minmax(0, 1fr)'
            : isWeekend(d.day)
              ? 'minmax(0, 0.85fr)'
              : 'minmax(0, 1.15fr)',
    )
    .join(' ');
  const dragTask = dragging ? nodes.get(dragging) : undefined;

  const dayProps = (d: DayPlan) => ({
    d,
    acts,
    budget,
    adding: adding === d.day,
    dayName: nameOf(d.day),
    onAdd: () => setAdding(d.day),
    onCloseAdd: () => setAdding(null),
    onPick: () => setPicking(d.day),
    projects: projects.data ?? [],
  });

  return (
    <main className={`week${wide ? ' is-wide' : ''}`}>
      <header className="wk-head">
        <div>
          <h1 className="today-title">{weekTitle(offset, days)}</h1>
          <p className="today-date">{weekRange(days)}</p>
        </div>
        <div className="wk-nav">
          <button type="button" className="icon-btn" aria-label="Previous week" onClick={() => setOffset((o) => o - 1)}>
            ‹
          </button>
          <button type="button" className="wk-nav-today" disabled={offset === 0} onClick={() => setOffset(0)}>
            This week
          </button>
          <button type="button" className="icon-btn" aria-label="Next week" onClick={() => setOffset((o) => o + 1)}>
            ›
          </button>
        </div>
        {wide && (
          <div className="wk-tools">
            <div className="wk-seg" role="group" aria-label="Show tasks">
              <button type="button" aria-pressed={view === 'cards'} onClick={() => setView('cards')}>
                Cards
              </button>
              <button type="button" aria-pressed={view === 'time'} onClick={() => setView('time')}>
                By time
              </button>
            </div>
            <label className="wk-budget">
              Day budget
              <select value={budget} onChange={(e) => setBudget(e.target.value)}>
                {BUDGETS.map((m) => (
                  <option key={m} value={m}>
                    {formatMinutes(m)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {open + doneCount > 0 && (
          <p className="today-progress wk-sum">
            <b>
              {doneCount} of {open + doneCount} done
            </b>
            <span>
              {left ? `About ${formatMinutes(left)} left` : open ? 'No estimates' : 'All clear'}
              {overText && <em> · {overText}</em>}
            </span>
          </p>
        )}
      </header>

      {wide ? (
        <DndContext
          sensors={sensors}
          onDragStart={(e) => setDragging(String(e.active.id))}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          <div className={`wk-grid is-${view}`} style={{ gridTemplateColumns: columns }}>
            {plan.map((d) =>
              folded(d) ? (
                <Sliver key={d.day} d={d} onOpen={() => setExpanded((s) => new Set(s).add(d.day))} />
              ) : (
                <DayColumn
                  key={d.day}
                  {...dayProps(d)}
                  view={view}
                  dragging={dragTask}
                  onFold={offset === 0 && d.past ? () => setExpanded((s) => new Set([...s].filter((x) => x !== d.day))) : undefined}
                />
              ),
            )}
          </div>
          <Shelf
            tasks={shelf}
            acts={acts}
            priorities={priorities}
            onPriorities={setPriorities}
            dragging={Boolean(dragTask?.today)}
          />
          <DragOverlay dropAnimation={null}>
            {dragTask ? <CardBody task={dragTask} acts={acts} overlay /> : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <>
          <DayStrip plan={plan} selected={sel} onSelect={setSelected} />
          <PhoneDay {...dayProps(plan.find((d) => d.day === sel)!)} />
        </>
      )}

      {moving && (
        <MoveSheet
          task={moving}
          today={today}
          planFor={planFor}
          onPlace={place}
          onTakeOff={(t) => void takeOff(t)}
          onClose={() => setMoving(null)}
        />
      )}
      {picking && (
        <PickSheet
          roots={roots}
          day={picking}
          today={today}
          mainFull={mainFull(planFor(picking))}
          onClose={() => setPicking(null)}
        />
      )}
    </main>
  );
}

// ---------- Days ----------

interface DayProps {
  d: DayPlan;
  acts: Acts;
  budget: number;
  dayName: string;
  adding: boolean;
  projects: Project[];
  onAdd: () => void;
  onCloseAdd: () => void;
  onPick: () => void;
}

function dayHeading(d: DayPlan, today: string): { name: string; date: string } {
  if (d.isToday) return { name: 'Today', date: `☀ ${shortDay(d.day)}` };
  const tomorrow = d.day === addDays(today, 1);
  return {
    name: formatDay(d.day, { weekday: 'short' }),
    date: `${formatDay(d.day, { day: 'numeric', month: 'short' })}${tomorrow ? ' · tomorrow' : ''}`,
  };
}

function Load({ d, budget }: { d: DayPlan; budget: number }) {
  const { text, over } = loadText(d, budget, formatMinutes);
  return (
    <div className={`wk-load${over ? ' is-over' : ''}`}>
      <div className="wk-load-bar" role="presentation">
        <i style={{ width: `${Math.min(1, d.minutes / budget) * 100}%` }} />
      </div>
      <span>{text}</span>
    </div>
  );
}

/** A day of the desktop week: its Main and Secondary lists as drop zones, or blocks sized by time. */
function DayColumn({
  view,
  dragging,
  onFold,
  ...p
}: DayProps & { view: View; dragging: TaskNode | undefined; onFold?: () => void }) {
  const { d, acts } = p;
  const head = dayHeading(d, acts.today);
  const weekend = isWeekend(d.day);
  // A dragged task that isn't in Main here yet can't go into a full Main.
  const mainClosed = Boolean(dragging) && mainFull(d, dragging?.id) && !d.main.some((t) => t.id === dragging?.id);

  return (
    <section
      className={`wk-day${d.isToday ? ' is-today' : ''}${d.past ? ' is-past' : ''}${weekend ? ' is-weekend' : ''}`}
      aria-label={formatDay(d.day, { weekday: 'long', day: 'numeric', month: 'long' })}
    >
      <header className="wk-day-head">
        <h2 className="wk-day-name">{head.name}</h2>
        <span className="wk-day-date">{head.date}</span>
        {onFold && (
          <button type="button" className="wk-fold" onClick={onFold} aria-label="Fold this day">
            ‹
          </button>
        )}
      </header>
      {!d.past && <Load d={d} budget={p.budget} />}

      {d.past ? (
        <PastList d={d} acts={acts} />
      ) : view === 'time' ? (
        <TimeBlocks d={d} acts={acts} budget={p.budget} />
      ) : (
        <>
          <Zone day={d.day} slot="main" closed={mainClosed}>
            <span className="wk-zone-label is-main">
              Main · {d.main.length} / {MAX_TODAY_MAIN}
            </span>
            {d.main.map((t, i) => (
              <WeekCard key={t.id} task={t} number={i + 1} acts={acts} />
            ))}
          </Zone>
          <Zone day={d.day} slot="side">
            <span className="wk-zone-label">Secondary</span>
            {d.side.map((t) => (
              <WeekCard key={t.id} task={t} acts={acts} />
            ))}
          </Zone>
          {d.done.length > 0 && <DoneList tasks={d.done} acts={acts} />}
        </>
      )}

      {!d.past &&
        (p.adding ? (
          <PlanAdd
            day={d.day}
            dayName={p.dayName}
            mainFull={mainFull(d)}
            mainEmpty={d.main.length === 0}
            projects={p.projects}
            compact
            autoFocus
            onClose={p.onCloseAdd}
          />
        ) : (
          <div className="wk-day-foot">
            <button type="button" className="wk-add" onClick={p.onAdd}>
              + Add
            </button>
            <button type="button" className="wk-add" onClick={p.onPick}>
              Pick…
            </button>
          </div>
        ))}
    </section>
  );
}

/** A finished day, folded to its tally. Opens to show what got done. */
function Sliver({ d, onOpen }: { d: DayPlan; onOpen: () => void }) {
  const total = d.done.length + d.movedOn;
  return (
    <button
      type="button"
      className="wk-sliver"
      onClick={onOpen}
      aria-label={`${formatDay(d.day, { weekday: 'long' })}: ${d.done.length} of ${total} done. Show`}
    >
      <span className="wk-day-name">{formatDay(d.day, { weekday: 'short' })}</span>
      <span className="wk-sliver-date">{formatDay(d.day, { day: 'numeric' })}</span>
      {total > 0 ? (
        <>
          <b className="wk-sliver-count">{d.done.length}</b>
          <small>of {total} done</small>
          <span className="wk-ticks" aria-hidden="true">
            {Array.from({ length: Math.min(total, 8) }, (_, i) => (
              <i key={i} className={i < d.done.length ? undefined : 'is-moved'} />
            ))}
          </span>
          {d.movedOn > 0 && <small className="wk-moved">{d.movedOn} moved on</small>}
        </>
      ) : (
        <small>Nothing planned</small>
      )}
    </button>
  );
}

function PastList({ d, acts }: { d: DayPlan; acts: Acts }) {
  return (
    <>
      {d.done.length > 0 ? <DoneList tasks={d.done} acts={acts} /> : <p className="wk-free">Nothing done here</p>}
      {d.movedOn > 0 && (
        <p className="wk-moved">
          {d.movedOn} unfinished {d.movedOn === 1 ? 'task' : 'tasks'} moved on to today
        </p>
      )}
    </>
  );
}

function DoneList({ tasks, acts }: { tasks: Task[]; acts: Acts }) {
  return (
    <ul className="wk-done">
      {tasks.map((t) => (
        <li key={t.id}>
          <button className="wk-done-check" aria-label={`Not done: ${t.title}`} title="Not done after all" onClick={() => acts.reopen(t)}>
            ✓
          </button>
          <button className="wk-done-title" onClick={() => acts.edit(t)}>
            {t.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** "By time": each task as tall as its estimate, a line at the day budget, and what's past it hatched. */
function TimeBlocks({ d, acts, budget }: { d: DayPlan; acts: Acts; budget: number }) {
  const tasks = [...d.main, ...d.side];
  const height = (t: Task) => Math.max(MIN_BLOCK, (t.estimateMinutes ?? 0) * PX_PER_MIN);
  const used = tasks.reduce((n, t) => n + height(t) + 3, 0);
  const cap = budget * PX_PER_MIN;
  return (
    <Zone day={d.day} slot="keep" className="wk-time" style={{ minHeight: Math.max(cap + 60, used + 40) }}>
      <div className="wk-cap" style={{ top: cap }} aria-hidden="true">
        <span>{formatMinutes(budget)}</span>
      </div>
      {d.minutes > budget && <div className="wk-over" style={{ top: cap }} aria-hidden="true" />}
      {tasks.map((t) => (
        <WeekCard
          key={t.id}
          task={t}
          number={t.today === 'main' ? d.main.indexOf(t as TaskNode) + 1 : undefined}
          acts={acts}
          block={height(t)}
        />
      ))}
      {tasks.length === 0 && <p className="wk-free">Nothing planned</p>}
    </Zone>
  );
}

function Zone({
  day,
  slot,
  closed = false,
  className,
  style,
  children,
}: {
  day: string;
  slot: TodaySlot | 'keep';
  closed?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const data: Drop = { kind: 'day', day, slot };
  const { setNodeRef, isOver } = useDroppable({ id: `${day}:${slot}`, data, disabled: closed });
  return (
    <div
      ref={setNodeRef}
      className={`wk-zone${isOver ? ' is-over' : ''}${closed ? ' is-closed' : ''}${className ? ` ${className}` : ''}`}
      style={style}
    >
      {children}
    </div>
  );
}

// ---------- Cards ----------

/** A card that can be dragged to another day, or back to the shelf. */
function WeekCard({ task, number, acts, block }: { task: TaskNode; number?: number; acts: Acts; block?: number }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: task.id });
  return (
    <div ref={setNodeRef} {...listeners} className={`wk-drag${isDragging ? ' is-dragging' : ''}`}>
      <CardBody task={task} number={number} acts={acts} block={block} />
    </div>
  );
}

function CardBody({
  task,
  number,
  acts,
  block,
  overlay = false,
}: {
  task: TaskNode;
  number?: number;
  acts: Acts;
  /** "By time": the block's height in px. */
  block?: number;
  overlay?: boolean;
}) {
  const project = acts.projectOf(task);
  const shown = shownDayOf(task, acts.today);
  const carried = shown === acts.today ? carriedFrom(task, startOfDayKey(acts.today)) : null;
  const working = isWorking(task);
  const tab = overlay ? -1 : 0;
  const cls = [
    'wk-card',
    task.today === 'main' && 'is-main',
    working && 'is-working',
    block !== undefined && 'is-block',
    block !== undefined && !task.estimateMinutes && 'is-unsized',
    overlay && 'is-overlay',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={cls} style={block !== undefined ? { height: block } : undefined}>
      {number !== undefined && (
        <span className="wk-num" aria-hidden="true">
          {number}
        </span>
      )}
      {block === undefined && (
        <button className="wk-check" aria-label={`Mark done: ${task.title}`} onClick={() => acts.complete(task)} tabIndex={tab} />
      )}
      <div className="wk-card-body">
        <button className="wk-card-title" onClick={() => acts.edit(task)} tabIndex={tab}>
          <KeyedTitle title={task.title} words={task.keyWords} />
        </button>
        <div className="wk-card-meta">
          {working && <span className="wk-live">In progress</span>}
          {task.estimateMinutes ? <span>{formatMinutes(task.estimateMinutes)}</span> : block !== undefined && <span>no estimate</span>}
          {block === undefined &&
            (task.todayOnly ? (
              <span className="today-only">Plan only</span>
            ) : (
              <span className="wk-where">{project ? `${projectIcon(project)} ${project.name}` : 'Inbox'}</span>
            ))}
          {carried && <span className="today-carried">from {carried}</span>}
        </div>
      </div>
      <button className="wk-more" aria-label={`Move: ${task.title}`} title="Move to another day" onClick={() => acts.move(task)} tabIndex={tab}>
        ⋯
      </button>
    </article>
  );
}

// ---------- Shelf of unplanned tasks ----------

function Shelf({
  tasks,
  acts,
  priorities,
  onPriorities,
  dragging,
}: {
  tasks: TaskNode[];
  acts: Acts;
  priorities: ReadonlySet<Priority>;
  onPriorities: (p: ReadonlySet<Priority>) => void;
  /** A planned task is being dragged: the shelf takes it off the plan. */
  dragging: boolean;
}) {
  const [all, setAll] = useState(false);
  const data: Drop = { kind: 'shelf' };
  const { setNodeRef, isOver } = useDroppable({ id: 'shelf', data });
  const shown = all ? tasks : tasks.slice(0, SHELF_SHOWN);
  const toggle = (p: Priority) => {
    const next = new Set(priorities);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    onPriorities(next);
  };

  return (
    <section ref={setNodeRef} className={`wk-shelf${isOver ? ' is-over' : ''}${dragging ? ' is-target' : ''}`} aria-labelledby="wk-shelf-h">
      <header className="wk-shelf-head">
        <h2 id="wk-shelf-h">
          Not planned <span className="today-count">{tasks.length}</span>
        </h2>
        <div className="wk-filters" role="group" aria-label="Priorities">
          {PRIORITIES.map((p) => (
            <button key={p} type="button" aria-pressed={priorities.has(p)} onClick={() => toggle(p)}>
              {PRIORITY_LABEL[p]}
            </button>
          ))}
        </div>
        <span className="wk-shelf-hint">{dragging ? 'Drop here to take it off the plan' : 'Drag onto a day'}</span>
      </header>
      {tasks.length === 0 ? (
        <p className="wk-free">{priorities.size ? 'Everything here has a day.' : 'Pick a priority to see tasks.'}</p>
      ) : (
        <div className="wk-shelf-list">
          {shown.map((t) => (
            <WeekCard key={t.id} task={t} acts={acts} />
          ))}
        </div>
      )}
      {tasks.length > SHELF_SHOWN && (
        <button type="button" className="wk-add wk-shelf-more" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${tasks.length}`}
        </button>
      )}
    </section>
  );
}

// ---------- Phone ----------

function DayStrip({ plan, selected, onSelect }: { plan: DayPlan[]; selected: string; onSelect: (day: string) => void }) {
  return (
    <div className="wk-strip" role="group" aria-label="Days">
      {plan.map((d) => {
        const dots = [...d.main.map(() => 'm'), ...d.side.map(() => 's')].slice(0, 5);
        return (
          <button
            key={d.day}
            type="button"
            className={`wk-strip-day${d.isToday ? ' is-today' : ''}${d.past ? ' is-past' : ''}`}
            aria-pressed={d.day === selected}
            aria-label={`${formatDay(d.day, { weekday: 'long' })} ${formatDay(d.day, { day: 'numeric' })}: ${d.main.length + d.side.length} planned`}
            onClick={() => onSelect(d.day)}
          >
            <span>{formatDay(d.day, { weekday: 'narrow' })}</span>
            <b>{formatDay(d.day, { day: 'numeric' })}</b>
            <span className="wk-dots" aria-hidden="true">
              {dots.map((k, i) => (
                <i key={i} className={k === 'm' ? 'is-main' : undefined} />
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A day at a time on a phone, laid out like Today. Cards move with ⋯ instead of dragging. */
function PhoneDay(p: DayProps) {
  const { d, acts } = p;
  const name = d.isToday ? 'Today' : formatDay(d.day, { weekday: 'long' });
  const tomorrow = d.day === addDays(acts.today, 1);
  return (
    <section className="wk-phone-day" aria-label={formatDay(d.day, { weekday: 'long', day: 'numeric', month: 'long' })}>
      <header className="wk-phone-head">
        <div>
          <h2 className="wk-phone-name">{name}</h2>
          <p className="today-date">
            {formatDay(d.day, { day: 'numeric', month: 'long' })}
            {tomorrow ? ' · tomorrow' : ''}
          </p>
        </div>
      </header>
      {d.past ? (
        <PastList d={d} acts={acts} />
      ) : (
        <>
          <Load d={d} budget={p.budget} />
          <section className="today-section today-main">
            <h3 className="today-label">
              Main{' '}
              <span className="today-count">
                {d.main.length} / {MAX_TODAY_MAIN}
              </span>
            </h3>
            {d.main.length ? (
              <ol className="wk-list">
                {d.main.map((t, i) => (
                  <li key={t.id}>
                    <CardBody task={t} number={i + 1} acts={acts} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="today-empty">Up to three things that would make {p.dayName} a good day.</p>
            )}
          </section>
          <section className="today-section">
            <h3 className="today-label">
              Secondary <span className="today-count">{d.side.length}</span>
            </h3>
            {d.side.length ? (
              <ul className="wk-list">
                {d.side.map((t) => (
                  <li key={t.id}>
                    <CardBody task={t} acts={acts} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="today-empty">If there’s time.</p>
            )}
          </section>
          <PlanAdd
            key={d.day}
            day={d.day}
            dayName={p.dayName}
            mainFull={mainFull(d)}
            mainEmpty={d.main.length === 0}
            projects={p.projects}
          />
          <button type="button" className="btn today-pick" onClick={p.onPick}>
            Pick from the board
          </button>
          {d.done.length > 0 && (
            <>
              <h3 className="today-label">Done</h3>
              <DoneList tasks={d.done} acts={acts} />
            </>
          )}
        </>
      )}
    </section>
  );
}

// ---------- Move to another day ----------

/** "Move to…": Main or Secondary, then a day (today and the week after), or off the plan. */
function MoveSheet({
  task,
  today,
  planFor,
  onPlace,
  onTakeOff,
  onClose,
}: {
  task: TaskNode;
  today: string;
  planFor: (day: string) => DayPlan;
  onPlace: (t: Task, day: string, slot: TodaySlot) => void;
  onTakeOff: (t: TaskNode) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [slot, setSlot] = useState<TodaySlot>(task.today ?? 'side');
  const current = shownDayOf(task, today);
  const options = Array.from({ length: 8 }, (_, i) => addDays(today, i));

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  }, []);
  const close = () => dialogRef.current?.close();

  return (
    <dialog
      ref={dialogRef}
      className="today-sheet wk-move"
      aria-labelledby="wk-move-h"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) close(); // backdrop
      }}
    >
      <header className="today-sheet-head">
        <h2 id="wk-move-h">
          {task.today ? 'Move' : 'Plan'} “{task.title}”
        </h2>
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
      </header>
      <div className="wk-move-body">
        <div className="wk-seg" role="group" aria-label="Main or Secondary">
          <button type="button" aria-pressed={slot === 'main'} onClick={() => setSlot('main')}>
            Main
          </button>
          <button type="button" aria-pressed={slot === 'side'} onClick={() => setSlot('side')}>
            Secondary
          </button>
        </div>
        <div className="wk-move-days">
          {options.map((day, i) => {
            const d = planFor(day);
            const full = slot === 'main' && mainFull(d, task.id);
            const here = day === current && slot === task.today;
            const count = d.main.length + d.side.length;
            const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : shortDay(day);
            return (
              <button
                key={day}
                type="button"
                className={`wk-move-day${day === today ? ' is-today' : ''}`}
                disabled={full || here}
                onClick={() => {
                  onPlace(task, day, slot);
                  close();
                }}
              >
                <b>{label}</b>
                <span>
                  {here
                    ? 'It’s here'
                    : full
                      ? 'Main is full'
                      : count
                        ? `${count} · ${d.minutes ? formatMinutes(d.minutes) : 'no estimates'}`
                        : 'Free'}
                </span>
              </button>
            );
          })}
        </div>
        {task.today && (
          <button
            type="button"
            className="btn wk-move-off"
            onClick={() => {
              onTakeOff(task);
              close();
            }}
          >
            {task.todayOnly ? 'Remove it' : 'Take it off the plan'}
          </button>
        )}
      </div>
    </dialog>
  );
}
