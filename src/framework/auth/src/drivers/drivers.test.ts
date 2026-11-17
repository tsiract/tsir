/**
 * The `memory` and `database` drivers.
 *
 * Two layers of proof, for the same reason `@tsir/cache`'s database driver has two:
 *
 * · a **fake `SessionSql`** that keeps rows in a Map and matches statements by what they do — so
 * the store's orchestration (get, put, delete, delete-by-subject, touch) runs for real;
 * · **statement assertions** on the dialect: `$1` on Postgres, `?` on D1, and the DDL's column
 * types. A driver that emits the wrong placeholder passes every behavioural test in a fake and
 * fails in production.
 */

import { describe, expect, test } from 'bun:test';

import { createApiKeys } from '../keys.ts';
import { createSessions } from '../session.ts';
import type { SessionSql } from './session-database.ts';
import { databaseSessionStore, sessionTableDdl } from './session-database.ts';
import { apiKeyTableDdl, databaseApiKeyStore } from './keys-database.ts';
import { memoryApiKeyStore, memorySessionStore } from './memory.ts';

type Dialect = { engine: 'd1' | 'postgres'; placeholder: 'question' | 'dollar' };

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly result: { readonly rows: readonly unknown[]; readonly changes: number };
}

/**
 * A `SessionSql` over one Map per table, keyed by the table name the statement names.
 *
 * Statements are recognised by their leading verb and their `FROM`/`INTO`/`UPDATE` target, which is
 * exactly how a real engine reads them — so the fake does not quietly accept a malformed statement.
 */
function fakeSql(dialect: Dialect = { engine: 'd1', placeholder: 'question' }) {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  const recorded: Recorded[] = [];

  const tableOf = (name: string): Map<string, Record<string, unknown>> => {
    let table = tables.get(name);
    if (table === undefined) {
      table = new Map();
      tables.set(name, table);
    }
    return table;
  };

  const sql: SessionSql = {
    capabilities: dialect,

    async query(statement) {
      const text = statement.sql;
      const params = [...statement.params];
      const target = /\b(?:FROM|INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(text)?.[1];
      if (target === undefined) throw new Error(`the fake cannot route: ${text}`);
      const table = tableOf(target);

      let result: Recorded['result'] = { rows: [], changes: 0 };

      if (text.startsWith('INSERT INTO')) {
        const columns = /\(([^)]*)\)\s+VALUES/u.exec(text)?.[1];
        if (columns === undefined) throw new Error(`no column list: ${text}`);
        const names = columns.split(',').map((name) => name.trim());
        if (names.length !== params.length) {
          throw new Error(`column/parameter mismatch: ${names.length} vs ${String(params.length)}`);
        }
        const row: Record<string, unknown> = {};
        for (const [index, name] of names.entries()) row[name] = params[index];
        table.set(String(row['id']), row);
        result = { rows: [], changes: 1 };
      } else if (text.startsWith('SELECT')) {
        const columns = /^SELECT\s+(.+?)\s+FROM/iu
          .exec(text)?.[1]
          ?.split(',')
          .map((name) => name.trim());
        if (columns === undefined) throw new Error(`no column list: ${text}`);
        const matches = [...table.values()].filter((row) => matchesWhere(text, row, params));
        if (text.includes('ORDER BY created_at DESC')) {
          matches.sort((left, right) => Number(right['created_at']) - Number(left['created_at']));
        }
        result = {
          rows: matches.map((row) => Object.fromEntries(columns.map((name) => [name, row[name]]))),
          changes: 0,
        };
      } else if (text.startsWith('DELETE FROM')) {
        const doomed = [...table.entries()].filter(([, row]) => matchesWhere(text, row, params));
        for (const [id] of doomed) table.delete(id);
        result = { rows: [], changes: doomed.length };
      } else if (text.startsWith('UPDATE')) {
        const assignments = /^UPDATE\s+\S+\s+SET\s+(.+?)\s+WHERE/iu.exec(text)?.[1];
        if (assignments === undefined) throw new Error(`no SET clause: ${text}`);
        const columns = assignments.split(',').map((part) => part.split('=')[0]?.trim() ?? '');
        const doomed = [...table.values()].filter((row) =>
          matchesWhere(text, row, params, columns.length),
        );
        for (const row of doomed) {
          for (const [index, column] of columns.entries()) row[column] = params[index];
        }
        // `AND revoked_at IS NULL` narrows a second, already-revoked key: the fake honours it so the
        // store's "only revoke once" promise is actually tested.
        result = { rows: [], changes: doomed.length };
      } else {
        throw new Error(`the fake cannot execute: ${text}`);
      }

      recorded.push({ sql: text, params: statement.params, result });
      return result;
    },
  };

  return { sql, tables, recorded };
}

