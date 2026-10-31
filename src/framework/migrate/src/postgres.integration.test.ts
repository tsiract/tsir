/**
 * `@tsir/migrate` against a real Postgres server (`MIG-001`…`MIG-013`).
 *
 * The unit suite proves the applier's logic against a fake. This one proves the
 * things only a server can: that `pg_try_advisory_lock` actually excludes a second
 * runner, that `interactiveTx` really rolls back DDL, and that 50 migrations
 * applied by two concurrent runners land exactly once each (`MIG-013`).
 *
 * Run it with `DATABASE_URL=… bun src/tools/test-integration.ts`.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { createDatabase, type Database } from '@tsir/database';
import { createPostgresDriver } from '@tsir/database/postgres';

import { connectPostgres, databaseUrl, type TestDatabase } from '../../../tools/pg-test-client.ts';
import { advisoryLockKey } from './lock.ts';
import { migrationStatus } from './status.ts';
import { migrate } from './migrate.ts';
import { rollback } from './rollback.ts';

const url = databaseUrl();
const suite = url === undefined ? describe.skip : describe;

const FOLDER_PREFIX = 'tsir-migrate-it-';

let pg: TestDatabase;
/** A pooled client: the realistic shape, and the one pinning exists for. */
let db: Database;

const temporary: string[] = [];

async function migrationFolder(
  entries: readonly { tag: string; when: number; sql: string; down?: string }[],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), FOLDER_PREFIX));
  temporary.push(dir);
  await mkdir(join(dir, 'meta'), { recursive: true });
  await writeFile(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: entries.map((entry, index) => ({
        idx: index,
        version: '7',
        when: entry.when,
        tag: entry.tag,
        breakpoints: true,
      })),
    }),
  );
  for (const entry of entries) {
    await writeFile(join(dir, `${entry.tag}.sql`), entry.sql);
    if (entry.down !== undefined) await writeFile(join(dir, `${entry.tag}.down.sql`), entry.down);
  }
  return dir;
}

async function resetSchema(): Promise<void> {
  // Every test starts from an empty schema, which is also what `migrate:verify`
  // promises: empty → current.
  await pg.run('drop table if exists "__drizzle_migrations"');
  await pg.run('drop table if exists "__tsir_migration_runs"');
  for (const tag of ['it_users', 'it_posts', 'it_extra', 'it_rollback']) {
    await pg.run(`drop table if exists "${tag}"`);
  }
  for (let index = 0; index < 50; index += 1) {
    await pg.run(`drop table if exists "it_bulk_${String(index)}"`);
  }
}

