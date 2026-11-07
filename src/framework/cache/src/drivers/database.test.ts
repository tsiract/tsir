/**
 * The `database` driver (`CACHE-6`).
 *
 * Two layers of proof, because this driver is mostly SQL and SQL is where "it looked right"
 * is not evidence:
 *
 *   · a **fake `CacheSql`** that understands the five statements the driver issues (keyed by
 *     their shape, not their exact text) and keeps rows in a Map — which exercises the real
 *     orchestration: upsert, tag replacement, expiry, atomically incremented counters;
 *   · **statement assertions** on the dialect: `$1` on Postgres, `?` on D1, `RETURNING` where
 *     atomicity depends on it. A driver that emits the wrong placeholder is a driver that
 *     fails in production and passes every behavioural test.
 */

import { describe, expect, test } from 'bun:test';

import { cacheTableDdl, databaseDriver, type CacheSql } from './database.ts';
import { conformanceCases } from '../conformance.ts';
import { json } from '../codec.ts';
import { createCache } from '../store.ts';
import { createCaches, defineStore } from '../stores.ts';

interface Row {
  value: string | null;
  counter: number | null;
  expiresAt: number | null;
}

/** A `CacheSql` over a Map, matching statements by what they do rather than how they read. */
function fakeSql(options: { placeholder?: 'question' | 'dollar'; now?: () => number } = {}) {
  const rows = new Map<string, Row>();
  const tags = new Set<string>(); // `${key}\u0000${tag}`
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const now = options.now ?? ((): number => 1_000);

  const keyOf = (entry: string): string => entry.split('\u0000')[0] ?? '';

  const sql: CacheSql = {
    capabilities: {
      engine: options.placeholder === 'dollar' ? 'postgres' : 'd1',
      placeholder: options.placeholder ?? 'question',
    },
    async query(statement) {
      statements.push({ sql: statement.sql, params: statement.params });
      const text = statement.sql;
      const params = statement.params;

      if (text.startsWith('SELECT value, counter, expires_at')) {
        const row = rows.get(String(params[0]));
        if (row === undefined) return { rows: [], changes: 0 };
        if (row.expiresAt !== null && row.expiresAt <= now()) {
          rows.delete(String(params[0]));
          return { rows: [], changes: 0 };
        }
        return {
          rows: [{ value: row.value, counter: row.counter, expires_at: row.expiresAt }],
          changes: 0,
        };
      }

      if (
        text.startsWith('INSERT INTO cache_entries') &&
        text.includes('excluded.value') &&
        !text.includes('RETURNING key')
      ) {
        const [key, value, expiresAt] = params as [string, string, number | null];
        rows.set(key, { value, counter: null, expiresAt });
        return { rows: [], changes: 1 };
      }

      if (text.startsWith('INSERT INTO cache_entries') && text.includes('RETURNING counter')) {
        const [key, by] = params as [string, number];
        const existing = rows.get(key) ?? { value: null, counter: null, expiresAt: null };
        const next = (existing.counter ?? 0) + by;
        rows.set(key, { ...existing, counter: next });
        return { rows: [{ counter: next }], changes: 1 };
      }

      // acquireLock: insert, or update only when the existing row is expired.
      if (text.startsWith('INSERT INTO cache_entries') && text.includes('RETURNING key')) {
        const [key, owner, expiresAt, current] = params as [string, string, number | null, number];
        const existing = rows.get(key);
        const expired =
          existing !== undefined && existing.expiresAt !== null && existing.expiresAt <= current;
        if (existing === undefined || expired) {
          rows.set(key, { value: owner, counter: null, expiresAt });
          return { rows: [{ key }], changes: 1 };
        }
        return { rows: [], changes: 0 };
      }

      // releaseLock: delete only when the value still matches the owner.
      if (
        text.startsWith('DELETE FROM cache_entries WHERE key = ') &&
        text.includes('AND value =')
      ) {
        const [key, owner] = params as [string, string];
        const existing = rows.get(key);
        if (existing !== undefined && existing.value === owner) {
          rows.delete(key);
          return { rows: [{ key }], changes: 1 };
        }
        return { rows: [], changes: 0 };
      }

      if (text.startsWith('DELETE FROM cache_entries WHERE key = ') && text.includes('RETURNING')) {
        return { rows: rows.delete(String(params[0])) ? [{ key: params[0] }] : [], changes: 0 };
      }

      if (text.startsWith('DELETE FROM cache_entries WHERE key IN')) {
        const tag = String(params[0]);
        let changes = 0;
        for (const entry of [...tags]) {
          if (entry.split('\u0000')[1] !== tag) continue;
          if (rows.delete(keyOf(entry))) changes += 1;
        }
        return { rows: [], changes };
      }

      if (text.startsWith('DELETE FROM cache_entries')) {
        const changes = rows.size;
        rows.clear();
        return { rows: [], changes };
      }

      if (text.startsWith('SELECT COUNT(*) AS removed')) {
        const tag = String(params[0]);
        let count = 0;
        for (const entry of tags) if (entry.split('\u0000')[1] === tag) count += 1;
        return { rows: [{ removed: String(count) }], changes: 0 };
      }

      if (text.startsWith('INSERT INTO cache_entry_tags')) {
        tags.add(`${String(params[0])}\u0000${String(params[1])}`);
        return { rows: [], changes: 1 };
      }

      if (text.startsWith('DELETE FROM cache_entry_tags')) {
        if (!text.includes('WHERE')) {
          tags.clear();
          return { rows: [], changes: 0 };
        }
        const target = String(params[0]);
        for (const entry of [...tags]) {
          const matches = text.includes('WHERE tag =')
            ? entry.split('\u0000')[1] === target
            : keyOf(entry) === target;
          if (matches) tags.delete(entry);
        }
        return { rows: [], changes: 0 };
      }

      throw new Error(`fakeSql: unhandled statement: ${text}`);
    },
  };

  return { sql, rows, tags, statements, now };
}

