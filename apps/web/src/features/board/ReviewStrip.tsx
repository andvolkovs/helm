import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Project, Task } from '@helm/shared';
import { useSetAgentState, useTaskAction } from '../../lib/queries.ts';
import { KeyedTitle } from '../../ui/KeyedTitle.tsx';
import { agentName } from './agent-badge.ts';
import { lastAgentNote } from './review-model.ts';

interface Props {
  /** Tasks handed back by agents, oldest first (see reviewQueue). Empty hides the strip. */
  queue: Task[];
  projects: Project[];
  onOpen: (id: string) => void;
}

/**
 * Work agents have finished and handed back, one task at a time. Always in view, so it isn't
 * missed behind a folded panel or "Show more". Errors surface as toasts via the mutation cache.
 */
export function ReviewStrip({ queue, projects, onOpen }: Props) {
  const action = useTaskAction();
  const setState = useSetAgentState();
  const [at, setAt] = useState(0);
  // Which task's comment field is open, so it closes when the strip moves on.
  const [sendingFor, setSendingFor] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const sendBackRef = useRef<HTMLButtonElement>(null);
  const stripRef = useRef<HTMLElement>(null);

  // The live region stays mounted so a first hand-in is announced.
  if (queue.length === 0) return <div aria-live="polite" />;

  // After an action the task leaves the queue and the next one slides into this slot.
  const index = at % queue.length;
  const task = queue[index]!;
  const project = projects.find((p) => p.id === task.projectId)?.name ?? 'Inbox';
  const note = lastAgentNote(task.notes);
  const sending = sendingFor === task.id;
  const busy = action.isPending || setState.isPending;

  /** Closing the field unmounts what had focus: put it back on Send back. */
  function closeComment() {
    setSendingFor(null);
    setComment('');
    requestAnimationFrame(() => sendBackRef.current?.focus());
  }

  /** The task just handled leaves the strip; keep keyboard users in it, on the next one. */
  function afterAction() {
    setSendingFor(null);
    setComment('');
    requestAnimationFrame(() => (sendBackRef.current ?? stripRef.current)?.focus());
  }

  function sendBack(e: FormEvent) {
    e.preventDefault();
    const text = comment.trim();
    setState.mutate({ id: task.id, state: 'ready', ...(text ? { note: text } : {}) }, { onSuccess: afterAction });
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeComment();
    }
  }

  return (
    <div aria-live="polite">
    <section className="review-strip" aria-label="Handed back for review" ref={stripRef} tabIndex={-1}>
      <div className="review-main">
        <div className="review-meta">
          <span className="review-count">
            {index + 1} of {queue.length}
          </span>
          <span>
            {agentName(task.agentClaimedBy)} handed in · {project}
          </span>
        </div>
        <button className="review-title" onClick={() => onOpen(task.id)}>
          <KeyedTitle title={task.title} words={task.keyWords} />
        </button>
        {note && <p className="review-note">{note}</p>}
      </div>

      <div className="review-actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => action.mutate({ id: task.id, action: 'complete' }, { onSuccess: afterAction })}>
          Accept
        </button>
        <button ref={sendBackRef} className="btn" disabled={busy} aria-expanded={sending} onClick={() => setSendingFor(task.id)}>
          Send back
        </button>
        {queue.length > 1 && (
          <button className="btn btn-quiet" onClick={() => setAt(index + 1)}>
            Next
          </button>
        )}
      </div>

      {sending && (
        <form className="review-send" onSubmit={sendBack} onKeyDown={onKey}>
          <input
            autoFocus
            value={comment}
            maxLength={5000}
            placeholder="Comment for the agent (optional)"
            aria-label="Comment for the agent"
            onChange={(e) => setComment(e.target.value)}
          />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            Send
          </button>
          <button className="btn btn-quiet" type="button" onClick={closeComment}>
            Cancel
          </button>
        </form>
      )}
    </section>
    </div>
  );
}
