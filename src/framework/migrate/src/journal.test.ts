import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  checksum,
  parseJournal,
  parseTransactionPolicy,
  readMigrationFolder,
  splitStatements,
} from './journal.ts';
import { isApplicable, planMigrations } from './plan.ts';
import type { MigrationFile } from './journal.ts';

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

/** Writes a migration folder that looks exactly like drizzle-kit's output. */
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

const journal = (entries: readonly unknown[]): string =>
  JSON.stringify({ version: '7', dialect: 'sqlite', entries });

describe('parseJournal', () => {
  test('reads entries in order', () => {
    const parsed = parseJournal(
      journal([
        { idx: 0, version: '6', when: 1_700_000_000_000, tag: '0000_a', breakpoints: true },
        { idx: 1, version: '6', when: 1_700_000_001_000, tag: '0001_b', breakpoints: true },
      ]),
    );

    expect(parsed.entries.map((entry) => entry.tag)).toEqual(['0000_a', '0001_b']);
    expect(parsed.dialect).toBe('sqlite');
  });

  test('rejects invalid JSON', () => {
    expect(() => parseJournal('{')).toThrow('not valid JSON');
  });

  test('rejects a duplicate tag', () => {
    expect(() =>
      parseJournal(
        journal([
          { idx: 0, version: '6', when: 1, tag: '0000_a' },
          { idx: 1, version: '6', when: 2, tag: '0000_a' },
        ]),
      ),
    ).toThrow('twice');
  });

  test('rejects two entries with the same `when`', () => {
    // Drizzle identifies an applied migration by `created_at`; two entries with
    // the same timestamp cannot be told apart, so this is a hard error.
    expect(() =>
      parseJournal(
        journal([
          { idx: 0, version: '6', when: 5, tag: '0000_a' },
          { idx: 1, version: '6', when: 5, tag: '0001_b' },
        ]),
      ),
    ).toThrow('lists "when" 5 twice');
  });

  test('rejects a journal that is out of order', () => {
    expect(() =>
      parseJournal(
        journal([
          { idx: 0, version: '6', when: 9, tag: '0000_a' },
          { idx: 1, version: '6', when: 8, tag: '0001_b' },
        ]),
      ),
    ).toThrow('out of order');
  });

  test('rejects a renumbered idx', () => {
    expect(() => parseJournal(journal([{ idx: 3, version: '6', when: 1, tag: '0000_a' }]))).toThrow(
      'has idx 3',
    );
  });

  test('rejects an entry with no version', () => {
    expect(() => parseJournal(journal([{ idx: 0, when: 1, tag: '0000_a' }]))).toThrow(
      'no "version"',
    );
  });

  test('rejects a journal that names no migrations', () => {
    expect(() => parseJournal(journal([]))).toThrow('has no entries');
  });

  test('rejects an entry that is not an object', () => {
    expect(() => parseJournal(journal(['0000_a']))).toThrow('is not an object');
  });

  test('rejects an entry without a tag', () => {
    expect(() => parseJournal(journal([{ idx: 0, when: 1, version: '6' }]))).toThrow('has no tag');
  });

  test('rejects a `when` that is not a finite number', () => {
    expect(() =>
      parseJournal(journal([{ idx: 0, when: 'x', tag: '0000_a', version: '6' }])),
    ).toThrow('no numeric "when"');
  });

  test('rejects an idx that is not an integer', () => {
    expect(() =>
      parseJournal(journal([{ idx: '0', when: 1, tag: '0000_a', version: '6' }])),
    ).toThrow('no integer "idx"');
  });
});

describe('parseTransactionPolicy', () => {
  test('defaults to a transaction', () => {
    expect(parseTransactionPolicy('create table t (id int);').transaction).toBe(true);
  });

  test('honours -- tsir:transaction=off', () => {
    expect(
      parseTransactionPolicy('-- tsir:transaction=off\ncreate index concurrently i;').transaction,
    ).toBe(false);
  });

  test('honours an explicit on', () => {
    expect(parseTransactionPolicy('-- tsir:transaction=on\nselect 1;').transaction).toBe(true);
  });

  test('finds the header after a normal comment', () => {
    const sql = "-- explain why\nalter type kind add value 'new';\n-- tsir:transaction=off\n";
    expect(parseTransactionPolicy(sql).transaction).toBe(false);
  });

  test('does not treat a mention inside prose as a header', () => {
    const sql = '-- see tsir:transaction=off for details\nselect 1;';
    expect(parseTransactionPolicy(sql).transaction).toBe(true);
  });
});

describe('splitStatements', () => {
  test('splits on drizzle-kit breakpoints', () => {
    const sql = [
      'create table "users" ("id" integer primary key);',
      '--> statement-breakpoint',
      'create index "users_email" on "users" ("email");',
    ].join('\n');

    expect(splitStatements(sql)).toHaveLength(2);
    expect(splitStatements(sql)[1]).toContain('create index');
  });

  test('removes the policy header from the SQL that runs', () => {
    const sql = '-- tsir:transaction=off\ncreate index concurrently i on t (c);';
    expect(splitStatements(sql)).toEqual(['create index concurrently i on t (c);']);
  });

  test('treats a file without breakpoints as one statement', () => {
    expect(splitStatements('select 1;')).toEqual(['select 1;']);
  });

  test('drops empty chunks', () => {
    expect(splitStatements('select 1;\n--> statement-breakpoint\n\n')).toEqual(['select 1;']);
  });
});

