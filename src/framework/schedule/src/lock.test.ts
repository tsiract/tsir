/**
 * The lock (`§ 4.6`).
 *
 * Both providers run the conformance kit — the contract is the kit's, not this file's — and what
 * is left here is what only one provider can answer: the memory lock's `shared: false`, the
 * database lock's single-statement acquire, and the engine it refuses.
 */

import { describe, expect, test } from 'bun:test';

import { lockConformance } from './conformance.ts';
import {
  databaseLock,
  memoryLock,
  scheduleLockDdl,
  type LockSql,
  type LockSqlResult,
} from './lock.ts';

const NOW = Date.UTC(2026, 0, 1);
const TTL = 30_000;

/**
 * The four statements the driver issues, over a Map of rows.
 *
 * Written against the *statement text*, not against a parameter list: the acquire is an upsert
 * whose `WHERE` decides everything, and a fake that does not honour it would happily pass a
 * driver whose conditional write is broken.
 */
function fakeSql(engine: 'd1' | 'postgres' | 'mysql' | 'sqlite' = 'd1') {
  const rows = new Map<string, { name: string; owner: string; expires_at: number }>();
  const statements: { sql: string; params: readonly unknown[] }[] = [];

  const sql: LockSql = {
    capabilities: { engine, placeholder: engine === 'postgres' ? 'dollar' : 'question' },
    query({ sql: text, params }): Promise<LockSqlResult> {
      statements.push({ sql: text, params });

      if (/^INSERT INTO \S+ \(name, owner, expires_at\)/u.test(text)) {
        const [name, owner, expiresAt, at] = params as [string, string, number, number];
        const existing = rows.get(name);
        // `ON CONFLICT … DO UPDATE … WHERE expires_at <= ?`: the WHERE is what makes a live lock
        // unacquirable, and it is the one thing a fake must reproduce faithfully.
        if (existing === undefined) {
          rows.set(name, { name, owner, expires_at: expiresAt });
          return Promise.resolve({ rows: [{ name, owner, expires_at: expiresAt }], changes: 1 });
        }
        if (existing.expires_at <= at) {
          existing.owner = owner;
          existing.expires_at = expiresAt;
          return Promise.resolve({ rows: [{ ...existing }], changes: 1 });
        }
        return Promise.resolve({ rows: [], changes: 0 });
      }

      if (/^DELETE FROM \S+ WHERE name = .* AND owner = .* AND expires_at > /u.test(text)) {
        const [name, owner, at] = params as [string, string, number];
        const existing = rows.get(name);
        if (existing === undefined || existing.owner !== owner || existing.expires_at <= at) {
          return Promise.resolve({ rows: [], changes: 0 });
        }
        rows.delete(name);
        return Promise.resolve({ rows: [{ name }], changes: 1 });
      }

      if (/^SELECT name, owner, expires_at FROM \S+ WHERE name = /u.test(text)) {
        const [name, at] = params as [string, number];
        const existing = rows.get(name);
        if (existing === undefined || existing.expires_at <= at) {
          return Promise.resolve({ rows: [], changes: 0 });
        }
        return Promise.resolve({ rows: [{ ...existing }], changes: 0 });
      }

      if (/^SELECT name, owner, expires_at FROM \S+ WHERE expires_at > /u.test(text)) {
        const [at] = params as [number];
        const live = [...rows.values()]
          .filter((row) => row.expires_at > at)
          .sort((a, b) => a.name.localeCompare(b.name));
        return Promise.resolve({ rows: live, changes: 0 });
      }

      throw new Error(`fake LockSql does not understand: ${text}`);
    },
  };

  return { sql, rows, statements };
}

describe('memoryLock', () => {
  test('a second lock in one process is the same lock, and it says it is per-process', async () => {
    const first = memoryLock();
    const second = memoryLock();

    // Two providers are two *independent* stores — which is exactly the point: `shared: false`
    // means a lock taken in one process is invisible to the next, so overlap prevention across
    // isolates cannot be built on it.
    expect(first.capabilities.shared).toBe(false);
    await first.acquire({ name: 'nightly', owner: 'a', ttlMs: TTL, now: NOW });
    expect(await second.inspect('nightly', NOW)).toBeUndefined();
  });

  test('the conformance kit passes', async () => {
    const lock = memoryLock({ now: () => NOW });

    for (const conformanceCase of lockConformance({ provider: lock, singleProcess: true })) {
      await conformanceCase.run();
    }
  });

  test('the injected clock is used when a caller does not pass one', async () => {
    let now = NOW;
    const lock = memoryLock({ now: () => now });

    await lock.acquire({ name: 'tick', owner: 'a', ttlMs: TTL, now });
    now += TTL + 1;
    expect(await lock.inspect('tick', now)).toBeUndefined();
  });
});