suite('migrate · Postgres integration (MIG-001…MIG-013)', () => {
  beforeAll(() => {
    pg = connectPostgres(url ?? '');
    db = createDatabase({ driver: createPostgresDriver({ client: pg.client }), logging: 'off' });
  });

  afterAll(async () => {
    await resetSchema();
    await db.close();
    await pg.close();
    await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  beforeEach(resetSchema);

  test('applies a journal in order and records it once', async () => {
    const folder = await migrationFolder([
      { tag: '0000_init', when: 1, sql: 'create table "it_users" ("id" int primary key);' },
      { tag: '0001_posts', when: 2, sql: 'create table "it_posts" ("id" int primary key);' },
    ]);

    const first = await migrate({ database: db, folder, name: 'it', waitMs: 1_000 });
    expect(first.applied.map((entry) => entry.tag)).toEqual(['0000_init', '0001_posts']);
    expect(first.lockVerified).toBe(true);

    const second = await migrate({ database: db, folder, name: 'it', waitMs: 1_000 });
    expect(second.applied).toEqual([]);

    const journal = await pg.run('select count(*)::int as n from "__drizzle_migrations"');
    expect(journal[0]?.['n']).toBe(2);
  });

  test('writes the audit sidecar with host, actor, checksum and duration', async () => {
    const folder = await migrationFolder([
      { tag: '0000_init', when: 1, sql: 'create table "it_users" ("id" int primary key);' },
    ]);

    await migrate({ database: db, folder, name: 'it', host: 'it-host', actor: 'it-actor' });

    const rows = await pg.run(
      'select tag, host, actor, checksum, duration_ms from "__tsir_migration_runs" order by tag',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['tag']).toBe('0000_init');
    expect(rows[0]?.['host']).toBe('it-host');
    expect(rows[0]?.['actor']).toBe('it-actor');
    expect(String(rows[0]?.['checksum'])).toHaveLength(64);
    expect(Number(rows[0]?.['duration_ms'])).toBeGreaterThanOrEqual(0);
  });

  test('a failing migration rolls its DDL back and stops the run', async () => {
    const folder = await migrationFolder([
      { tag: '0000_init', when: 1, sql: 'create table "it_users" ("id" int primary key);' },
      {
        tag: '0001_broken',
        when: 2,
        sql: 'create table "it_posts" ("id" int primary key);\ncreate table "it_posts" ("id" int);',
      },
    ]);

    const error = await migrate({ database: db, folder, name: 'it' }).then(
      () => undefined,
      (reason: unknown) => reason as { code?: string; message?: string },
    );

    expect(error?.code).toBe('DB_MIGRATION_FAILED');
    // The failed migration's first statement ran inside a transaction, so the
    // table it created must not exist.
    const tables = await pg.run(
      "select tablename from pg_tables where schemaname = 'public' and tablename = 'it_posts'",
    );
    expect(tables).toEqual([]);
    const applied = await pg.run('select count(*)::int as n from "__drizzle_migrations"');
    expect(applied[0]?.['n']).toBe(1);
  });

  test('drift refuses before a single statement runs', async () => {
    const folder = await migrationFolder([
      { tag: '0000_init', when: 1, sql: 'create table "it_users" ("id" int primary key);' },
    ]);
    await migrate({ database: db, folder, name: 'it' });

    // Someone edits an applied migration on disk.
    await writeFile(join(folder, '0000_init.sql'), 'create table "it_users" ("id" bigint);\n');

    const error = await migrate({ database: db, folder, name: 'it' }).then(
      () => undefined,
      (reason: unknown) => reason as { code?: string },
    );
    expect(error?.code).toBe('DB_MIGRATION_DRIFT');

    const status = await migrationStatus(db, { folder });
    expect(status.tags.drifted).toEqual(['0000_init']);
  });

  test('rollback undoes a migration, its journal row, and nothing else', async () => {
    const folder = await migrationFolder([
      { tag: '0000_init', when: 1, sql: 'create table "it_users" ("id" int primary key);' },
      {
        tag: '0001_extra',
        when: 2,
        sql: 'create table "it_extra" ("id" int primary key);',
        down: 'drop table "it_extra";',
      },
    ]);
    await migrate({ database: db, folder, name: 'it' });

    const result = await rollback({
      database: db,
      folder,
      name: 'it',
      to: '0000_init',
      allowDestructive: true,
      confirm: '0001_extra',
    });

    expect(result.undone).toEqual(['0001_extra']);
    expect(result.lockVerified).toBe(true);
    const tables = await pg.run(
      "select tablename from pg_tables where schemaname = 'public' and tablename in ('it_users', 'it_extra')",
    );
    expect(tables.map((row) => row['tablename'])).toEqual(['it_users']);
  });

  test('50 migrations, two concurrent runners: each migration applies exactly once (MIG-013)', async () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({
      tag: `${String(index).padStart(4, '0')}_bulk`,
      when: index + 1,
      sql: `create table "it_bulk_${String(index)}" ("id" int primary key);`,
    }));
    const folder = await migrationFolder(entries);

    // Two independent runners, each with its own pooled client and its own
    // connection — exactly what two deploys racing each other look like.
    const second = createDatabase({
      driver: createPostgresDriver({ client: pg.client }),
      logging: 'off',
    });

    const [first, other] = await Promise.all([
      migrate({ database: db, folder, name: 'it-race', waitMs: 5_000 }),
      migrate({ database: second, folder, name: 'it-race', waitMs: 5_000 }),
    ]);

    const appliedTags = [...first.applied, ...other.applied].map((entry) => entry.tag).sort();
    // Exactly-once: the union is all 50, with no tag applied by both runners.
    expect(appliedTags).toHaveLength(50);
    expect(new Set(appliedTags).size).toBe(50);

    const journal = await pg.run('select count(*)::int as n from "__drizzle_migrations"');
    expect(journal[0]?.['n']).toBe(50);

    // Every table exists exactly once — a double application would have failed on
    // the second CREATE TABLE and left a partial journal instead.
    const tables = await pg.run(
      "select count(*)::int as n from pg_tables where schemaname = 'public' and tablename like 'it_bulk_%'",
    );
    expect(tables[0]?.['n']).toBe(50);

    // Both runners pinned a connection; the lock was real in both.
    expect(first.lockVerified).toBe(true);
    expect(other.lockVerified).toBe(true);

    await second.close();
  });

  test('a lock held by another session makes the second runner report, not wait forever', async () => {
    const folder = await migrationFolder([
      { tag: '0000_init', when: 1, sql: 'create table "it_users" ("id" int primary key);' },
    ]);

    // Hold the advisory lock on a separate connection while a runner tries.
    const holder = createDatabase({
      driver: createPostgresDriver({ client: pg.single }),
      logging: 'off',
    });
    const held = await holder.pinned(async (pinned) => {
      await pinned.query({
        sql: 'select pg_advisory_lock($1)',
        // The same key the runner derives — `application:connection`, so this is
        // the same lock (MIG-015).
        params: [advisoryLockKey(`it-blocked:${db.name}`).toString()],
      });
      const result = await migrate({ database: db, folder, name: 'it-blocked', waitMs: 0 });
      return result;
    });

    expect(held.locked).toBe(true);
    expect(held.applied).toEqual([]);
    expect(held.pending).toEqual(['0000_init']);

    await holder.close();
  });
});