/** `WHERE <column> = <placeholder>`, optionally `AND <column> IS NULL`, over the trailing params. */
function matchesWhere(
  text: string,
  row: Record<string, unknown>,
  params: readonly unknown[],
  leading = 0,
): boolean {
  const where = /WHERE\s+(.+?)(?:\s+ORDER BY|$)/iu.exec(text.split('VALUES')[1] ?? text)?.[1];
  if (where === undefined) return false;

  const conditions = where.split(/\s+AND\s+/u).map((condition) => condition.trim());
  let paramIndex = leading;

  for (const condition of conditions) {
    const isNull = /^(\w+)\s+IS\s+NULL$/iu.exec(condition);
    if (isNull !== null) {
      if (row[isNull[1] ?? ''] !== null && row[isNull[1] ?? ''] !== undefined) return false;
      continue;
    }
    const equals = /^(\w+)\s*=\s*(\?|\$\d+)$/u.exec(condition);
    if (equals === null) throw new Error(`the fake cannot read: ${condition}`);
    const value = params[paramIndex];
    paramIndex += 1;
    if (row[equals[1] ?? ''] !== value) return false;
  }
  return true;
}

const NOW = 1_700_000_000_000;

function sessionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a'.repeat(64),
    subject: 'user_1',
    data: { role: 'admin' },
    createdAt: NOW,
    lastSeenAt: NOW,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

describe('sessionTableDdl', () => {
  test('the engine decides BIGINT vs INTEGER, and the table name is a parameter', () => {
    const d1 = sessionTableDdl({ engine: 'd1' });
    const postgres = sessionTableDdl({ engine: 'postgres' });

    expect(d1[0]).toContain('CREATE TABLE IF NOT EXISTS tsir_sessions');
    expect(d1[0]).toContain('created_at INTEGER NOT NULL');
    expect(postgres[0]).toContain('created_at BIGINT NOT NULL');
    // Both indexes serve a real query: one subject's sessions, and the expired sweep.
    expect(d1[1]).toBe(
      'CREATE INDEX IF NOT EXISTS tsir_sessions_subject ON tsir_sessions (subject)',
    );
    expect(d1[2]).toBe(
      'CREATE INDEX IF NOT EXISTS tsir_sessions_expiry ON tsir_sessions (expires_at)',
    );
    expect(sessionTableDdl({ engine: 'd1', table: 'sessions' })[0]).toContain('sessions (');
    // No column holds a token: the primary key is the hash.
    expect(d1[0]).not.toContain('token');
  });

  test('the api-key DDL stores a hash and a scope blob', () => {
    const postgres = apiKeyTableDdl({ engine: 'postgres' });
    expect(postgres[0]).toContain('CREATE TABLE IF NOT EXISTS tsir_api_keys');
    expect(postgres[0]).toContain('secret_hash TEXT NOT NULL');
    expect(postgres[0]).toContain('scopes TEXT');
    expect(postgres[1]).toBe(
      'CREATE INDEX IF NOT EXISTS tsir_api_keys_subject ON tsir_api_keys (subject)',
    );
    expect(apiKeyTableDdl({ engine: 'd1', table: 'keys' })[0]).toContain('keys (');
  });
});