describe('databaseLock', () => {
  test('the conformance kit passes', async () => {
    const fake = fakeSql();
    const lock = databaseLock({ sql: fake.sql });

    for (const conformanceCase of lockConformance({ provider: lock })) {
      await conformanceCase.run();
    }
  });

  test('acquire is one statement, and its WHERE is what refuses a live lock', async () => {
    const fake = fakeSql();
    const lock = databaseLock({ sql: fake.sql });

    await lock.acquire({ name: 'nightly', owner: 'a', ttlMs: TTL, now: NOW });
    await lock.acquire({ name: 'nightly', owner: 'b', ttlMs: TTL, now: NOW });

    // One round trip: a read-then-write would have a window, and that window is the overlap.
    expect(fake.statements).toHaveLength(2);
    expect(fake.statements[0]?.sql).toContain('ON CONFLICT (name) DO UPDATE');
    expect(fake.statements[0]?.sql).toContain('WHERE expires_at <= ?');
    expect(fake.rows.get('nightly')?.owner).toBe('a');
  });

  test('Postgres placeholders are numbered like every other statement in the framework', async () => {
    const fake = fakeSql('postgres');
    const lock = databaseLock({ sql: fake.sql });

    await lock.acquire({ name: 'nightly', owner: 'a', ttlMs: TTL, now: NOW });

    expect(fake.statements[0]?.sql).toContain('VALUES ($1, $2, $3)');
    expect(fake.statements[0]?.sql).toContain('WHERE expires_at <= $4');
    expect(fake.statements[0]?.sql).not.toContain('?');
  });

  test('an engine that cannot express a conditional upsert is refused, not approximated', () => {
    // MySQL's `ON DUPLICATE KEY UPDATE` has no `WHERE`, so the same statement would take a lock
    // that is still held. A lock that cannot prove exclusivity is not a lock.
    const mysql = {
      capabilities: { engine: 'mysql', placeholder: 'question' },
      query: () => Promise.resolve({ rows: [], changes: 0 }),
    } as unknown as LockSql;

    expect(() => databaseLock({ sql: mysql })).toThrow(/cannot express a conditional upsert/u);
  });

  test('a custom table name reaches every statement', async () => {
    const fake = fakeSql();
    const lock = databaseLock({ sql: fake.sql, table: 'locks' });

    await lock.acquire({ name: 'nightly', owner: 'a', ttlMs: TTL, now: NOW });
    expect(fake.statements[0]?.sql).toContain('INSERT INTO locks');

    await lock.list(NOW);
    expect(fake.statements.at(-1)?.sql).toContain('FROM locks');
  });
});

describe('scheduleLockDdl', () => {
  test('the table, the primary key and the expiry index', () => {
    const statements = scheduleLockDdl({ engine: 'd1' });

    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS schedule_locks');
    expect(statements[0]).toContain('name TEXT PRIMARY KEY');
    expect(statements[1]).toContain('schedule_locks_expiry');
  });

  test('Postgres uses BIGINT for the epoch, D1 uses INTEGER', () => {
    expect(scheduleLockDdl({ engine: 'postgres' })[0]).toContain('expires_at BIGINT');
    expect(scheduleLockDdl({ engine: 'd1' })[0]).toContain('expires_at INTEGER');
    expect(scheduleLockDdl({ engine: 'postgres', table: 'locks' })[0]).toContain(
      'CREATE TABLE IF NOT EXISTS locks',
    );
  });
});

describe('the lock takes the engines that can express a conditional upsert (CAP-009)', () => {
  test('sqlite is accepted, because it is the same statement as d1', () => {
    // The regression this covers: widening the engine union made `sqlite` a value, and the guard
    // still listed only d1 and postgres — so a file-backed connection was refused a lock that its
    // own SQL supports.
    expect(() => databaseLock({ sql: fakeSql('sqlite').sql })).not.toThrow();
  });

  test('mysql is refused, because ON DUPLICATE KEY UPDATE has no WHERE', () => {
    let caught: unknown;
    try {
      databaseLock({ sql: fakeSql('mysql').sql });
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(String(caught)).toMatch(/mysql/u);
  });
});
