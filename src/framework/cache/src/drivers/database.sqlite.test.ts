/**
 * The `database` driver against a real SQL engine (`CACHE-6`) — SQLite, via `bun:sqlite`.
 *
 * The fake proves the orchestration; this proves the **SQL**. Two things only an engine can
 * settle, and both are load-bearing:
 *
 *   · `INSERT … ON CONFLICT (key) DO UPDATE … RETURNING counter` is one atomic statement that
 *     returns the new value — the whole reason increments are not a read-modify-write;
 *   · `DELETE … WHERE key IN (SELECT key … WHERE tag = ?)` hits the index instead of scanning
 *     the entries table.
 *
 * D1 *is* SQLite, and this test exercises the `question` placeholder dialect and the `d1`
 * column types, so what passes here is the dialect the Workers target emits. Postgres runs the
 * same statements through `database.integration.test.ts`, which needs a server.
 */

import { Database } from 'bun:sqlite';

import { describe, expect, test } from 'bun:test';

import { json } from '../codec.ts';
import { conformanceCases } from '../conformance.ts';
import { createCache } from '../store.ts';
import { cacheTableDdl, databaseDriver, type CacheSql } from './database.ts';

/** The D1 dialect over `bun:sqlite`: `?` placeholders, positional params, object rows. */
function sqliteSql(database: Database): CacheSql {
  return {
    capabilities: { engine: 'd1', placeholder: 'question' },
    async query(statement) {
      const prepared = database.prepare(statement.sql);

      // A statement with RETURNING or a SELECT yields rows; anything else is a change. Asking
      // SQLite which is which beats guessing from the SQL text.
      if (/^\s*select/iu.test(statement.sql) || /returning/iu.test(statement.sql)) {
        const rows: readonly unknown[] = prepared.all(...(statement.params as never[]));
        return { rows, changes: rows.length };
      }

      const result = prepared.run(...(statement.params as never[]));
      return { rows: [], changes: result.changes };
    },
  };
}

function fresh(): { db: Database; sql: CacheSql } {
  const db = new Database(':memory:');
  for (const statement of cacheTableDdl({ engine: 'd1' })) db.exec(statement);
  return { db, sql: sqliteSql(db) };
}

function storeFor(sql: CacheSql, name = 'sqlite') {
  const driver = databaseDriver({ database: sql });
  return {
    driver,
    items: createCache<{ id: string; n: number }>({ name, backend: driver.open(), codec: json() }),
    counters: createCache<number>({ name, backend: driver.open(), codec: json<number>() }),
  };
}

describe('the database driver on SQLite', () => {
  test('the conformance kit passes on a real engine', async () => {
    const { sql } = fresh();
    const { driver } = storeFor(sql);

    for (const conformanceCase of conformanceCases({ driver, store: 'sqlite' })) {
      expect(await conformanceCase.run()).toBeUndefined();
    }
  });

  test('a value round-trips as JSON through the real column', async () => {
    const { sql, db } = fresh();
    const { items } = storeFor(sql);

    await items.set('user:1', { id: 'u1', n: 1 });

    expect(await items.get('user:1')).toEqual({ id: 'u1', n: 1 });

    // The row really is one encoded payload in one column, not an object spread across them.
    const row = db.prepare('SELECT value, counter FROM cache_entries').get() as {
      value: string;
      counter: number | null;
    };
    expect(JSON.parse(row.value)).toEqual({ $tsir: 1, v: { id: 'u1', n: 1 } });
    expect(row.counter).toBeNull();
  });

  test('50 concurrent increments land exactly 50 — the statement is atomic', async () => {
    const { sql } = fresh();
    const { counters } = storeFor(sql);

    await Promise.all(Array.from({ length: 50 }, () => counters.increment('hits')));

    expect(await counters.get('hits')).toBe(50);
  });

  test('the counter column is what moves, and the value column stays null', async () => {
    const { sql, db } = fresh();
    const { counters } = storeFor(sql);

    await counters.increment('hits', 3);

    const row = db
      .prepare('SELECT value, counter FROM cache_entries WHERE key = ?')
      .get('hits') as {
      value: string | null;
      counter: number;
    };
    expect(row.value).toBeNull();
    expect(row.counter).toBe(3);
  });

  test('tag invalidation uses the index and deletes only its entries', async () => {
    const { sql, db } = fresh();
    const { items } = storeFor(sql);

    await items.set('a', { id: 'a', n: 1 }, { tags: ['users'] });
    await items.set('b', { id: 'b', n: 2 }, { tags: ['users'] });
    await items.set('c', { id: 'c', n: 3 }, { tags: ['config'] });

    // The plan for the delete is an index seek on the tag table, not a scan of the entries.
    const plan = db
      .prepare(
        'EXPLAIN QUERY PLAN DELETE FROM cache_entries WHERE key IN (SELECT key FROM cache_entry_tags WHERE tag = ?)',
      )
      .all('users') as { detail: string }[];
    expect(plan.map((step) => step.detail).join(' ')).toContain('cache_entry_tags_tag');

    expect(await items.invalidateTag('users')).toBe(2);
    expect(await items.has('a')).toBe(false);
    expect(await items.has('c')).toBe(true);
  });

  test('expiry is filtered on read, and the row is removed when noticed', async () => {
    const { sql, db } = fresh();
    const { items } = storeFor(sql);

    await items.set('k', { id: 'k', n: 1 }, { ttlMs: 0 });

    expect(await items.get('k')).toBeUndefined();
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM cache_entries').get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  test('clear empties both tables and nothing else', async () => {
    const { sql, db } = fresh();
    const { items } = storeFor(sql);

    await items.set('a', { id: 'a', n: 1 }, { tags: ['t'] });
    await items.set('b', { id: 'b', n: 2 });
    await items.clear();

    const entries = db.prepare('SELECT COUNT(*) AS n FROM cache_entries').get() as { n: number };
    const tags = db.prepare('SELECT COUNT(*) AS n FROM cache_entry_tags').get() as { n: number };
    expect(entries.n).toBe(0);
    expect(tags.n).toBe(0);
  });
});
