/**
 * The `database` driver against a real Postgres server (`CACHE-6`).
 *
 * The unit suite proves the orchestration against a fake. This proves the things only a
 * server can: that the DDL is valid, that `ON CONFLICT … RETURNING counter` is atomic under
 * real concurrency, and that tag invalidation is an index seek rather than a scan that
 * happens to return the right rows.
 *
 * Run it with `DATABASE_URL=… bun src/tools/test-integration.ts`. Without a URL the whole
 * suite skips — a skipped test is honest; a test that silently passes without a database is
 * not.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

// Relative imports, not `@tsir/database`: a test-only need must not become a dependency in
// the manifest, because a dependency the package does not use is a lie about its footprint.
// The boundary tool exempts `*.test.ts`, which is exactly the line this is using.
import { createDatabase, type Database } from '../../../database/src/index.ts';
import { createPostgresDriver } from '../../../database/src/postgres.ts';

import {
  connectPostgres,
  databaseUrl,
  type TestDatabase,
} from '../../../../tools/pg-test-client.ts';
import { json } from '../codec.ts';
import { cacheTableDdl, databaseDriver } from './database.ts';
import { createCache } from '../store.ts';
import { conformanceCases } from '../conformance.ts';

const url = databaseUrl();
const suite = url === undefined ? describe.skip : describe;

let pg: TestDatabase;
let db: Database;

beforeAll(async () => {
  if (url === undefined) return;
  pg = connectPostgres(url);
  db = createDatabase({ driver: createPostgresDriver({ client: pg.client }) });

  // A per-run table name, so a parallel suite cannot see this one's rows.
  const suffix = String(Date.now());
  const table = `cache_entries_it_${suffix}`;
  const tagTable = `cache_entry_tags_it_${suffix}`;
  for (const statement of cacheTableDdl({ engine: 'postgres', table, tagTable })) {
    await db.query({ sql: statement, params: [] });
  }
  (globalThis as { cacheIt?: { table: string; tagTable: string } }).cacheIt = { table, tagTable };
});

afterAll(async () => {
  if (url === undefined) return;
  const names = (globalThis as { cacheIt?: { table: string; tagTable: string } }).cacheIt;
  if (names !== undefined) {
    await db.query({ sql: `DROP TABLE IF EXISTS ${names.table}`, params: [] });
    await db.query({ sql: `DROP TABLE IF EXISTS ${names.tagTable}`, params: [] });
  }
  await pg.close();
});

beforeEach(async () => {
  if (url === undefined) return;
  const names = (globalThis as { cacheIt?: { table: string; tagTable: string } }).cacheIt;
  if (names === undefined) return;
  await db.query({ sql: `DELETE FROM ${names.table}`, params: [] });
  await db.query({ sql: `DELETE FROM ${names.tagTable}`, params: [] });
});

function cacheFor<T>(name: string): {
  store: ReturnType<typeof createCache<T>>;
  driver: ReturnType<typeof databaseDriver>;
} {
  const names = (globalThis as { cacheIt?: { table: string; tagTable: string } }).cacheIt;
  if (names === undefined) throw new Error('integration setup did not run');

  // `Database` satisfies `CacheSql` structurally — that is the whole point of the shape.
  const driver = databaseDriver({ database: db, table: names.table, tagTable: names.tagTable });
  return { store: createCache<T>({ name, backend: driver.open(), codec: json<T>() }), driver };
}

suite('cache · database driver against Postgres', () => {
  test('the conformance kit passes on a real server', async () => {
    const { driver } = cacheFor('it');

    for (const conformanceCase of conformanceCases({ driver, store: 'it' })) {
      await conformanceCase.run();
    }
  });

  test('a value round-trips and survives a second read', async () => {
    const { store } = cacheFor<{ name: string }>('it');

    await store.set('user:1', { name: 'Ada' });

    expect(await store.get('user:1')).toEqual({ name: 'Ada' });
    expect(await store.has('user:1')).toBe(true);
  });

  test('increment is atomic: 50 concurrent increments land exactly 50', async () => {
    const { store } = cacheFor<number>('it');

    // The reason the increment is one statement: a read-modify-write would lose updates
    // here, and would pass every single-threaded test.
    await Promise.all(Array.from({ length: 50 }, () => store.increment('hits')));
    expect(await store.increment('hits', 0)).toBe(50);
  });

  test('tags use the index and remove exactly their entries', async () => {
    const { store } = cacheFor<number>('it');

    await store.set('a', 1, { tags: ['users'] });
    await store.set('b', 2, { tags: ['users'] });
    await store.set('c', 3, { tags: ['config'] });

    expect(await store.invalidateTag('users')).toBe(2);
    expect(await store.has('a')).toBe(false);
    expect(await store.has('c')).toBe(true);
  });

  test('an expired row is a miss', async () => {
    const { store } = cacheFor<number>('it');

    await store.set('k', 1, { ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await store.get('k')).toBeUndefined();
  });
});
