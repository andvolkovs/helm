import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.ts';

export * from './schema.ts';
export { schema };

export type Db = BetterSQLite3Database<typeof schema>;
/** Anything you can run queries on: the db itself or a transaction handle. */
export type Tx = BaseSQLiteDatabase<'sync', Database.RunResult, typeof schema>;

export interface OpenDbOptions {
  /** File path, or ":memory:" for tests. */
  path: string;
  /** Override where migration SQL lives (e.g. in a bundled build). */
  migrationsFolder?: string;
}

export interface DbHandle {
  db: Db;
  /** A consistent copy of the database at `dest`, taken while it stays in use. */
  backup(dest: string): Promise<unknown>;
  close(): void;
}

const defaultMigrations = fileURLToPath(new URL('../migrations', import.meta.url));

export function openDb({ path, migrationsFolder = defaultMigrations }: OpenDbOptions): DbHandle {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  // Safe with WAL (a power cut can lose the last commit, never corrupt the file) and far fewer
  // disk syncs, which matters on an SD card.
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  // LIKE folds case for ASCII letters only; text search compares through this instead, so
  // "ärger" finds "Ärger". Deterministic, so SQLite may use it anywhere.
  sqlite.function('helm_fold', { deterministic: true }, (s: unknown) =>
    typeof s === 'string' ? s.normalize('NFC').toLowerCase() : null,
  );

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });

  return { db, backup: (dest) => sqlite.backup(dest), close: () => sqlite.close() };
}
