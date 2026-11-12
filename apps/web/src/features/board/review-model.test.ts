import { describe, expect, it } from 'vitest';
import { lastAgentNote, reviewQueue } from './review-model.ts';

describe('lastAgentNote', () => {
  it('returns null without notes or agent paragraphs', () => {
    expect(lastAgentNote(null)).toBeNull();
    expect(lastAgentNote('')).toBeNull();
    expect(lastAgentNote('Just my own thoughts')).toBeNull();
  });
  it('takes the text of the last agent paragraph', () => {
    const notes = 'Mine\n\n— Claude Code, 2026-11-01: first try\n\n— Claude Code, 2026-11-02: Done, see PR #4.';
    expect(lastAgentNote(notes)).toBe('Done, see PR #4.');
  });
  it('skips owner text added after the agent', () => {
    expect(lastAgentNote('— Bot, 2026-11-01: finished\n\nthanks!')).toBe('finished');
  });
  it('keeps multi-line text', () => {
    expect(lastAgentNote('— Bot, 2026-11-01: line one\nline two')).toBe('line one\nline two');
  });
});

describe('reviewQueue', () => {
  const t = (id: string, o: object = {}) => ({ id, agentState: 'review' as const, status: 'todo' as const, deletedAt: null, updatedAt: id, ...o });
  it('keeps live open review tasks, oldest first', () => {
    const q = reviewQueue([
      t('2026-03'),
      t('2026-01'),
      t('x', { agentState: 'ready' }),
      t('y', { status: 'done' }),
      t('z', { deletedAt: '2026-01-01' }),
    ]);
    expect(q.map((x) => x.id)).toEqual(['2026-01', '2026-03']);
  });
});
