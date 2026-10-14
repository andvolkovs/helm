import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MAX_TODAY_MAIN, parseQuickAdd, projectCandidates, type Project, type TodaySlot } from '@helm/shared';
import { api } from '../../lib/api.ts';
import { upsertTask, useProjects } from '../../lib/queries.ts';
import { LineInput } from '../../ui/LineInput.tsx';
import { useToast } from '../../ui/Toast.tsx';

// Buttons next to the field mustn't take focus from it: that would drop the phone keyboard.
const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

interface Props {
  /** The day to add to, `YYYY-MM-DD`; omitted = today. */
  day?: string;
  /** "today", or the day's name ("Thursday"). */
  dayName: string;
  mainFull: boolean;
  mainEmpty: boolean;
  projects: Project[];
  /** In a narrow week column: no hint line. */
  compact?: boolean;
  autoFocus?: boolean;
  /** Escape in an empty field. */
  onClose?: () => void;
}

/**
 * "Add to today" (or to another day): a task that lives only on the plan, unless `#project` puts
 * it on that project's board too. Enter adds it and keeps the field open for the next one.
 */
export function PlanAdd({ day, dayName, mainFull, mainEmpty, projects, compact, autoFocus, onClose }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const liveProjects = useProjects();
  const [text, setText] = useState('');
  // Planning a day starts with the main things.
  const [slot, setSlot] = useState<TodaySlot>(mainEmpty ? 'main' : 'side');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mainFullText = `Main has ${MAX_TODAY_MAIN} already. Move one to Secondary first.`;
  const Day = dayName.charAt(0).toUpperCase() + dayName.slice(1);

  useEffect(() => {
    if (mainFull) setSlot('side');
  }, [mainFull]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const typed = text.trim();
    if (!typed) return;
    const parsed = parseQuickAdd(typed);
    const hits = parsed.projectQuery ? projectCandidates(parsed.projectQuery, liveProjects.data ?? projects) : [];
    const project = hits.length === 1 ? hits[0]! : null;
    // A #name that isn't one project stays part of the title.
    const title = parsed.projectQuery && !project ? `${parsed.title} #${parsed.projectQuery}`.trim() : parsed.title;
    if (!title) return;
    const to: TodaySlot = slot === 'main' && mainFull ? 'side' : slot;
    setText('');
    inputRef.current?.focus();
    try {
      const task = await api.createTask({
        title,
        projectId: project?.id ?? null,
        priority: parsed.priority ?? undefined,
        estimateMinutes: parsed.estimateMinutes ?? undefined,
        today: to,
        planDate: day,
        todayOnly: !project,
      });
      upsertTask(qc, task);
      if (project) toast({ message: `Added to ${Day} and ${project.name}.` });
    } catch (err) {
      setText((now) => now || typed);
      toast({ message: `Couldn’t add “${title}”: ${(err as Error).message}` });
    }
  }

  return (
    <form
      className={`today-add${compact ? ' is-compact' : ''}`}
      onSubmit={submit}
      autoComplete="off"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !text && onClose) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <LineInput
        ref={inputRef}
        className="today-add-input"
        aria-label={`Add to ${dayName}`}
        placeholder={`Add to ${dayName}…`}
        enterKeyHint="enter"
        maxLength={500}
        value={text}
        onValueChange={setText}
      />
      <button
        type="button"
        className={`today-add-slot${slot === 'main' ? ' is-main' : ''}`}
        onMouseDown={keepFocus}
        onClick={() => (slot === 'side' && mainFull ? toast({ message: mainFullText }) : setSlot(slot === 'main' ? 'side' : 'main'))}
        aria-label={`Adds to ${slot === 'main' ? 'Main' : 'Secondary'}. Switch`}
        title="Main or Secondary"
      >
        {slot === 'main' ? 'Main' : '2nd'}
      </button>
      <button type="submit" className="today-add-send" onMouseDown={keepFocus} disabled={!text.trim()} aria-label="Add">
        ↵
      </button>
      {!compact && (
        <p className="today-add-hint">
          Lives only on {day ? 'the plan' : 'Today'}. Add #project to put it on that board too.
        </p>
      )}
    </form>
  );
}
