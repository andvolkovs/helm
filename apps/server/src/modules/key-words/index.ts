import { ProviderError, type LlmProvider } from '@helm/providers';
import { keyWordsIn, ruleKeyWords, titleWords, type Task } from '@helm/shared';
import { z } from 'zod';
import type { TaskService } from '../../core/services/task.service.ts';
import type { HelmModule } from '../module.ts';

/** Titles sent to the model in one request. */
const BATCH = 25;

const ModelAnswer = z.object({
  picks: z.array(z.object({ n: z.number().int(), words: z.array(z.string()) })),
});

const SYSTEM = `You help someone skim a task board. Each task title is shown with its key words in bold, so they can find the task without reading every word.

For each numbered title, pick the one or two words or short phrases that carry its meaning: the thing, person, place or topic it is about, the words they would remember the task by.
- Copy the words exactly as they appear in the title. Never rephrase, translate or fix spelling.
- Each pick is one to three words. Two picks at most; one is enough for a short title.
- Skip generic action words (call, fix, buy, check, create, build, add, write, test, review, start...) and filler, unless the title has nothing else.
- For a title of one or two words, pick the whole title.
Answer with one entry per title, using its number.`;

interface Item {
  id: string;
  title: string;
  projectId: string | null;
}

/** Ask the model for each title's key words. Titles it skipped come back as null. */
export async function askKeyWords(llm: LlmProvider, titles: string[], signal?: AbortSignal): Promise<(string[] | null)[]> {
  const answer = await llm.object({
    system: SYSTEM,
    messages: [{ role: 'user', content: titles.map((t, i) => `${i + 1}. ${t.replace(/\s+/g, ' ')}`).join('\n') }],
    schema: ModelAnswer,
    name: 'key_words',
    signal,
  });
  const out: (string[] | null)[] = titles.map(() => null);
  for (const p of answer.picks) {
    const i = p.n - 1;
    if (i >= 0 && i < titles.length && out[i] === null) out[i] = keyWordsIn(titles[i]!, p.words);
  }
  return out;
}

/**
 * Picks key words for tasks in the background, one batch at a time: new tasks and changed titles
 * as they happen (a moment later, so a burst goes in one request), and every task without them
 * once the server starts. Without an AI model, a simple rule picks them instead.
 */
export class KeyWordPicker {
  private readonly pending = new Map<string, Item>();
  /** Failed this run; tried again after a restart. */
  private readonly failed = new Set<string>();
  private backlog = true;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly tasks: TaskService,
    private readonly llm: LlmProvider | null,
    private readonly o: { delayMs: number },
  ) {}

  want(item: Item): void {
    this.pending.set(item.id, item);
    this.soon();
  }

  /** Go through every task still missing key words. */
  catchUp(): void {
    this.backlog = true;
    this.soon();
  }

  /** Resolves when nothing is left to do (for tests). */
  async settle(): Promise<void> {
    clearTimeout(this.timer);
    await this.run();
  }

  private soon(): void {
    clearTimeout(this.timer);
    // Key words are a nicety: a failure here is logged, never allowed to take the server down.
    this.timer = setTimeout(
      () => void this.run().catch((e: unknown) => console.error('key words: stopped unexpectedly:', e)),
      this.o.delayMs,
    );
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        let batch = [...this.pending.values()].slice(0, BATCH);
        for (const b of batch) this.pending.delete(b.id);
        if (batch.length === 0 && this.backlog) {
          batch = this.tasks.needingKeyWords(BATCH + this.failed.size).filter((t) => !this.failed.has(t.id)).slice(0, BATCH);
          if (batch.length === 0) this.backlog = false;
        }
        if (batch.length === 0) return;
        if (!(await this.pick(batch))) {
          // The model is down or out of credit: stop going through the backlog until a restart.
          this.backlog = false;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async pick(batch: Item[]): Promise<boolean> {
    let words: (string[] | null)[] = batch.map(() => null);
    if (this.llm) {
      try {
        words = await askKeyWords(this.llm, batch.map((b) => b.title), AbortSignal.timeout(60_000));
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        console.warn(`key words: ${e.kind}${e.status ? ` ${e.status}` : ''}: ${e.message}`);
        for (const b of batch) this.failed.add(b.id);
        return false;
      }
    }
    const seen = this.wordCounts();
    batch.forEach((b, i) => {
      const w = words[i] ?? ruleKeyWords(b.title, (word) => seen(b.projectId, word));
      this.tasks.setKeyWords(b.id, b.title, w);
    });
    return true;
  }

  /** How many open tasks on a board use a word, for the rule. */
  private wordCounts(): (projectId: string | null, word: string) => number {
    const counts = new Map<string, number>();
    for (const t of this.tasks.openTitles()) {
      for (const w of new Set(titleWords(t.title))) {
        const k = `${t.projectId}|${w}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    return (projectId, word) => counts.get(`${projectId}|${word}`) ?? 0;
  }
}

/** Does this change leave an open top-level task without key words? */
function needsPick(action: string, t: Task): boolean {
  return action !== 'keyed' && !t.keyWords && !t.parentTaskId && !t.deletedAt && t.status !== 'done' && t.title.trim() !== '';
}

export function createKeyWordsModule(o: { delayMs?: number; startDelayMs?: number; onPicker?: (p: KeyWordPicker) => void } = {}): HelmModule {
  return {
    name: 'key-words',
    register({ services, bus, providers }) {
      const picker = new KeyWordPicker(services.tasks, providers.llm, { delayMs: o.delayMs ?? 1500 });
      bus.subscribe((e) => {
        if (e.entity !== 'task') return;
        const t = e.data as Task;
        if (needsPick(e.action, t)) picker.want({ id: t.id, title: t.title, projectId: t.projectId });
      });
      const start = setTimeout(() => picker.catchUp(), o.startDelayMs ?? 10_000);
      start.unref?.();
      o.onPicker?.(picker);
    },
  };
}

export const keyWordsModule = createKeyWordsModule();
