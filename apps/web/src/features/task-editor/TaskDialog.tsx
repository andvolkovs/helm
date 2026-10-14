import { useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  MAX_TODAY_MAIN,
  PRIORITIES,
  shortDay,
  shownDayOf,
  parseQuickAdd,
  projectCandidates,
  type Priority,
  type Project,
  type Task,
  type TodaySlot,
} from '@helm/shared';
import { api, ApiError } from '../../lib/api.ts';
import { formatMinutes } from '../../lib/format.ts';
import { upsertTask, useCreateProject, useProjects, useSetAgentState, useTaskAction, useTasks } from '../../lib/queries.ts';
import { hrefFor } from '../../lib/route.ts';
import { useDeleteTask } from '../../lib/useDeleteTask.ts';
import { useToday } from '../../lib/useToday.ts';
import { LineInput } from '../../ui/LineInput.tsx';
import { agentName } from '../board/agent-badge.ts';
import { projectIcon } from '../board/project-icon.ts';
import type { EditorTarget } from './EditorContext.tsx';
import { createFromDraft, draftFrom, draftFromSuggestion, saveDraft, type SubtaskDraft, type TaskDraft } from './save.ts';
import './editor.css';

const PRIORITY_LABEL: Record<Priority, string> = { now: 'Now', soon: 'Soon', someday: 'Someday' };
const ESTIMATES = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
const TODAY_CHOICES: [TodaySlot | null, string][] = [
  [null, 'No'],
  ['main', 'Main'],
  ['side', 'Secondary'],
];
const OTHER = '__other__';
/** Transcripts longer than this are cut to two lines until expanded. */
const LONG_TRANSCRIPT = 120;

let keySeq = 0;
const newSub = (): SubtaskDraft => ({ key: `new-${++keySeq}`, title: '', done: false });

interface Props {
  target: EditorTarget;
  /** Voice drafts waiting after this one. */
  queued: number;
  /** `next` = saved or skipped (show the next queued draft); otherwise close everything. */
  onClose: (next: boolean) => void;
}

