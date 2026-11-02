import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { checksum } from './journal.ts';
import {
  emptyState,
  fakeD1Database,
  fakePgDatabase,
  fakePgDatabaseWithReserve,
  type FakeState,
} from './fake.test-support.ts';
import { migrate, readAppliedOrEmpty } from './migrate.ts';
import { acquireMigrationLock, advisoryLockKey } from './lock.ts';
import { describeRollback, planRollback, rollback } from './rollback.ts';
import { describeStatus, migrationStatus, statusIsHealthy } from './status.ts';
import { preflightGuidance } from './guidance.ts';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface EntryInput {
  readonly tag: string;
  readonly when: number;
  readonly sql: string;
  readonly down?: string;
}

async function migrationFolder(entries: readonly EntryInput[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tsir-migrate-'));
  temporary.push(dir);
  await mkdir(join(dir, 'meta'), { recursive: true });
  await writeFile(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: entries.map((entry, idx) => ({
        idx,
        version: '6',
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

const USERS: EntryInput = {
  tag: '0000_users',
  when: 1_700_000_000_000,
  sql: 'create table "users" ("id" integer primary key);',
  down: 'drop table "users";',
};

const POSTS: EntryInput = {
  tag: '0001_posts',
  when: 1_700_000_001_000,
  sql: [
    'create table "posts" ("id" integer primary key);',
    '--> statement-breakpoint',
    'create index "posts_user" on "posts" ("id");',
  ].join('\n'),
  down: 'drop table "posts";',
};

const applied = (state: FakeState): readonly number[] => state.journal.map((row) => row.created_at);

const logs = (state: FakeState): readonly string[] => state.statements.map((entry) => entry.sql);

describe('migrate on D1', () => {
  test('applies pending migrations in journal order and records them', async () => {
    const folder = await migrationFolder([USERS, POSTS]);
    const state = emptyState();

    const result = await migrate({
      database: fakeD1Database(state),
      folder,
      name: 'test-app',
      runId: 'run-1',
      now: () => 1_000,
    });

    expect(result.applied.map((entry) => entry.tag)).toEqual(['0000_users', '0001_posts']);
    expect(result.applied.every((entry) => entry.atomic)).toBe(true);
    expect(applied(state)).toEqual([USERS.when, POSTS.when]);
    // The journal hash is the file checksum, which is what drift detection reads.
    expect(state.journal[0]?.hash).toBe(checksum(USERS.sql));
    expect(state.runs.map((run) => run.tag)).toEqual(['0000_users', '0001_posts']);
    expect(state.runs[0]?.run_id).toBe('run-1');
  });

  test('a second run applies nothing', async () => {
    const folder = await migrationFolder([USERS]);
    const state = emptyState();
    const database = fakeD1Database(state);

    await migrate({ database, folder, name: 'test-app' });
    const second = await migrate({ database, folder, name: 'test-app' });

    expect(second.applied).toHaveLength(0);
    expect(second.pending).toHaveLength(0);
    expect(applied(state)).toEqual([USERS.when]);
    expect(state.runs).toHaveLength(1);
  });

  test('statements and the journal row go through one batch', async () => {
    const folder = await migrationFolder([POSTS]);
    const state = emptyState();

    await migrate({ database: fakeD1Database(state), folder, name: 'test-app' });

    // D1's batch *is* the transaction: the DDL and the bookkeeping commit
    // together or not at all.
    expect(logs(state).some((sql) => sql.includes('create index "posts_user"'))).toBe(true);
    expect(logs(state).some((sql) => sql.includes('insert into "__drizzle_migrations"'))).toBe(
      true,
    );
  });

  test('a failing statement leaves nothing applied', async () => {
    const folder = await migrationFolder([USERS, POSTS]);
    const state = emptyState();
    state.failOn = /create index/;

    expect(migrate({ database: fakeD1Database(state), folder, name: 'test-app' })).rejects.toThrow(
      'failed at statement',
    );

    // The first migration committed (its own batch), the second rolled back.
    expect(applied(state)).toEqual([USERS.when]);
    expect(state.runs.map((run) => run.tag)).toEqual(['0000_users']);
  });

  test('refuses to run when an applied migration was edited', async () => {
    const folder = await migrationFolder([USERS]);
    const state = emptyState();
    state.journal.push({ id: 1, hash: 'not-the-real-hash', created_at: USERS.when });

    expect(migrate({ database: fakeD1Database(state), folder, name: 'test-app' })).rejects.toThrow(
      'changed on disk',
    );
    // Nothing ran: drift is refused before the first statement. The only
    // statement the applier issued was the read that discovered the drift.
    expect(
      logs(state).filter((sql) => /^(insert|create|delete|drop|alter)/i.test(sql)),
    ).toHaveLength(0);
  });

  test('honours tsir:transaction=off and says the migration was not atomic', async () => {
    const folder = await migrationFolder([
      {
        tag: '0002_index',
        when: 1_700_000_002_000,
        sql: '-- tsir:transaction=off\ncreate index concurrently "users_email" on "users" ("id");',
      },
    ]);
    const state = emptyState();

    const result = await migrate({ database: fakeD1Database(state), folder, name: 'test-app' });

    expect(result.applied[0]?.atomic).toBe(false);
    // The header never reaches the engine, and the statement is not batched.
    expect(logs(state).some((sql) => sql.startsWith('create index concurrently'))).toBe(true);
    expect(logs(state).some((sql) => sql.includes('tsir:transaction'))).toBe(false);
  });

  test('an empty migration file is an error, not a no-op', async () => {
    const folder = await migrationFolder([
      { tag: '0003_empty', when: 1_700_000_003_000, sql: '   \n' },
    ]);

    expect(
      migrate({ database: fakeD1Database(emptyState()), folder, name: 'test-app' }),
    ).rejects.toThrow('contains no statements');
  });
});

describe('migrate on Postgres', () => {
  test('takes the advisory lock and applies inside interactive transactions', async () => {
    const folder = await migrationFolder([USERS, POSTS]);
    const state = emptyState();

    const result = await migrate({ database: fakePgDatabase(state), folder, name: 'test-app' });

    expect(result.lockSupported).toBe(true);
    expect(result.applied).toHaveLength(2);
    expect(logs(state).some((sql) => sql.includes('pg_try_advisory_lock'))).toBe(true);
    expect(logs(state).some((sql) => sql.includes('pg_advisory_unlock'))).toBe(true);
  });

  test('a held lock reports "in progress" and applies nothing', async () => {
    const folder = await migrationFolder([USERS]);
    const state = emptyState();
    state.lockHeld = true;

    const result = await migrate({ database: fakePgDatabase(state), folder, name: 'test-app' });

    expect(result.locked).toBe(true);
    expect(result.applied).toHaveLength(0);
    expect(result.pending).toEqual(['0000_users']);
    expect(applied(state)).toHaveLength(0);
  });

  test('plans without executing when dryRun is set', async () => {
    const folder = await migrationFolder([USERS, POSTS]);
    const state = emptyState();

    const result = await migrate({
      database: fakePgDatabase(state),
      folder,
      name: 'test-app',
      dryRun: true,
    });

    expect(result.pending).toEqual(['0000_users', '0001_posts']);
    expect(applied(state)).toHaveLength(0);
    // Reading state is allowed; writing is not.
    expect(logs(state).filter((sql) => /^(insert|create|delete)/i.test(sql))).toHaveLength(0);
  });
});

describe('the lock key is per connection (MIG-015)', () => {
  test('two connections of one application do not exclude each other', async () => {
    const state = emptyState();
    const database = fakePgDatabase(state);

    await acquireMigrationLock(database, { name: 'acme', connection: 'reporting' });

    const lock = state.statements.find((entry) => entry.sql.includes('pg_try_advisory_lock'));
    expect(lock?.params[0]).toBe(advisoryLockKey('acme:reporting').toString());
    // Different from the same app on another connection: a lock shared between
    // them would serialise two unrelated deployments.
    expect(advisoryLockKey('acme:reporting')).not.toBe(advisoryLockKey('acme:app'));
  });

  test('the connection defaults to the database’s own name', async () => {
    const state = emptyState();
    const database = fakePgDatabase(state);

    await acquireMigrationLock(database, { name: 'acme' });

    const lock = state.statements.find((entry) => entry.sql.includes('pg_try_advisory_lock'));
    expect(lock?.params[0]).toBe(advisoryLockKey(`acme:${database.name}`).toString());
  });
});

describe('advisoryLockKey', () => {
  test('is stable and app-specific', () => {
    expect(advisoryLockKey('acme-api')).toBe(advisoryLockKey('acme-api'));
    expect(advisoryLockKey('acme-api')).not.toBe(advisoryLockKey('other-api'));
    // Fits Postgres `bigint` (signed 64-bit) by construction.
    expect(typeof advisoryLockKey('acme-api')).toBe('bigint');
  });
});

describe('migrationStatus', () => {
  test('reports applied, pending and drifted tags', async () => {
    const folder = await migrationFolder([USERS, POSTS]);
    const state = emptyState();
    state.journal.push({ id: 1, hash: checksum(USERS.sql), created_at: USERS.when });

    const status = await migrationStatus(fakeD1Database(state), { folder });

    expect(status.tags.applied).toEqual(['0000_users']);
    expect(status.tags.pending).toEqual(['0001_posts']);
    expect(status.tags.drifted).toEqual([]);
    expect(describeStatus(status)).toBe('1 applied · 1 pending');

    state.journal[0] = { id: 1, hash: 'edited', created_at: USERS.when };
    const drifted = await migrationStatus(fakeD1Database(state), { folder });
    expect(drifted.tags.drifted).toEqual(['0000_users']);
    expect(describeStatus(drifted)).toContain('1 drifted');
  });

  test('a database with no journal table is fresh, not broken', async () => {
    const folder = await migrationFolder([USERS]);
    const state = emptyState();

    const status = await migrationStatus(fakeD1Database(state), { folder });
    expect(status.fresh).toBe(true);
    expect(status.tags.pending).toEqual(['0000_users']);
  });
});

describe('rollback', () => {
  test('plans an undo list newest first, stopping at the target', async () => {
    const folder = await migrationFolder([USERS, POSTS]);
    const { readMigrationFolder } = await import('./journal.ts');
    const { migrations } = await readMigrationFolder(folder);

    const plan = planRollback(
      migrations,
      [{ createdAt: USERS.when }, { createdAt: POSTS.when }],
      '0000_users',
    );

    expect(plan.undo.map((file) => file.tag)).toEqual(['0001_posts']);
    expect(plan.keep.map((file) => file.tag)).toEqual(['0000_users']);
    expect(describeRollback(plan)).toBe('would undo 0001_posts');
  });

  test('refuses a migration with no down file', async () => {
    const folder = await migrationFolder([
      { tag: '0009_nodesc', when: 1_700_000_009_000, sql: 'create table t (id int);' },
    ]);
    const state = emptyState();
    state.journal.push({
      id: 1,
      hash: checksum('create table t (id int);'),
      created_at: 1_700_000_009_000,
    });

    expect(
      rollback({
        database: fakeD1Database(state),
        folder,
        name: 'test-app',
        to: 'empty',
        allowDestructive: true,
        confirm: '0009_nodesc',
      }),
    ).rejects.toThrow('no down migration');
  });

  test('refuses a destructive rollback without the flag', async () => {
    const folder = await migrationFolder([USERS]);
    const state = emptyState();
    state.journal.push({ id: 1, hash: checksum(USERS.sql), created_at: USERS.when });

    expect(
      rollback({ database: fakeD1Database(state), folder, name: 'test-app', to: 'empty' }),
    ).rejects.toThrow('destroys data');
  });

  test('refuses a confirmation that does not match the newest migration', async () => {
    const folder = await migrationFolder([USERS]);
    const state = emptyState();
    state.journal.push({ id: 1, hash: checksum(USERS.sql), created_at: USERS.when });

    expect(
      rollback({
        database: fakeD1Database(state),
        folder,
        name: 'test-app',
        to: 'empty',
        allowDestructive: true,
        confirm: 'wrong',
      }),
    ).rejects.toThrow('does not match');
  });

  test('runs the down file and removes the journal row', async () => {
    const folder = await migrationFolder([USERS, POSTS]);
    const state = emptyState();
    state.journal.push(
      { id: 1, hash: checksum(USERS.sql), created_at: USERS.when },
      { id: 2, hash: checksum(POSTS.sql), created_at: POSTS.when },
    );

    const result = await rollback({
      database: fakeD1Database(state),
      folder,
      name: 'test-app',
      to: '0000_users',
      allowDestructive: true,
      confirm: '0001_posts',
    });

    expect(result.undone).toEqual(['0001_posts']);
    expect(applied(state)).toEqual([USERS.when]);
    expect(logs(state).some((sql) => sql.includes('drop table "posts"'))).toBe(true);
  });

  test('an unknown target is a refusal, not a silent no-op', async () => {
    const folder = await migrationFolder([USERS]);
    const state = emptyState();
    state.journal.push({ id: 1, hash: checksum(USERS.sql), created_at: USERS.when });

    expect(
      rollback({
        database: fakeD1Database(state),
        folder,
        name: 'test-app',
        to: '0000_typo',
        allowDestructive: true,
      }),
    ).rejects.toThrow('no migration named');
  });
});

describe('preflightGuidance', () => {
  test('prints only for production', () => {
    expect(preflightGuidance({ engine: 'd1', environment: 'development', pending: 3 })).toEqual([]);
  });

  test('names snapshot, lock impact and rollback plan', () => {
    const lines = preflightGuidance({ engine: 'postgres', environment: 'production', pending: 3 });
    const text = lines.join('\n');

    expect(text).toContain('snapshot');
    expect(text).toContain('lock impact');
    expect(text).toContain('rollback plan');
    expect(text).toContain('src/docs/migrations.md');
  });

  test('calls out a migration that cannot run in a transaction', () => {
    const lines = preflightGuidance({
      engine: 'postgres',
      environment: 'production',
      pending: 1,
      nonTransactional: ['0004_idx'],
    });
    expect(lines.join('\n')).toContain('non-atomic: 0004_idx');
  });

  test('tells a D1 operator there is no lock', () => {
    const lines = preflightGuidance({ engine: 'd1', environment: 'production', pending: 1 });
    expect(lines.join('\n')).toContain('no advisory lock');
  });
});

describe('connection pinning (DB-018, MIG-003)', () => {
  test('a client that can reserve runs the whole migration on that connection', async () => {
    const state = emptyState();
    const folder = await migrationFolder([
      { tag: '0000_init', when: 1, sql: 'create table "t" ("id" integer);' },
    ]);

    const result = await migrate({
      database: fakePgDatabaseWithReserve(state),
      folder,
      name: 'acme',
      waitMs: 0,
    });

    expect(result.applied.map((entry) => entry.tag)).toEqual(['0000_init']);
    // Lock, DDL and unlock all happened inside the reserved scope, which is the
    // only way a session-scoped advisory lock excludes anything.
    expect(state.pins).toEqual(['reserved', 'released']);
    expect(result.lockVerified).toBe(true);
  });

  test('a client that cannot reserve reports the lock as unverified, not as held', async () => {
    const state = emptyState();
    const folder = await migrationFolder([{ tag: '0000_init', when: 1, sql: 'select 1;' }]);

    const result = await migrate({ database: fakePgDatabase(state), folder, name: 'acme' });

    expect(result.lockVerified).toBe(false);
    expect(result.lockSupported).toBe(true);
  });

  test('D1 has no lock to verify, and says so through lockSupported', async () => {
    const state = emptyState();
    const folder = await migrationFolder([
      { tag: '0000_init', when: 1, sql: 'create table "t" ("id" integer);' },
    ]);

    const result = await migrate({ database: fakeD1Database(state), folder, name: 'acme' });

    expect(result.lockSupported).toBe(false);
    expect(result.lockVerified).toBe(true);
  });
});

describe('a fresh database and the audit trail', () => {
  test('a database with no journal table reads as zero applied rows', async () => {
    const state = emptyState();
    state.missingTable = /__drizzle_migrations/;

    expect(await readAppliedOrEmpty(fakeD1Database(state))).toEqual([]);
  });

  test('status reports recent runs and stays healthy while work is merely pending', async () => {
    const folder = await migrationFolder([USERS, POSTS]);
    const state = emptyState();
    state.journal.push({ id: 1, hash: checksum(USERS.sql), created_at: USERS.when });
    state.runs.push({
      run_id: 'run-1',
      tag: '0000_users',
      checksum: checksum(USERS.sql),
      host: 'host-1',
      actor: 'ci',
      duration_ms: 12,
      applied_at: 1_000,
    });

    const status = await migrationStatus(fakeD1Database(state), { folder, runs: 5 });

    expect(status.runs.map((run) => run.runId)).toEqual(['run-1']);
    expect(statusIsHealthy(status)).toBe(true);
    expect(describeStatus(status)).toBe('1 applied · 1 pending');

    state.journal[0] = { id: 1, hash: 'edited', created_at: USERS.when };
    const drifted = await migrationStatus(fakeD1Database(state), { folder });
    expect(statusIsHealthy(drifted)).toBe(false);
    expect(describeStatus(drifted)).toBe('1 applied · 1 pending · 1 drifted');
  });

  test('an applied row with no file is reported as orphaned, not ignored', async () => {
    const folder = await migrationFolder([USERS]);
    const state = emptyState();
    state.journal.push(
      { id: 1, hash: checksum(USERS.sql), created_at: USERS.when },
      { id: 2, hash: 'deleted-file', created_at: 1 },
    );

    const status = await migrationStatus(fakeD1Database(state), { folder });

    expect(status.tags.orphaned).toEqual(['1']);
    expect(describeStatus(status)).toContain('1 orphaned');
    expect(statusIsHealthy(status)).toBe(false);
  });
});

describe('rollback edge paths', () => {
  test('nothing applied means nothing to undo', async () => {
    const folder = await migrationFolder([USERS]);

    const result = await rollback({
      database: fakeD1Database(emptyState()),
      folder,
      name: 'test-app',
      to: 'empty',
      allowDestructive: true,
      confirm: '0000_users',
    });

    expect(result.undone).toEqual([]);
    expect(result.locked).toBe(false);
  });

  test('a held lock reports and changes nothing', async () => {
    const folder = await migrationFolder([USERS, POSTS]);
    const state = emptyState();
    state.journal.push(
      { id: 1, hash: checksum(USERS.sql), created_at: USERS.when },
      { id: 2, hash: checksum(POSTS.sql), created_at: POSTS.when },
    );
    state.lockHeld = true;

    const result = await rollback({
      database: fakePgDatabase(state),
      folder,
      name: 'test-app',
      to: '0000_users',
      allowDestructive: true,
      confirm: '0001_posts',
    });

    expect(result.locked).toBe(true);
    expect(result.undone).toEqual([]);
    expect(applied(state)).toEqual([USERS.when, POSTS.when]);
  });

  test('rechecks applied rows after acquiring the lock', async () => {
    const folder = await migrationFolder([USERS, POSTS]);
    const state = emptyState();
    state.journal.push(
      { id: 1, hash: checksum(USERS.sql), created_at: USERS.when },
      { id: 2, hash: checksum(POSTS.sql), created_at: POSTS.when },
    );
    state.rows = (sql) => {
      if (/pg_try_advisory_lock/i.test(sql)) {
        state.journal.splice(1, 1); // another runner rolled back the newer migration while we waited
        return [{ locked: true }];
      }
      return undefined;
    };
    const result = await rollback({
      database: fakePgDatabaseWithReserve(state),
      folder,
      name: 'test-app',
      to: '0000_users',
      allowDestructive: true,
      confirm: '0001_posts',
    });
    expect(result.undone).toEqual([]);
    expect(logs(state).some((sql) => sql.includes('drop table "posts"'))).toBe(false);
  });

  test('Postgres runs the down file inside an interactive transaction', async () => {
    const folder = await migrationFolder([USERS, POSTS]);
    const state = emptyState();
    state.journal.push(
      { id: 1, hash: checksum(USERS.sql), created_at: USERS.when },
      { id: 2, hash: checksum(POSTS.sql), created_at: POSTS.when },
    );

    const result = await rollback({
      database: fakePgDatabase(state),
      folder,
      name: 'test-app',
      to: '0000_users',
      allowDestructive: true,
      confirm: '0001_posts',
    });

    expect(result.undone).toEqual(['0001_posts']);
    expect(applied(state)).toEqual([USERS.when]);
    expect(logs(state).some((sql) => sql.includes('drop table "posts"'))).toBe(true);
  });
});