describe('databaseSessionStore', () => {
  test('a full session lifecycle runs over real statements', async () => {
    const { sql, tables, recorded } = fakeSql();
    const store = databaseSessionStore(sql);

    await store.put(sessionRecord({}));
    expect(tables.get('tsir_sessions')?.size).toBe(1);

    const found = await store.get('a'.repeat(64));
    expect(found?.subject).toBe('user_1');
    expect(found?.data).toEqual({ role: 'admin' });
    expect(found?.createdAt).toBe(NOW);

    await store.touch('a'.repeat(64), NOW + 5_000);
    expect((await store.get('a'.repeat(64)))?.lastSeenAt).toBe(NOW + 5_000);

    await store.delete('a'.repeat(64));
    expect(await store.get('a'.repeat(64))).toBeUndefined();
    expect(recorded).toHaveLength(6); // put, get, touch, get, delete, get
  });

  test('`deleteSubject` reports how many rows it removed', async () => {
    const { sql } = fakeSql();
    const store = databaseSessionStore(sql);
    await store.put(sessionRecord({ id: 'a'.repeat(64) }));
    await store.put(sessionRecord({ id: 'b'.repeat(64) }));
    await store.put(sessionRecord({ id: 'c'.repeat(64), subject: 'user_2' }));

    expect(await store.deleteSubject('user_1')).toBe(2);
    expect(await store.deleteSubject('user_1')).toBe(0);
    expect(await store.get('c'.repeat(64))).toBeDefined();
  });

  test('a session round-trips through `createSessions`, hashes and all', async () => {
    const { sql } = fakeSql();
    const sessions = createSessions({ store: databaseSessionStore(sql), now: () => NOW });
    const { token, record } = await sessions.start({ subject: 'user_1', data: { theme: 'dark' } });

    const read = await sessions.read(token);
    expect(read?.record.subject).toBe('user_1');
    expect(read?.record.data).toEqual({ theme: 'dark' });
    expect(read?.record.id).toBe(record.id);

    await sessions.revoke(token);
    expect(await sessions.read(token)).toBeUndefined();
  });

  test('nulls, absent optionals and non-JSON data survive the round trip', async () => {
    const { sql } = fakeSql();
    const store = databaseSessionStore(sql);
    await store.put(sessionRecord({ id: 'd'.repeat(64), data: null }));
    const plain = await store.get('d'.repeat(64));
    expect(plain?.data).toBeNull();
    expect(plain).not.toHaveProperty('revokedAt');
    expect(plain).not.toHaveProperty('userAgent');
    expect(plain).not.toHaveProperty('ip');
  });

  test('BIGINT arrives as a bigint or a string, and is always a number', async () => {
    const { sql, tables } = fakeSql({ engine: 'postgres', placeholder: 'dollar' });
    const store = databaseSessionStore(sql);
    await store.put(sessionRecord({}));

    // What `pg` does: BIGINT is returned as a string.
    const row = tables.get('tsir_sessions')?.get('a'.repeat(64));
    if (row !== undefined) {
      row['created_at'] = String(NOW);
      row['last_seen_at'] = BigInt(NOW + 1);
      row['expires_at'] = String(NOW + 2);
      row['revoked_at'] = BigInt(NOW + 3);
    }

    const read = await store.get('a'.repeat(64));
    expect(read?.createdAt).toBe(NOW);
    expect(read?.lastSeenAt).toBe(NOW + 1);
    expect(read?.expiresAt).toBe(NOW + 2);
    expect(read?.revokedAt).toBe(NOW + 3);
  });

  test('Postgres gets `$1`, D1 gets `?` — the placeholder comes from the backend', async () => {
    const postgres = fakeSql({ engine: 'postgres', placeholder: 'dollar' });
    const d1 = fakeSql({ engine: 'd1', placeholder: 'question' });

    for (const { sql, recorded } of [postgres, d1]) {
      const store = databaseSessionStore(sql);
      await store.put(sessionRecord({}));
      await store.get('a'.repeat(64));
      await store.touch('a'.repeat(64), NOW);
      const wantsDollar = sql.capabilities.placeholder === 'dollar';
      for (const statement of recorded) {
        expect(statement.sql).not.toContain(wantsDollar ? '?' : '$1');
        expect(statement.sql).toContain(wantsDollar ? '$1' : '?');
      }
    }
  });

  test('the table name is a parameter, and it appears in every statement', async () => {
    const { sql, recorded } = fakeSql();
    const store = databaseSessionStore(sql, { table: 'sessions' });
    await store.put(sessionRecord({}));
    await store.get('a'.repeat(64));
    await store.deleteSubject('user_1');

    for (const statement of recorded) expect(statement.sql).toContain('sessions');
  });
});