export function TaskDialog({ target, queued, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();
  const deleteTask = useDeleteTask();
  const tasks = useTasks();
  const projects = useProjects();
  const createProject = useCreateProject();
  const ids = { title: useId(), notes: useId(), estimate: useId(), priority: useId(), today: useId() };

  const editing: Task | undefined =
    target.mode === 'edit' ? tasks.data?.find((t) => t.id === target.taskId && !t.deletedAt) : undefined;
  // The task as it was when the dialog opened: Save sends only what the user changed since.
  const [opened] = useState(editing);
  const originalSubs = useMemo(
    () => (editing ? (tasks.data ?? []).filter((t) => t.parentTaskId === editing.id && !t.deletedAt) : []),
    // Snapshot at open: later live updates shouldn't clobber what's being typed.
    [editing?.id],
  );
  const parentId = target.mode === 'create' ? target.defaults.parentTaskId : editing?.parentTaskId ?? undefined;
  const parent = parentId ? tasks.data?.find((t) => t.id === parentId) : undefined;
  const isSubtask = Boolean(parentId);
  const voice = target.mode === 'create' ? target.defaults.voice : undefined;

  const [draft, setDraft] = useState<TaskDraft>(() =>
    editing
      ? draftFrom(editing, originalSubs)
      : voice
        ? draftFromSuggestion(voice.suggestion)
        : {
            title: target.mode === 'create' ? (target.defaults.title ?? '') : '',
            notes: '',
            projectId: target.mode === 'create' ? (target.defaults.projectId ?? null) : null,
            priority: target.mode === 'create' ? (target.defaults.priority ?? 'soon') : 'soon',
            estimateMinutes: null,
            subtasks: [],
            agentReady: false,
            today: target.mode === 'create' ? (target.defaults.today ?? null) : null,
          },
  );
  const [unmatchedProject, setUnmatchedProject] = useState<string | null>(voice?.suggestion.unmatchedProject ?? null);
  // A heard or typed name that fits several projects: offer them rather than guess.
  const [projectChoices, setProjectChoices] = useState<{ id: string; name: string }[]>(
    voice?.suggestion.projectChoices ?? [],
  );
  const [newProjectName, setNewProjectName] = useState<string | null>(null);
  const [customEstimate, setCustomEstimate] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Subtask row to focus after the next render (set when rows are added/removed by keyboard).
  const [focusSub, setFocusSub] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!focusSub) return;
    document.getElementById(`sub-${focusSub}`)?.focus();
    setFocusSub(null);
  }, [focusSub]);

  const set = <K extends keyof TaskDraft>(k: K, v: TaskDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  // The day it's on: today, or the later day it's planned for.
  const today = useToday();
  const planDay = (editing && shownDayOf(editing, today)) || today;
  const dayLabel = planDay === today ? 'Today' : shortDay(planDay);
  // Main holds a few tasks a day; this one doesn't count against itself.
  const mainFull =
    (tasks.data ?? []).filter(
      (t) => t.today === 'main' && t.status !== 'done' && !t.deletedAt && t.id !== editing?.id && shownDayOf(t, today) === planDay,
    ).length >= MAX_TODAY_MAIN;
  const parsed = parseQuickAdd(draft.title);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    titleRef.current?.focus();
  }, []);

  // Tell the parent directly; the native `close` event (kept for Escape) can arrive late or not at
  // at all. Only once: a second call would skip a queued draft.
  const closed = useRef(false);
  const close = (next = false) => {
    if (closed.current) return;
    closed.current = true;
    dialogRef.current?.close();
    onClose(next);
  };

  // The task was deleted elsewhere while open.
  useEffect(() => {
    if (target.mode === 'edit' && tasks.data && !editing) close();
  });

  function onTitleChange(raw: string) {
    const q = parseQuickAdd(raw);
    const hits = q.projectQuery && !isSubtask ? projectCandidates(q.projectQuery, projects.data ?? []) : [];
    setDraft((d) => {
      const next = { ...d, title: raw };
      if (q.priority) next.priority = q.priority;
      if (q.estimateMinutes) next.estimateMinutes = q.estimateMinutes;
      if (hits.length === 1) next.projectId = hits[0]!.id;
      return next;
    });
    setUnmatchedProject(q.projectQuery && hits.length === 0 ? q.projectQuery : null);
    setProjectChoices(hits.length > 1 ? hits : []);
  }

  async function addProject(name: string) {
    const p = await createProject.mutateAsync({ name });
    set('projectId', p.id);
    setUnmatchedProject(null);
    setNewProjectName(null);
  }

  function updateSub(key: string, patch: Partial<SubtaskDraft>) {
    set(
      'subtasks',
      draft.subtasks.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    );
  }

  function addSubAfter(key?: string) {
    const fresh = newSub();
    const i = key ? draft.subtasks.findIndex((s) => s.key === key) : -1;
    const subs = draft.subtasks.slice();
    subs.splice(i === -1 ? subs.length : i + 1, 0, fresh);
    set('subtasks', subs);
    setFocusSub(fresh.key);
  }

  function onSubKeyDown(e: KeyboardEvent<HTMLTextAreaElement>, s: SubtaskDraft) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSubAfter(s.key);
    } else if (e.key === 'Backspace' && s.title === '') {
      e.preventDefault();
      const i = draft.subtasks.findIndex((x) => x.key === s.key);
      set(
        'subtasks',
        draft.subtasks.filter((x) => x.key !== s.key),
      );
      const prev = draft.subtasks[i - 1];
      if (prev) setFocusSub(prev.key);
    }
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const title = parsed.title.trim();
    if (!title) {
      setError('Give the task a title.');
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const final = { ...draft, title };
      if (editing) {
        await saveDraft(opened ?? editing, editing, originalSubs, final);
      } else {
        upsertTask(qc, await createFromDraft(final, parentId, voice ? 'voice' : undefined));
      }
      close(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save. Check that the server is running.');
    } finally {
      setBusy(false);
    }
  }

  // One tap: the toast that follows offers Undo.
  async function remove() {
    if (!editing) return;
    setBusy(true);
    try {
      await deleteTask(editing);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t delete.');
      setBusy(false);
    }
  }

  const heading = editing
    ? isSubtask
      ? 'Edit subtask'
      : 'Edit task'
    : isSubtask
      ? 'New subtask'
      : voice
        ? voice.total > 1
          ? `Task from voice, ${voice.index} of ${voice.total}`
          : 'Task from voice'
        : 'New task';
  const cancelLabel = queued ? 'Skip' : 'Cancel';
  const submitLabel = editing ? 'Save' : isSubtask ? 'Add subtask' : 'Add task';
  const estimateIsCustom = draft.estimateMinutes !== null && !ESTIMATES.includes(draft.estimateMinutes);

  return (
    <dialog
      ref={dialogRef}
      className="editor"
      aria-labelledby="editor-heading"
      onClose={() => close()}
      onClick={(e) => {
        if (e.target === dialogRef.current) close(); // backdrop click
      }}
    >
      <form
        className="editor-form"
        // Not a form Chrome should fill: no password, card or address bar above the keyboard.
        autoComplete="off"
        onSubmit={submit}
        onKeyDown={(e) => {
          // Enter already submits from one-line fields; Ctrl/Cmd+Enter adds that for the notes.
          if (e.defaultPrevented) return;
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target instanceof HTMLTextAreaElement) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        {/* On phones Cancel and Add sit up here, above the keyboard; the footer ones are hidden. */}
        <header className="editor-head">
          <button type="button" className="btn btn-quiet editor-head-btn" onClick={() => close(true)}>
            {cancelLabel}
          </button>
          <h2 id="editor-heading">{heading}</h2>
          <button type="submit" className="btn btn-primary editor-head-btn" disabled={busy}>
            {submitLabel}
          </button>
          <button type="button" className="icon-btn editor-close" aria-label="Close" onClick={() => close()}>
            ✕
          </button>
        </header>

        {parent && <p className="editor-parent">Part of {parent.title}</p>}
        {voice && (
          <div className="editor-voice">
            {voice.transcript.length > LONG_TRANSCRIPT ? (
              // Long recordings show two lines; tap to read it all.
              <button
                type="button"
                className={`editor-voice-said${transcriptOpen ? '' : ' is-clamped'}`}
                aria-expanded={transcriptOpen}
                title={transcriptOpen ? undefined : 'Show all'}
                onClick={() => setTranscriptOpen((o) => !o)}
              >
                <span className="editor-voice-label">You said</span> <q>{voice.transcript}</q>
              </button>
            ) : (
              <p>
                <span className="editor-voice-label">You said</span> <q>{voice.transcript}</q>
              </p>
            )}
            {voice.notice ? (
              <p className="editor-voice-note">{voice.notice}</p>
            ) : (
              !voice.parsed && (
                <p className="editor-voice-note">
                  What you said is the title. Add an OpenAI key to have Helm fill in the project, priority and
                  estimate.
                </p>
              )
            )}
          </div>
        )}

        <div className="field">
          {/* Not labelled "Title": Chrome reads that as a name prefix (Mr, Ms) and offers addresses. */}
          <label htmlFor={ids.title} className="visually-hidden">
            What needs doing
          </label>
          <LineInput
            id={ids.title}
            ref={titleRef}
            className="editor-title"
            value={draft.title}
            onValueChange={onTitleChange}
            placeholder="What needs doing?"
            maxLength={500}
          />
          {parsed.title !== draft.title.trim() && parsed.title && (
            <p className="field-hint">Saves as “{parsed.title}”</p>
          )}
          {!draft.title && !editing && !voice && (
            <p className="field-hint">Shorthand works here: #project, !now, ~30m</p>
          )}
          {projectChoices.length > 0 && (
            <p className="field-hint">
              Which project?{' '}
              {projectChoices.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && ' or '}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      set('projectId', p.id);
                      setProjectChoices([]);
                    }}
                  >
                    {p.name}
                  </button>
                </span>
              ))}
            </p>
          )}
          {unmatchedProject && (
            <p className="field-hint">
              No project matches “{unmatchedProject}”.{' '}
              <button type="button" className="link-btn" onClick={() => addProject(unmatchedProject)}>
                Create project “{unmatchedProject}”
              </button>
            </p>
          )}
        </div>

        {!isSubtask && (
          <div className="field">
            {newProjectName === null ? (
              <ProjectPicker
                projects={projects.data ?? []}
                value={draft.projectId}
                onChange={(id) => set('projectId', id)}
                onNew={() => setNewProjectName('')}
              />
            ) : (
              <div className="inline-new">
                <LineInput
                  aria-label="New project name"
                  autoFocus
                  placeholder="New project"
                  value={newProjectName}
                  onValueChange={setNewProjectName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (newProjectName.trim()) void addProject(newProjectName.trim());
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setNewProjectName(null);
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={!newProjectName.trim() || createProject.isPending}
                  onClick={() => addProject(newProjectName.trim())}
                >
                  Create
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => setNewProjectName(null)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}

        <div className="field editor-inline" role="radiogroup" aria-labelledby={ids.priority}>
          <span id={ids.priority} className="editor-inline-label">
            Priority
          </span>
          <div className="segmented">
            {PRIORITIES.map((p) => (
              <label key={p} className={`seg seg-${p}`}>
                <input
                  type="radio"
                  name="priority"
                  value={p}
                  checked={draft.priority === p}
                  onChange={() => set('priority', p)}
                />
                <span>{PRIORITY_LABEL[p]}</span>
              </label>
            ))}
          </div>
        </div>

        {!isSubtask && editing?.status !== 'done' && (
          <div className="field editor-inline" role="radiogroup" aria-labelledby={ids.today}>
            <span id={ids.today} className="editor-inline-label">
              {dayLabel}
            </span>
            <div className="segmented">
              {TODAY_CHOICES.map(([value, label]) => {
                const blocked = value === 'main' && mainFull && draft.today !== 'main';
                return (
                  <label
                    key={label}
                    className={`seg seg-today-${value ?? 'no'}`}
                    title={blocked ? `Main has ${MAX_TODAY_MAIN} already` : undefined}
                  >
                    <input
                      type="radio"
                      name="today"
                      checked={draft.today === value}
                      disabled={blocked}
                      onChange={() => set('today', value)}
                    />
                    <span>{label}</span>
                  </label>
                );
              })}
            </div>
            {editing?.todayOnly && !draft.today && <p className="field-hint">It will move to the board, in its project.</p>}
          </div>
        )}

        <div className="editor-grid">
          <div className="field editor-inline">
            <label htmlFor={ids.estimate} className="editor-inline-label">
              Estimate
            </label>
            {customEstimate ? (
              <span className="estimate-custom">
                <input
                  id={ids.estimate}
                  autoComplete="off"
                  autoFocus
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1440}
                  placeholder="Minutes"
                  value={draft.estimateMinutes ?? ''}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    set('estimateMinutes', Number.isFinite(n) && n > 0 ? Math.min(n, 1440) : null);
                  }}
                  onBlur={() => setCustomEstimate(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setCustomEstimate(false);
                    }
                  }}
                />
                <span aria-hidden="true">min</span>
              </span>
            ) : (
              <select
                id={ids.estimate}
                value={draft.estimateMinutes ?? ''}
                onChange={(e) => {
                  if (e.target.value === OTHER) setCustomEstimate(true);
                  else set('estimateMinutes', e.target.value ? Number(e.target.value) : null);
                }}
              >
                <option value="">None</option>
                {ESTIMATES.map((m) => (
                  <option key={m} value={m}>
                    {formatMinutes(m)}
                  </option>
                ))}
                {estimateIsCustom && <option value={draft.estimateMinutes!}>{formatMinutes(draft.estimateMinutes!)}</option>}
                <option value={OTHER}>Other…</option>
              </select>
            )}
          </div>
        </div>

        <div className="field">
          <label htmlFor={ids.notes} className="visually-hidden">
            Notes
          </label>
          <textarea
            id={ids.notes}
            autoComplete="off"
            placeholder="Notes"
            rows={2}
            value={draft.notes}
            onChange={(e) => set('notes', e.target.value)}
            maxLength={20000}
          />
        </div>

        {!isSubtask && draft.subtasks.length > 0 && (
          <ul className="sub-list" aria-label="Subtasks">
            {draft.subtasks.map((s) => (
              <li key={s.key} className="sub-row">
                <input
                  type="checkbox"
                  checked={s.done}
                  aria-label={`Done: ${s.title || 'new subtask'}`}
                  onChange={(e) => updateSub(s.key, { done: e.target.checked })}
                />
                <LineInput
                  id={`sub-${s.key}`}
                  className={`sub-input${s.done ? ' is-done' : ''}`}
                  value={s.title}
                  placeholder="Subtask"
                  aria-label="Subtask"
                  maxLength={500}
                  onValueChange={(v) => updateSub(s.key, { title: v })}
                  onKeyDown={(e) => onSubKeyDown(e, s)}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${s.title || 'subtask'}`}
                  onClick={() =>
                    set(
                      'subtasks',
                      draft.subtasks.filter((x) => x.key !== s.key),
                    )
                  }
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {!isSubtask && editing && (editing.agentState === 'working' || editing.agentState === 'review') && (
          <AgentStatus task={editing} onChange={(ready) => set('agentReady', ready)} onCompleted={() => close()} />
        )}

        {!isSubtask && (
          <div className="editor-extras">
            <button type="button" className="link-btn" onClick={() => addSubAfter()}>
              Add subtask
            </button>
            {!(editing && (editing.agentState === 'working' || editing.agentState === 'review')) && (
              <label
                className="editor-agent"
                title="Agents connected to Helm may claim it, work on it and hand it back for you to review."
              >
                <input
                  type="checkbox"
                  checked={draft.agentReady}
                  onChange={(e) => set('agentReady', e.target.checked)}
                />
                <span>An agent can do this</span>
              </label>
            )}
          </div>
        )}

        {error && (
          <p className="editor-error" role="alert">
            {error}
          </p>
        )}

        <footer className={`editor-foot${editing ? '' : ' is-new'}`}>
          {editing && (
            <button type="button" className="btn btn-quiet btn-danger" disabled={busy} onClick={remove}>
              Delete
            </button>
          )}
          {editing && (
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                close();
                window.location.hash = `${hrefFor('activity')}?who=all&task=${editing.id}`;
              }}
            >
              History
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn btn-quiet editor-foot-btn" onClick={() => close(true)}>
            {cancelLabel}
          </button>
          <button type="submit" className="btn btn-primary editor-foot-btn" disabled={busy}>
            {submitLabel}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

/** A task an agent holds: who, and what the owner can do about it. */
function AgentStatus({
  task,
  onChange,
  onCompleted,
}: {
  task: Task;
  onChange: (stillForAgents: boolean) => void;
  onCompleted: () => void;
}) {
  const setState = useSetAgentState();
  const action = useTaskAction();
  const who = agentName(task.agentClaimedBy);
  const busy = setState.isPending || action.isPending;
  const hand = (state: 'ready' | null) =>
    setState.mutate({ id: task.id, state }, { onSuccess: () => onChange(state !== null) });

  return (
    <div className={`editor-agent-status is-${task.agentState}`} role="status">
      <p>
        {task.agentState === 'working'
          ? `${who} is working on this.`
          : `${who} says this is finished. Check the notes, then mark it done or send it back.`}
      </p>
      <div className="editor-agent-actions">
        {task.agentState === 'review' && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => action.mutate({ id: task.id, action: 'complete' }, { onSuccess: onCompleted })}
          >
            Mark done
          </button>
        )}
        {task.agentState === 'review' && (
          <button type="button" className="btn" disabled={busy} onClick={() => hand('ready')}>
            Send back
          </button>
        )}
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => hand(null)}>
          Take it off the agents’ list
        </button>
      </div>
    </div>
  );
}

/** Projects as a row of chips: one tap to pick, the Inbox first and a new project last. */
function ProjectPicker({
  projects,
  value,
  onChange,
  onNew,
}: {
  projects: Project[];
  value: string | null;
  onChange: (id: string | null) => void;
  onNew: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  // Keep the picked project in view (the row scrolls sideways on a phone), also when #shorthand
  // in the title picks one.
  // A frame later: on open the dialog isn't laid out yet when this runs.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const row = rowRef.current;
      const on = row?.querySelector<HTMLElement>('input:checked')?.parentElement;
      if (!row || !on) return;
      const pad = 24;
      if (on.offsetLeft - pad < row.scrollLeft) row.scrollLeft = on.offsetLeft - pad;
      else if (on.offsetLeft + on.offsetWidth + pad > row.scrollLeft + row.clientWidth)
        row.scrollLeft = on.offsetLeft + on.offsetWidth + pad - row.clientWidth;
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);
  const options = [
    { id: null, name: 'Inbox', color: null, icon: projectIcon(null) },
    ...projects.map((p) => ({ id: p.id, name: p.name, color: p.color, icon: projectIcon(p) })),
  ];
  return (
    <div className="project-picker" role="radiogroup" aria-label="Project" ref={rowRef}>
      {options.map((o) => (
        <label
          key={o.id ?? 'inbox'}
          className="project-chip"
          style={o.color ? ({ '--pc': o.color } as CSSProperties) : undefined}
        >
          <input type="radio" name="project" checked={value === o.id} onChange={() => onChange(o.id)} />
          <span>
            {o.icon && <span aria-hidden="true">{o.icon}</span>}
            {o.name}
          </span>
        </label>
      ))}
      <button type="button" className="project-chip project-chip-new" onClick={onNew}>
        <span>+ New</span>
      </button>
    </div>
  );
}
