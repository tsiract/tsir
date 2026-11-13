/**
 * The `sqlite` engine (`DB-027`).
 *
 * These run against a **real** `bun:sqlite` file in a temp directory, not a stub. The driver's
 * work is translating statements and holding a transaction boundary; a fake handle would let both
 * be wrong and still pass.
 */
import { describe, expect, test } from 'bun:test';
import { Database as Sqlite } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSqliteDriver, SQLITE_CAPABILITIES, type SqliteLike } from './sqlite.ts';

function withFile<T>(work: (handle: SqliteLike) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'tsir-sqlite-'));
  const handle = new Sqlite(join(dir, 'app.db')) as unknown as SqliteLike;
  return work(handle).finally(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

describe('sqlite driver', () => {
  test('creates, writes and reads through the real file', async () => {
    await withFile(async (handle) => {
      const db = createSqliteDriver({ handle });
      await db.query({ sql: 'create table t (id integer primary key, name text)', params: [] });
      await db.query({ sql: 'insert into t (name) values (?)', params: ['red bicycle'] });
      const result = await db.query({ sql: 'select id, name from t', params: [] });
      expect(result.rows).toEqual([{ id: 1, name: 'red bicycle' }]);
    });
  });

  test('an insert reports the rows it changed, not the rows it returned', async () => {
    // D1 reports this through `meta.changes`, and a SELECT reports `rows.length`. Reading the
    // wrong one makes every write look like a no-op.
    await withFile(async (handle) => {
      const db = createSqliteDriver({ handle });
      await db.query({ sql: 'create table t (id integer primary key)', params: [] });
      const result = await db.query({ sql: 'insert into t default values', params: [] });
      expect(result.changes).toBe(1);
      expect(result.rows).toEqual([]);
    });
  });

  test('batch is atomic: a failure rolls the whole list back', async () => {
    await withFile(async (handle) => {
      const db = createSqliteDriver({ handle });
      await db.query({ sql: 'create table t (id integer primary key)', params: [] });
      let caught: unknown;
      try {
        await db.batch([
          { sql: 'insert into t (id) values (1)', params: [] },
          { sql: 'insert into t (id) values (1)', params: [] },
        ]);
      } catch (thrown: unknown) {
        caught = thrown;
      }
      expect(caught).toBeDefined();
      const rows = await db.query({ sql: 'select count(*) as n from t', params: [] });
      expect(rows.rows).toEqual([{ n: 0 }]);
    });
  });

  test('begin is a real transaction, and a throw rolls it back', async () => {
    // `interactiveTx: true` is a claim D1 cannot make. If it were false here, `declare()` would
    // refuse this — so the rollback is what proves the claim.
    await withFile(async (handle) => {
      const db = createSqliteDriver({ handle });
      await db.query({ sql: 'create table t (id integer primary key)', params: [] });
      let caught: unknown;
      try {
        await db.begin?.(async (tx) => {
          await tx.query({ sql: 'insert into t (id) values (1)', params: [] });
          throw new Error('changed my mind');
        });
      } catch (thrown: unknown) {
        caught = thrown;
      }
      expect(String(caught)).toMatch(/changed my mind/u);
      const rows = await db.query({ sql: 'select count(*) as n from t', params: [] });
      expect(rows.rows).toEqual([{ n: 0 }]);
    });
  });

  test('begin commits on success', async () => {
    await withFile(async (handle) => {
      const db = createSqliteDriver({ handle });
      await db.query({ sql: 'create table t (id integer primary key)', params: [] });
      await db.begin?.(async (tx) => {
        await tx.query({ sql: 'insert into t (id) values (1)', params: [] });
      });
      const rows = await db.query({ sql: 'select count(*) as n from t', params: [] });
      expect(rows.rows).toEqual([{ n: 1 }]);
    });
  });

  test('a nested begin is refused rather than silently becoming a no-op', async () => {
    await withFile(async (handle) => {
      const db = createSqliteDriver({ handle });
      await db.query({ sql: 'create table t (id integer primary key)', params: [] });
      let caught: unknown;
      try {
        await db.begin?.(async (tx) => {
          await tx.begin?.(async () => Promise.resolve());
        });
      } catch (thrown: unknown) {
        caught = thrown;
      }
      expect(String(caught)).toMatch(/nested transaction/u);
    });
  });

  test('positional rows come back in select order', async () => {
    await withFile(async (handle) => {
      const db = createSqliteDriver({ handle });
      await db.query({ sql: 'create table t (a integer, b integer)', params: [] });
      await db.query({ sql: 'insert into t values (1, 2)', params: [] });
      const result = await db.query({ sql: 'select a, b from t', params: [], format: 'arrays' });
      expect(result.rows).toEqual([[1, 2]]);
    });
  });

  test('health is ok and names the engine sqlite, not d1', async () => {
    await withFile(async (handle) => {
      const health = await createSqliteDriver({ handle }).health();
      expect(health.ok).toBe(true);
      // The distinction the union exists for: a file has no Cloudflare binding behind it.
      expect(health.engine).toBe('sqlite');
    });
  });

  test('the capabilities name the one thing a file has and a binding does not', () => {
    expect(SQLITE_CAPABILITIES.interactiveTx).toBe(true);
    expect(SQLITE_CAPABILITIES.placeholder).toBe('question');
    expect(SQLITE_CAPABILITIES.engine).toBe('sqlite');
    expect(SQLITE_CAPABILITIES.pinnedConnection).toBe(false);
  });
});
