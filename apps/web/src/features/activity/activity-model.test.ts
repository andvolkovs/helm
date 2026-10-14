import { describe, expect, it } from 'vitest';
import type { ActivityChange, ActivityEntry, Task } from '@helm/shared';
import { mergeNotes } from '../task-editor/save.ts';
import { agentBadge } from '../board/agent-badge.ts';
import { actorLabel, addedNote, describeEntry } from './activity-model.ts';

function task(p: Partial<Task> & { id: string }): Task {
  return {
    title: p.id,
    notes: null,
    projectId: null,
    priority: 'soon',
    estimateMinutes: null,
    status: 'todo',
    parentTaskId: null,
    position: 'a0',
    source: 'manual',
    createdAt: '',
    updatedAt: '',
    startedAt: null,
    completedAt: null,
    deletedAt: null,
    agentState: null,
    agentClaimedBy: null,
    today: null,
    todayAt: null,
    todayOnly: false,
    ...p,
  };
}

let seq = 0;
const change = (action: string, before: Task | null, after: Task): ActivityChange => ({
  eventId: ++seq,
  entity: 'task',
  entityId: after.id,
  action,
  before,
  after,
});
const entry = (changes: ActivityChange[], actor = 'token:Claude Code'): ActivityEntry => ({
  batchId: 'b',
  at: '2026-09-29T10:00:00Z',
  actor,
  changes,
  cantUndo: null,
  undoneAt: null,
  undoOf: null,
});
const names = (id: string | null) => (id === 'p1' ? 'Helm' : id ? 'Other' : 'Inbox');
const texts = (e: ActivityEntry) => describeEntry(e, names).map((l) => [l.text, ...l.details, l.alsoSubtasks]);