function store(options: { placeholder?: 'question' | 'dollar'; now?: () => number } = {}) {
  const fake = fakeSql(options);
  const database = databaseDriver({
    database: fake.sql,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const backend = database.open();
  return {
    fake,
    cache: createCache<{ n: number }>({ name: 'db', backend, codec: json<{ n: number }>() }),
    counter: createCache<number>({ name: 'db', backend, codec: json<number>() }),
    backend,
  };
}

describe('the driver speaks the engine’s dialect', () => {
  test('Postgres gets $n placeholders and D1 gets ?', async () => {
    const postgres = store({ placeholder: 'dollar' });
    await postgres.cache.set('k', { n: 1 });
    expect(postgres.fake.statements[0]?.sql).toContain('VALUES ($1, $2, NULL, $3)');

    const d1 = store({ placeholder: 'question' });
    await d1.cache.set('k', { n: 1 });
    expect(d1.fake.statements[0]?.sql).toContain('VALUES (?, ?, NULL, ?)');
    expect(d1.fake.statements[0]?.sql).not.toContain('$1');
  });

  test('the increment is one statement with RETURNING — atomicity is not a JS loop', async () => {
    const { fake, cache } = store({ placeholder: 'dollar' });
    await cache.increment('hits');

    const increment = fake.statements.find((statement) =>
      statement.sql.includes('RETURNING counter'),
    );
    expect(increment).toBeDefined();
    expect(increment?.sql).toContain('ON CONFLICT (key) DO UPDATE SET counter = COALESCE');
    expect(increment?.sql.startsWith('INSERT INTO cache_entries')).toBe(true);
  });

  test('the DDL is reviewable and indexed', () => {
    const ddl = cacheTableDdl({ engine: 'postgres' });

    expect(ddl[0]).toContain('counter BIGINT');
    expect(ddl[1]).toContain('PRIMARY KEY (key, tag)');
    expect(ddl[2]).toContain(
      'CREATE INDEX IF NOT EXISTS cache_entry_tags_tag ON cache_entry_tags (tag)',
    );
    expect(cacheTableDdl({ engine: 'd1' })[0]).toContain('counter INTEGER');
  });
});

describe('behaviour over a fake database', () => {
  test('values round-trip through the codec', async () => {
    const { cache } = store();

    await cache.set('k', { n: 7 });

    expect(await cache.get('k')).toEqual({ n: 7 });
    expect(await cache.has('k')).toBe(true);
  });

  test('an expired row reads as a miss and is removed', async () => {
    let clock = 1_000;
    const { cache, fake } = store({ now: () => clock });

    await cache.set('k', { n: 1 }, { ttlMs: 500 });
    clock += 499;
    expect(await cache.has('k')).toBe(true);

    clock += 1;
    expect(await cache.get('k')).toBeUndefined();
    expect(fake.rows.size).toBe(0);
  });

  test('tags are an index: invalidating one is two deletes, not a scan', async () => {
    const { cache, fake } = store();

    await cache.set('a', { n: 1 }, { tags: ['users'] });
    await cache.set('b', { n: 2 }, { tags: ['users'] });
    await cache.set('c', { n: 3 }, { tags: ['config'] });

    expect(await cache.invalidateTag('users')).toBe(2);
    expect(fake.rows.has('a')).toBe(false);
    expect(fake.rows.has('c')).toBe(true);
    expect([...fake.tags].every((entry) => entry.endsWith('config'))).toBe(true);
  });

  test('set replaces tags instead of merging them', async () => {
    const { cache, fake } = store();

    await cache.set('a', { n: 1 }, { tags: ['old', 'shared'] });
    await cache.set('a', { n: 2 }, { tags: ['new'] });

    expect([...fake.tags].sort()).toEqual(['a\u0000new']);
  });

  test('a counter row reads back through the counter codec', async () => {
    const { cache, counter } = store();

    expect(await cache.increment('hits')).toBe(1);
    expect(await cache.increment('hits', 4)).toBe(5);
    // `get` on an incremented key returns the store's declared type, not the raw row: the
    // wrapper rebuilds the codec's counter form from the numeric column.
    expect(await counter.get('hits')).toBe(5);
  });

  test('writing a value turns a counter row back into a value row', async () => {
    const { cache, fake } = store();

    await cache.increment('k');
    await cache.set('k', { n: 0 });

    expect(fake.rows.get('k')?.counter).toBeNull();
    expect(await cache.get('k')).toEqual({ n: 0 });
  });

  test('delete removes the row and its tags, and reports whether it existed', async () => {
    const { cache, fake } = store();

    await cache.set('k', { n: 1 }, { tags: ['t'] });

    expect(await cache.delete('k')).toBe(true);
    expect(await cache.delete('k')).toBe(false);
    expect(fake.tags.size).toBe(0);
  });

  test('clear empties both tables', async () => {
    const { cache, fake } = store();

    await cache.set('a', { n: 1 }, { tags: ['t'] });
    await cache.set('b', { n: 2 });
    await cache.clear();

    expect(fake.rows.size).toBe(0);
    expect(fake.tags.size).toBe(0);
  });

  test('the conformance kit passes against it', async () => {
    const fake = fakeSql();
    const driver = databaseDriver({ database: fake.sql });

    for (const conformanceCase of conformanceCases({ driver, store: 'database' })) {
      await conformanceCase.run();
    }
  });
});

describe('in the registry', () => {
  test('a durable driver is allowed as a production default', () => {
    const fake = fakeSql();

    const caches = createCaches({
      default: 'app',
      production: true,
      stores: {
        app: defineStore({ driver: databaseDriver({ database: fake.sql }), codec: json<string>() }),
      },
    });

    expect(caches.capabilities('app')).toEqual({
      persistent: true,
      sharedAcrossInstances: true,
      readYourWrites: true,
      tags: true,
      increment: true,
      ttl: true,
      clearAll: true,
      locks: true,
    });
  });
});
