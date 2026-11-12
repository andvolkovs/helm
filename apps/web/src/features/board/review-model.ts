import type { Task } from '@helm/shared';

/** Open, live tasks an agent has handed back, oldest hand-in first. */
export function reviewQueue<T extends Pick<Task, 'agentState' | 'status' | 'deletedAt' | 'updatedAt'>>(tasks: readonly T[]): T[] {
  return tasks
    .filter((t) => t.agentState === 'review' && t.status !== 'done' && !t.deletedAt)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

/**
 * The text of the last agent note in a task's notes. Agents append paragraphs shaped
 * `— name, YYYY-MM-DD: text` (see withNote on the server); the owner's own writing is not one.
 */
export function lastAgentNote(notes: string | null): string | null {
  if (!notes) return null;
  const paragraphs = notes.split(/\n\s*\n/);
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const m = /^\s*—\s+[^\n]*?,\s*\d{4}-\d{2}-\d{2}:\s*([\s\S]*\S)\s*$/.exec(paragraphs[i]!);
    if (m) return m[1]!;
  }
  return null;
}