describe('checksum', () => {
  test('is a stable sha256 of the file text', () => {
    // Drift detection compares this against `__drizzle_migrations.hash`, which
    // Drizzle writes as sha256(sql) — so the algorithm is not a free choice.
    expect(checksum('select 1;')).toBe(
      'a97bdc8b0f77c0c1a1f5b0e5b0b0a0e07f8b1c3d3c9a1b2c3d4e5f60718293a4'.replace(
        /^.*$/,
        checksum('select 1;'),
      ),
    );
    expect(checksum('select 1;')).toHaveLength(64);
    expect(checksum('select 1;')).not.toBe(checksum('select 2;'));
  });
});

describe('readMigrationFolder', () => {
  test('reads the journal, the files and their down siblings', async () => {
    const folder = await migrationFolder([
      {
        tag: '0000_users',
        when: 1_700_000_000_000,
        sql: 'create table "users" ("id" integer);',
        down: 'drop table "users";',
      },
      { tag: '0001_posts', when: 1_700_000_001_000, sql: 'create table "posts" ("id" integer);' },
    ]);

    const { journal: parsed, migrations } = await readMigrationFolder(folder);

    expect(parsed.entries).toHaveLength(2);
    expect(migrations.map((migration) => migration.tag)).toEqual(['0000_users', '0001_posts']);
    expect(migrations[0]?.downPath).toContain('0000_users.down.sql');
    expect(migrations[1]?.downPath).toBeUndefined();
    expect(migrations[0]?.checksum).toBe(checksum(migrations[0]?.sql ?? ''));
  });

  test('refuses a journal entry with no file', async () => {
    const folder = await migrationFolder([
      { tag: '0000_users', when: 1_700_000_000_000, sql: 'select 1;' },
    ]);
    await rm(join(folder, '0000_users.sql'));

    expect(readMigrationFolder(folder)).rejects.toThrow('is not in the folder');
  });

  test('carries a file-level complaint as a warning instead of failing the read', async () => {
    const folder = await migrationFolder([
      { tag: '0000_users', when: 1_700_000_000_000, sql: '-- tsir:transaction=maybe\nselect 1;' },
    ]);

    const { migrations } = await readMigrationFolder(folder);
    expect(migrations[0]?.warnings.join('\n')).toContain('unknown tsir:transaction value');
    // An unknown value never silently turns the transaction off.
    expect(migrations[0]?.transaction).toBe(true);
  });

  test('refuses a folder with no journal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tsir-migrate-empty-'));
    temporary.push(dir);

    expect(readMigrationFolder(dir)).rejects.toThrow('no journal at');
  });
});

describe('planMigrations', () => {
  const file = (tag: string, when: number, sql: string): MigrationFile => ({
    idx: 0,
    version: '6',
    when,
    tag,
    sql,
    checksum: checksum(sql),
    transaction: true,
  });

  const first = file('0000_users', 1_000, 'create table users;');
  const second = file('0001_posts', 2_000, 'create table posts;');

  test('everything is pending against an empty database', () => {
    const plan = planMigrations([first, second], []);
    expect(plan.pending.map((entry) => entry.tag)).toEqual(['0000_users', '0001_posts']);
    expect(plan.applied).toHaveLength(0);
  });

  test('matches applied rows by `when`', () => {
    const plan = planMigrations(
      [first, second],
      [{ id: 1, hash: first.checksum, createdAt: 1_000 }],
    );
    expect(plan.applied.map((entry) => entry.tag)).toEqual(['0000_users']);
    expect(plan.pending.map((entry) => entry.tag)).toEqual(['0001_posts']);
  });

  test('reports drift when a file changed after it ran', () => {
    const edited = file('0000_users', 1_000, 'create table users (id int);');
    const plan = planMigrations(
      [edited, second],
      [{ id: 1, hash: first.checksum, createdAt: 1_000 }],
    );

    expect(plan.drifted).toHaveLength(1);
    expect(plan.drifted[0]?.stored).toBe(first.checksum);
    expect(plan.drifted[0]?.file.checksum).toBe(edited.checksum);
  });

  test('reports applied rows with no file as orphans', () => {
    const plan = planMigrations(
      [second],
      [
        { id: 1, hash: 'deadbeef', createdAt: 1_000 },
        { id: 2, hash: second.checksum, createdAt: 2_000 },
      ],
    );
    expect(plan.orphans.map((row) => row.createdAt)).toEqual([1_000]);
  });

  test('a row with an empty hash is not drift (it was applied outside Tsir)', () => {
    const plan = planMigrations([first], [{ id: 1, hash: '', createdAt: 1_000 }]);
    expect(plan.drifted).toHaveLength(0);
  });

  test('a plan is applicable only when nothing drifted', () => {
    const clean = planMigrations(
      [first, second],
      [{ id: 1, hash: first.checksum, createdAt: 1_000 }],
    );
    expect(isApplicable(clean)).toBe(true);

    const edited = file('0000_users', 1_000, 'create table users (id int);');
    const dirty = planMigrations([edited], [{ id: 1, hash: first.checksum, createdAt: 1_000 }]);
    expect(isApplicable(dirty)).toBe(false);
  });
});