describe('describeEntry', () => {
  it('folds subtasks that changed along with their parent', () => {
    const parent = task({ id: 'Ship' });
    const subs = ['Build', 'Test'].map((id) => task({ id, parentTaskId: 'Ship' }));
    const done = (t: Task) => change('completed', t, { ...t, status: 'done' });
    expect(texts(entry([done(parent), ...subs.map(done)]))).toEqual([['Completed “Ship”', 2]]);
    // A subtask completed alone keeps its own line.
    expect(texts(entry([done(subs[0]!)]))).toEqual([['Completed “Build”', 0]]);
  });

  it('says what happened on Today', () => {
    const b = task({ id: 'Budget' });
    const main = { ...b, today: 'main' as const, todayAt: '2026-09-29T08:00:00Z' };
    expect(texts(entry([change('updated', b, main)]))).toEqual([['Put “Budget” on Today as a main task', 0]]);
    expect(texts(entry([change('updated', main, { ...main, today: 'side' })]))).toEqual([['Made “Budget” secondary on Today', 0]]);
    const thursday = { ...main, planDate: '2026-10-01' };
    // Day names follow the device's locale ("Thu 1 Oct", "Thu, 1 Oct", …).
    expect(texts(entry([change('updated', b, thursday)]))[0]![0]).toMatch(/^Planned “Budget” for Thu\W+1 Oct as a main task$/);
    expect(texts(entry([change('updated', thursday, { ...thursday, planDate: '2026-10-02' })]))[0]![0]).toMatch(
      /^Moved “Budget” to Fri\W+2 Oct$/,
    );
    expect(texts(entry([change('updated', main, b)]))).toEqual([['Took “Budget” off Today', 0]]);
    const parcel = task({ id: 'Parcel', today: 'side', todayOnly: true });
    expect(texts(entry([change('created', null, parcel)]))).toEqual([['Added “Parcel” to Today', 0]]);
  });

  it('names what changed in an edit', () => {
    const b = task({ id: 'Fix login', notes: 'Only on Safari' });
    expect(texts(entry([change('moved', b, { ...b, projectId: 'p1' })]))).toEqual([['Moved “Fix login” to Helm', 0]]);
    expect(texts(entry([change('updated', b, { ...b, priority: 'now' })]))).toEqual([['Set “Fix login” to Now', 0]]);
    expect(texts(entry([change('updated', b, { ...b, title: 'Fix auth', notes: 'Rewritten' })]))).toEqual([
      ['Changed “Fix auth”', 'Title: “Fix login” → “Fix auth”', 'Notes rewritten', 0],
    ]);
    expect(texts(entry([change('updated', b, { ...b, notes: null })]))[0]).toContain('Notes cleared');
    // An undo puts the status back in a plain update.
    const done = { ...b, status: 'done' as const };
    expect(texts(entry([change('updated', done, { ...done, status: 'in_progress' })]))).toEqual([
      ['Changed “Fix login”', 'Status: Done → In progress', 0],
    ]);
    // Only the position changed.
    expect(texts(entry([change('moved', b, { ...b, position: 'b0' })]))).toEqual([['Reordered “Fix login”', 0]]);
  });

  it('tells the hand-off steps apart', () => {
    const t = task({ id: 'Deps' });
    const ready = { ...t, agentState: 'ready' as const };
    const working = { ...t, agentState: 'working' as const, agentClaimedBy: 'token:Claude Code' };
    const review = { ...working, agentState: 'review' as const };
    const noted = { ...working, notes: '— Claude Code, 2026-09-29: Bumped vite' };
    expect(texts(entry([change('agent', t, ready)]))).toEqual([['Handed “Deps” to agents', 0]]);
    expect(texts(entry([change('agent', ready, working)]))).toEqual([['Claimed “Deps”', 0]]);
    expect(texts(entry([change('noted', working, noted), change('agent', noted, { ...noted, ...review })]))).toEqual([
      ['Added a note to “Deps”', '— Claude Code, 2026-09-29: Bumped vite', 0],
      ['Sent “Deps” for review', 0],
    ]);
    expect(texts(entry([change('agent', working, ready)]))).toEqual([['Handed “Deps” back', 0]]);
  });

  it('skips noise such as folding a project panel', () => {
    const p = { id: 'p1', name: 'Helm', color: '#6E8BFF', icon: null, collapsed: false, position: 'a0', archivedAt: null, createdAt: '', updatedAt: '' };
    const e = entry(
      [{ eventId: 1, entity: 'project', entityId: 'p1', action: 'updated', before: p, after: { ...p, collapsed: true } }],
      'owner',
    );
    expect(describeEntry(e, names)).toEqual([]);
  });
});

describe('labels', () => {
  it('names actors and hand-off badges', () => {
    expect(actorLabel('owner')).toBe('You');
    expect(actorLabel('ai:assistant')).toBe('Assistant');
    expect(actorLabel('token:Claude Code')).toBe('Claude Code');
    expect(agentBadge({ agentState: 'working', agentClaimedBy: 'token:Codex' })).toBe('Codex on it');
    expect(agentBadge({ agentState: 'review', agentClaimedBy: 'token:Codex' })).toBe('Review');
    expect(agentBadge({ agentState: null, agentClaimedBy: null })).toBeNull();
  });

  it('finds the paragraph an append added', () => {
    expect(addedNote('A', 'A\n\nB')).toBe('B');
    expect(addedNote(null, 'B')).toBe('B');
    expect(addedNote('A', 'C')).toBeNull();
  });
});

describe('mergeNotes', () => {
  it('keeps what an agent added while the dialog was open', () => {
    expect(mergeNotes('A', 'A\n\n— Claude: found it', 'A, edited')).toBe('A, edited\n\n— Claude: found it');
    expect(mergeNotes('A', 'A\n\n— Claude: found it', null)).toBe('— Claude: found it');
    // Nothing changed meanwhile, or it was rewritten: the user's edit wins.
    expect(mergeNotes('A', 'A', 'B')).toBe('B');
    expect(mergeNotes('A', 'Z', 'B')).toBe('B');
    expect(mergeNotes(null, 'X', 'B')).toBe('B');
  });
});
