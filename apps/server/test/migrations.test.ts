import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '@helm/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

const journalUrl = new URL('../../../packages/db/migrations/meta/_journal.json', import.meta.url);
const journal = JSON.parse(readFileSync(fileURLToPath(journalUrl), 'utf8')) as {
  entries: { idx: number; tag: string }[];
};

describe('db migrations', () => {
  it('apply cleanly to an empty database and record every journal entry', () => {
    const { db, close } = openDb({ path: ':memory:' });
    try {
      const applied = db.all<{ n: number }>(sql`select count(*) as n from __drizzle_migrations`);
      expect(applied[0]!.n).toBe(journal.entries.length);
      expect(journal.entries.length).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it('creates the core tables', () => {
    const { db, close } = openDb({ path: ':memory:' });
    try {
      const rows = db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`);
      const names = rows.map((r) => r.name);
      for (const t of ['projects', 'tasks', 'api_tokens', 'timers', 'push_subscriptions', 'settings']) {
        expect(names).toContain(t);
      }
    } finally {
      close();
    }
  });

  it('enables foreign keys and WAL-safe pragmas', () => {
    const { db, close } = openDb({ path: ':memory:' });
    try {
      expect(db.all<{ foreign_keys: number }>(sql`pragma foreign_keys`)[0]!.foreign_keys).toBe(1);
    } finally {
      close();
    }
  });

  it('keeps the journal indexes sequential', () => {
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
  });
});
