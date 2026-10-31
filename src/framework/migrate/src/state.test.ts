import { describe, expect, test } from 'bun:test';

import { emptyState, fakeD1Database } from './fake.test-support.ts';
import {
  AUDIT_TABLE,
  auditTableDdl,
  bind,
  insertRunStatement,
  isMissingTable,
  JOURNAL_TABLE,
  journalTableDdl,
  readApplied,
  readRuns,
} from './state.ts';

describe('the two tables', () => {
  test('placeholders follow the engine, not the driver', () => {
    expect(bind('postgres', 2)).toBe('$2');
    expect(bind('d1', 2)).toBe('?');
  });

  test('the journal table matches what Drizzle expects, per engine', () => {
    expect(journalTableDdl('postgres')).toContain('serial primary key');
    expect(journalTableDdl('d1')).toContain('integer primary key autoincrement');
    expect(journalTableDdl('d1')).toContain(JOURNAL_TABLE);
    // The sidecar is a separate table, never a second journal wearing a new name.
    expect(journalTableDdl('d1')).not.toContain(AUDIT_TABLE);
  });

  test('the audit sidecar carries the run, not just the fact of the run', () => {
    const ddl = auditTableDdl('postgres');
    for (const column of [
      'run_id',
      'tag',
      'checksum',
      'host',
      'actor',
      'duration_ms',
      'applied_at',
    ]) {
      expect(ddl).toContain(`"${column}"`);
    }
  });

  test('a schema qualifies both tables', () => {
    expect(journalTableDdl('postgres', { schema: 'billing' })).toContain(
      '"billing"."__drizzle_migrations"',
    );
    expect(auditTableDdl('postgres', { schema: 'billing', audit: 'runs' })).toContain(
      '"billing"."runs"',
    );
  });

  test('the run insert binds one value per column', () => {
    const sql = insertRunStatement(
      'postgres',
      {
        runId: 'r',
        tag: 't',
        checksum: 'c',
        host: 'h',
        actor: 'a',
        durationMs: 1,
        appliedAt: 2,
      },
      {},
    ).sql;

    // The regression this guards: seven columns, seven placeholders.
    expect(sql.match(/\$\d+/g)).toEqual(['$1', '$2', '$3', '$4', '$5', '$6', '$7']);
    expect(
      insertRunStatement(
        'postgres',
        {
          runId: 'r',
          tag: 't',
          checksum: 'c',
          host: 'h',
          actor: 'a',
          durationMs: 1,
          appliedAt: 2,
        },
        {},
      ).params,
    ).toHaveLength(7);
    expect(
      insertRunStatement(
        'd1',
        {
          runId: 'r',
          tag: 't',
          checksum: 'c',
          host: 'h',
          actor: 'a',
          durationMs: 1,
          appliedAt: 2,
        },
        {},
      ).sql.match(/\?/g),
    ).toHaveLength(7);
  });
});

describe('reading rows', () => {
  test('applied rows survive the column types a client may hand back', async () => {
    const state = emptyState();
    state.rows = (sql) =>
      sql.includes('from "__drizzle_migrations"')
        ? [
            { id: 1, hash: 'abc', created_at: '1700000000000' },
            // A `bigint` column and a row written by something that did not hash.
            { hash: 12n, created_at: 5n },
            {},
          ]
        : undefined;

    const rows = await readApplied(fakeD1Database(state));

    expect(rows[0]).toEqual({ id: 1, hash: 'abc', createdAt: 1_700_000_000_000 });
    // coercion-ok: the row deliberately carries a bigint and a non-string hash.
    expect(rows[1]?.createdAt).toBe(5);
    expect(rows[1]?.hash).toBe('');
    expect(Number.isNaN(rows[2]?.createdAt)).toBe(true);
  });

  test('audit rows are mapped, and a missing table is not an error', async () => {
    const state = emptyState();
    state.rows = (sql) =>
      sql.includes('from "__tsir_migration_runs"')
        ? [
            {
              run_id: 7,
              tag: '0000_a',
              checksum: 'c',
              host: 'h',
              actor: 'a',
              duration_ms: '12',
              applied_at: 5n,
            },
          ]
        : undefined;

    const runs = await readRuns(fakeD1Database(state));
    expect(runs).toEqual([
      {
        runId: '', // not a string in the row — reported as empty, never "[object Object]"
        tag: '0000_a',
        checksum: 'c',
        host: 'h',
        actor: 'a',
        durationMs: 12,
        appliedAt: 5,
      },
    ]);

    const missing = emptyState();
    missing.missingTable = /__tsir_migration_runs/;
    expect(await readRuns(fakeD1Database(missing))).toEqual([]);
  });
});

describe('isMissingTable', () => {
  test('recognises both engines and nothing else', () => {
    expect(isMissingTable(new Error('no such table: __drizzle_migrations'))).toBe(true);
    expect(isMissingTable(new Error('relation "x" does not exist'))).toBe(true);
    expect(isMissingTable(new Error('syntax error at or near "selectt"'))).toBe(false);
    expect(isMissingTable('no such table: x')).toBe(true);
  });
});
