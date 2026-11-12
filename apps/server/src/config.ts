import { dirname, join } from 'node:path';
import type { ProviderConfig } from '@helm/providers';
import { z } from 'zod';

const Env = z.object({
  HELM_PORT: z.coerce.number().int().default(8787),
  // Loopback by default: reach it from elsewhere through a proxy (tailscale serve), not the LAN.
  HELM_HOST: z.string().trim().default('127.0.0.1'),
  HELM_DB_PATH: z.string().default('./data/helm.db'),
  HELM_MIGRATIONS_DIR: z.string().optional(),
  // Daily copies of the database. Default: a `backups` folder next to it.
  HELM_BACKUP_DIR: z.string().trim().optional(),
  HELM_BACKUP_KEEP: z.coerce.number().int().min(0).default(14),
  // Days of activity history to keep; 0 keeps all of it.
  HELM_HISTORY_KEEP_DAYS: z.coerce.number().int().min(0).default(0),
  HELM_OWNER_PASSWORD: z.string().min(1, 'HELM_OWNER_PASSWORD is required'),
  HELM_SESSION_SECRET: z.string().min(16, 'HELM_SESSION_SECRET must be at least 16 chars'),
  HELM_COOKIE_SECURE: z.stringbool().default(false),
  HELM_IN_PROGRESS_LIMIT: z.coerce.number().int().min(0).default(1),
  HELM_MAX_SUBTASK_DEPTH: z.coerce.number().int().min(0).default(1),
  HELM_WEB_DIST: z.string().optional(),
  HELM_LLM_PROVIDER: z.string().trim().default('openai'),
  HELM_LLM_MODEL: z.string().trim().default('gpt-5-mini'),
  // Absent = low (quick parses on gpt-5 models); set it empty for models without reasoning.
  HELM_LLM_REASONING_EFFORT: z.string().trim().default('low'),
  HELM_STT_PROVIDER: z.string().trim().default('openai'),
  HELM_STT_MODEL: z.string().trim().default('gpt-4o-mini-transcribe'),
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_BASE_URL: z.url().optional().or(z.literal('')),
});

export interface TaskRules {
  /** Max tasks in_progress at once; starting another demotes the oldest. 0 = unlimited. */
  inProgressLimit: number;
  /** 0 = no subtasks, 1 = subtasks can't have subtasks, ... */
  maxSubtaskDepth: number;
}

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  /** Where migration SQL lives, when not next to the code (running the bundle outside Docker). */
  migrationsDir?: string;
  /** Daily database copies: where, and how many to keep (0 = off). */
  backups: { dir: string; keep: number };
  /** Days of activity history (who changed what, with Undo) to keep; 0 = all of it. */
  historyKeepDays: number;
  ownerPassword: string;
  sessionSecret: string;
  cookieSecure: boolean;
  rules: TaskRules;
  /** Built web app to serve statically (production). */
  webDist?: string;
  /** Which AI adapters to use; see @helm/providers. */
  ai: ProviderConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}\nSee .env.example.`);
  }
  const e = parsed.data;
  return {
    port: e.HELM_PORT,
    host: e.HELM_HOST,
    dbPath: e.HELM_DB_PATH,
    migrationsDir: e.HELM_MIGRATIONS_DIR || undefined,
    backups: {
      dir: e.HELM_BACKUP_DIR || join(dirname(e.HELM_DB_PATH), 'backups'),
      keep: e.HELM_DB_PATH === ':memory:' ? 0 : e.HELM_BACKUP_KEEP,
    },
    historyKeepDays: e.HELM_HISTORY_KEEP_DAYS,
    ownerPassword: e.HELM_OWNER_PASSWORD,
    sessionSecret: e.HELM_SESSION_SECRET,
    cookieSecure: e.HELM_COOKIE_SECURE,
    rules: { inProgressLimit: e.HELM_IN_PROGRESS_LIMIT, maxSubtaskDepth: e.HELM_MAX_SUBTASK_DEPTH },
    webDist: e.HELM_WEB_DIST,
    ai: {
      llm: {
        provider: e.HELM_LLM_PROVIDER,
        model: e.HELM_LLM_MODEL,
        reasoningEffort: e.HELM_LLM_REASONING_EFFORT || undefined,
      },
      stt: { provider: e.HELM_STT_PROVIDER, model: e.HELM_STT_MODEL },
      openai: { apiKey: e.OPENAI_API_KEY || undefined, baseUrl: e.OPENAI_BASE_URL || undefined },
    },
  };
}