describe('databaseApiKeyStore', () => {
  const apiKeyRecord = (overrides: Record<string, unknown> = {}) => ({
    id: 'abcdef012345',
    subject: 'user_1',
    name: 'ci',
    scopes: ['build', 'deploy'],
    secretHash: 'f'.repeat(64),
    createdAt: NOW,
    ...overrides,
  });

  test('issue, verify, list and revoke all work over real statements', async () => {
    const { sql } = fakeSql();
    const keys = createApiKeys({ store: databaseApiKeyStore(sql), now: () => NOW });

    const first = await keys.issue({ subject: 'user_1', name: 'laptop', scopes: ['build'] });
    const second = await keys.issue({ subject: 'user_1', name: 'ci', scopes: ['deploy'] });

    expect((await keys.verify(first.key))?.name).toBe('laptop');
    const listed = await keys.list('user_1');
    expect(listed.map((entry) => entry.name).sort()).toEqual(['ci', 'laptop']);
    expect(listed.find((entry) => entry.name === 'ci')?.scopes).toEqual(['deploy']);

    expect(await keys.revoke(second.record.id)).toBe(true);
    expect(await keys.verify(second.key)).toBeUndefined();
    expect(await keys.revoke('nosuchkey')).toBe(false);
  });

  test('a Postgres UPDATE numbers its placeholders per statement (INF-001)', async () => {
    // The fake routes parameters positionally, so it cannot see the bug this pins: `SET a = $1
    // WHERE id = $1` is a *valid* statement with two parameters, and it compares the id to itself.
    // Postgres matched no rows and `revoke()` reported `changes: 0` — a revoke that did nothing, on
    // the one path where nothing happening is reported as "already revoked".
    const { sql, recorded } = fakeSql({ engine: 'postgres', placeholder: 'dollar' });
    const store = databaseApiKeyStore(sql);
    await store.revoke('abcdef012345', NOW);
    await store.touch('abcdef012345', NOW);

    for (const statement of recorded) {
      const used = [...statement.sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]));
      // `$1, $2, …` with no repeats: one parameter per position, in order.
      expect(used).toEqual(used.map((_value, index) => index + 1));
      expect(new Set(used).size).toBe(used.length);
    }
  });

  test('an UPDATE carries as many parameters as it has placeholders', async () => {
    // The count is the other half: `SET a = $1 WHERE id = $2` with one parameter is a driver error,
    // and the store built its `params` array separately from its SQL.
    const { sql, recorded } = fakeSql({ engine: 'postgres', placeholder: 'dollar' });
    const store = databaseApiKeyStore(sql);
    await store.revoke('abcdef012345', NOW);
    const update = recorded.find((statement) => statement.sql.startsWith('UPDATE'));
    expect(update?.params).toHaveLength(2);
    expect(update?.sql).toContain('$2');
  });

  test('`revoke` is a single transition: a second call changes nothing', async () => {
    const { sql, recorded } = fakeSql();
    const store = databaseApiKeyStore(sql);
    await store.put(apiKeyRecord());

    expect(await store.revoke('abcdef012345', NOW)).toBe(true);
    expect(await store.revoke('abcdef012345', NOW + 1)).toBe(false);
    // Both statements carried `AND revoked_at IS NULL` — that is what makes the transition atomic.
    const updates = recorded.filter((statement) => statement.sql.startsWith('UPDATE'));
    expect(updates).toHaveLength(2);
    for (const update of updates) expect(update.sql).toContain('revoked_at IS NULL');
  });

  test('scopes are JSON text, and an empty blob reads back as an empty list', async () => {
    const { sql, tables } = fakeSql();
    const store = databaseApiKeyStore(sql);
    await store.put(apiKeyRecord());

    const stored = tables.get('tsir_api_keys')?.get('abcdef012345');
    expect(stored?.['scopes']).toBe('["build","deploy"]');

    if (stored !== undefined) stored['scopes'] = null;
    expect((await store.get('abcdef012345'))?.scopes).toEqual([]);
  });

  test('expiry and last use survive as nullable columns', async () => {
    const { sql } = fakeSql();
    const store = databaseApiKeyStore(sql);
    await store.put(apiKeyRecord({ expiresAt: NOW + 1_000 }));

    expect((await store.get('abcdef012345'))?.expiresAt).toBe(NOW + 1_000);
    expect((await store.get('abcdef012345'))?.lastUsedAt).toBeUndefined();

    await store.touch('abcdef012345', NOW + 10);
    expect((await store.get('abcdef012345'))?.lastUsedAt).toBe(NOW + 10);
  });

  test('a missing row is `undefined`, not an empty record', async () => {
    const { sql } = fakeSql();
    const store = databaseApiKeyStore(sql);
    expect(await store.get('nosuchkey')).toBeUndefined();
    expect(await store.list('nobody')).toEqual([]);
  });
});

describe('the memory drivers say what they are', () => {
  test('both declare that they do not share state between instances', () => {
    const sessions = memorySessionStore();
    const keys = memoryApiKeyStore();
    expect(sessions.sharedAcrossInstances).toBe(false);
    expect(keys.sharedAcrossInstances).toBe(false);

    const other = memorySessionStore();
    expect(other.size).toBe(0);
    expect(sessions).not.toBe(other);
  });

  test('`memory` and `database` satisfy the same `Sessions`, so a test can swap one for the other', async () => {
    const build = (store: ReturnType<typeof memorySessionStore>) =>
      createSessions({ store, now: () => NOW });

    for (const sessions of [
      build(memorySessionStore()),
      createSessions({
        store: databaseSessionStore(fakeSql().sql),
        now: () => NOW,
      }),
    ]) {
      const { token } = await sessions.start({ subject: 'user_1', data: 1 });
      expect((await sessions.read(token))?.record.data).toBe(1);
      await sessions.revoke(token);
      expect(await sessions.read(token)).toBeUndefined();
    }
  });
});
