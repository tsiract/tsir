/**
 * `databaseQuery` has one job that is easy to get subtly wrong and impossible to see when it is:
 * the format of the rows it hands back. A test that asserts "it called `db.query`" would pass on
 * a broken adapter, so these drive a real `sqliteEngine` over it and read the search results.
 */
import { describe, expect, test } from 'bun:test';

import { databaseQuery } from './database-query.ts';
import { sqliteEngine } from './drivers.ts';

/** A `Database` stand-in that records statements and answers rows as the driver would. */
function fakeDatabase(rows: readonly Record<string, unknown>[] = []) {
  const seen: { sql: string; params: readonly unknown[]; format?: string }[] = [];
  return {
    seen,
    query(statement: {
      readonly sql: string;
      readonly params: readonly unknown[];
      readonly format?: 'objects' | 'arrays';
    }) {
      seen.push({
        sql: statement.sql,
        params: statement.params,
        ...(statement.format === undefined ? {} : { format: statement.format }),
      });
      return Promise.resolve({ rows });
    },
  };
}

describe('databaseQuery', () => {
  test('pins the row format the engines read, whatever the caller wanted', async () => {
    // Not a preference: `sqliteEngine` reads `row['id']`. Object rows would be keyed `0`, `1`, so
    // the pin is the difference between a working search and an empty one.
    const db = fakeDatabase();
    await databaseQuery(db)('SELECT 1', []);
    expect(db.seen[0]?.format).toBe('arrays');
  });

  test('passes the literal and the positional parameters through unchanged', async () => {
    const db = fakeDatabase();
    await databaseQuery(db)('SELECT * FROM search_index WHERE id = ?', ['post-1']);
    expect(db.seen[0]?.sql).toBe('SELECT * FROM search_index WHERE id = ?');
    expect(db.seen[0]?.params).toEqual(['post-1']);
  });

  test('a real sqlite engine indexes and finds a document through it', async () => {
    // The point of the adapter: a `Database` in, working full-text search out. The fake answers
    // the one read the engine performs, in the shape SQLite's FTS5 would.
    const db = fakeDatabase([{ id: 'post-1', score: 0.9 }]);
    const engine = sqliteEngine(databaseQuery(db));

    await engine.index({ id: 'post-1', fields: { title: 'a red bicycle' } });
    expect(db.seen[0]?.params).toEqual(['post-1', 'a red bicycle']);

    const hits = await engine.search('bicycle', 5);
    expect(hits).toEqual([{ id: 'post-1', score: 0.9 }]);
    // Four statements would be fine too — what matters is that none of them slipped back to the
    // object format, which the engine cannot read.
    expect(db.seen.length).toBe(2);
    expect(db.seen.every((statement) => statement.format === 'arrays')).toBe(true);
  });

  test('a failed statement is not swallowed', async () => {
    // The engines treat a thrown error as a failed index write. Turning it into an empty result
    // would make a broken table look like a document that does not match.
    const broken = {
      query() {
        return Promise.reject(new Error('no such table: search_index'));
      },
    };
    const engine = sqliteEngine(databaseQuery(broken));
    let caught: unknown;
    try {
      await engine.search('anything', 5);
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(String(caught)).toMatch(/no such table/u);
  });
});
