import { describe, expect, test } from 'bun:test';

import { createDatabase, declare, type Database } from './database.ts';
import {
  createD1Driver,
  D1_CAPABILITIES,
  type D1Like,
  type D1ResultLike,
  type D1StatementLike,
} from './d1.ts';
import { statement } from './driver.ts';

/**
 * A D1 binding that behaves like the real one where it matters.
 *
 * It is deliberately *not* an SQL engine — Drizzle and D1 own SQL. What it
 * reproduces is the contract the driver depends on:
 *
 *   · failures are reported in the result (`success: false`), not thrown;
 *   · `batch()` is atomic: one failing statement fails the whole call;
 *   · `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT` are rejected by the engine.
 *
 * Those three rules are exactly what a fake that "just works" would hide.
 */
/** A prepared statement in the fake: records what it was bound with. */
class FakePrepared {
  readonly sql: string;
  params: readonly unknown[] = [];
  readonly #state: FakeState;

  constructor(sql: string, state: FakeState) {
    this.sql = sql;
    this.#state = state;
  }

  bind(...values: readonly unknown[]): FakePrepared {
    this.params = values;
    return this;
  }

  // Generic to match `D1StatementLike`; the fake stores untyped rows and hands
  // them back as whatever the caller asked for — the same thing D1 does.
  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    this.#state.executed.push({ sql: this.sql, params: this.params });
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(this.sql)) {
      // Real D1 refuses transaction control outright.
      return { success: false, error: 'cannot start a transaction within a transaction' };
    }
    if (/^SELECT 1\b/.test(this.sql)) {
      return { success: true, results: [{ ok: 1 }] as unknown as T[] };
    }
    const rows = (this.#state.rows.get(this.sql) ?? []) as unknown as T[];
    return { success: true, results: rows, meta: { changes: 1 } };
  }

  async run(): Promise<D1ResultLike<never>> {
    this.#state.executed.push({ sql: this.sql, params: this.params });
    return { success: true, meta: { changes: 1, last_row_id: 42 } };
  }
}

interface FakeState {
  readonly executed: { sql: string; params: readonly unknown[] }[];
  readonly rows: Map<string, unknown[]>;
}

/** A D1 binding that behaves like the real one where it matters. */
class FakeD1 implements D1Like {
  readonly executed: { sql: string; params: readonly unknown[] }[] = [];
  readonly rows = new Map<string, unknown[]>();
  /** How many `batch()` round trips the driver made — one is the whole point. */
  batches = 0;
  readonly #state: FakeState = { executed: this.executed, rows: this.rows };

  prepare(sql: string): FakePrepared {
    return new FakePrepared(sql, this.#state);
  }

  async batch<T = Record<string, unknown>>(
    statements: readonly D1StatementLike[],
  ): Promise<readonly D1ResultLike<T>[]> {
    this.batches += 1;
    // Atomic, exactly like D1: the first failure aborts the whole batch.
    const results: D1ResultLike<T>[] = [];
    for (const prepared of statements) {
      const result = await prepared.all<T>();
      if (!result.success) return [result];
      results.push(result);
    }
    return results;
  }

  async exec(): Promise<{ count: number; duration: number }> {
    return { count: 1, duration: 0 };
  }
}

function fakeBinding(): FakeD1 {
  return new FakeD1();
}

function databaseWith(binding: D1Like): Database {
  return createDatabase({ driver: createD1Driver({ binding }) });
}

describe('database · D1 driver (DB-001)', () => {
  test('declares exactly what D1 can do', () => {
    expect(D1_CAPABILITIES).toEqual({
      interactiveTx: false,
      batch: true,
      placeholder: 'question',
      engine: 'd1',
      pinnedConnection: false,
    });
  });

  test('a query binds parameters and returns rows', async () => {
    const binding = fakeBinding();
    binding.rows.set('SELECT * FROM users WHERE id = ?', [{ id: 7, email: 'ada@example.com' }]);

    const driver = createD1Driver({ binding });
    const result = await driver.query(statement('SELECT * FROM users WHERE id = ?', [7]));

    expect(result.rows).toEqual([{ id: 7, email: 'ada@example.com' }]);
    expect(binding.executed[0]?.params).toEqual([7]);
  });

  test('a statement that reports failure throws instead of returning nothing', async () => {
    // Failure arrives as data (`success: false`) in D1, not as a rejection; a
    // driver that forgot to check it would return "no rows, no error".
    const binding: D1Like = {
      prepare: () => ({
        bind() {
          return this;
        },
        all: async () => ({ success: false, error: 'no such table: users' }),
        run: async () => ({ success: false, error: 'no such table: users' }),
      }),
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
    };

    const driver = createD1Driver({ binding });
    const error = await driver.query(statement('SELECT * FROM users')).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect((error as Error).message).toBe('no such table: users');
  });

  test('batch runs the statements in order as one call', async () => {
    const binding = fakeBinding();
    const driver = createD1Driver({ binding });

    const results = await driver.batch([
      statement('INSERT INTO users (email) VALUES (?)', ['a@example.com']),
      statement('INSERT INTO users (email) VALUES (?)', ['b@example.com']),
    ]);

    expect(results).toHaveLength(2);
    // Both statements reached the binding, in declaration order.
    expect(binding.executed.map((entry) => entry.sql)).toEqual([
      'INSERT INTO users (email) VALUES (?)',
      'INSERT INTO users (email) VALUES (?)',
    ]);
    expect(binding.executed.map((entry) => entry.params)).toEqual([
      ['a@example.com'],
      ['b@example.com'],
    ]);
  });

  test('N statements reach D1 as one batch call — one round trip, one transaction', async () => {
    const binding = fakeBinding();
    const database = databaseWith(binding);

    const results = await database.batch([
      statement('INSERT INTO users (email) VALUES (?)', ['a@example.com']),
      statement('INSERT INTO users (email) VALUES (?)', ['b@example.com']),
      statement('UPDATE counters SET n = n + 1 WHERE name = ?', ['users']),
    ]);

    // Three results from exactly one `batch()` call: on D1 that call *is* the
    // transaction. Looping `query()` three times would be three transactions.
    expect(results).toHaveLength(3);
    expect(binding.batches).toBe(1);
    expect(binding.executed).toHaveLength(3);
  });

  test('a failing statement fails the whole batch: it throws, never a partial array', async () => {
    const driver = createD1Driver({ binding: fakeBinding() });

    // Returning `[ok, failed]` would hand the caller a half-applied write and no
    // way to tell. The atomic unit either produced every result or none.
    const error = await driver
      .batch([
        statement('INSERT INTO users (email) VALUES (?)', ['a@example.com']),
        statement('BEGIN'), // the engine rejects this, exactly like production
      ])
      .then(
        () => undefined,
        (reason: unknown) => reason as Error,
      );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('cannot start a transaction');
  });

  test('health is a real round trip and never throws', async () => {
    const healthy = await createD1Driver({ binding: fakeBinding() }).health();
    expect(healthy).toMatchObject({ ok: true, engine: 'd1', detail: {} });
    expect(healthy.latencyMs).toBeGreaterThanOrEqual(0);

    const broken: D1Like = {
      prepare() {
        throw new Error('binding is gone');
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
    };
    const unhealthy = await createD1Driver({ binding: broken }).health();
    expect(unhealthy.ok).toBe(false);
    expect(unhealthy.error).toBe('binding is gone');
  });

  test('close is a no-op and safe twice: D1 has nothing to release', async () => {
    const driver = createD1Driver({ binding: fakeBinding() });
    await driver.close();
    await driver.close();
    expect(true).toBe(true);
  });
});

describe('database · transaction capability (DB-006, DB-007)', () => {
  test('interactiveTx throws a coded error on D1 rather than pretending', async () => {
    const database = databaseWith(fakeBinding());

    const error = await database
      .interactiveTx(async () => 'never')
      .then(
        () => undefined,
        (reason: unknown) => reason as { code: string; hint?: string },
      );

    expect(error?.code).toBe('DB_TX_INTERACTIVE_UNSUPPORTED');
    expect(error?.hint).toContain('batch');
  });

  test('a component that requires interactive transactions fails at boot', () => {
    const database = databaseWith(fakeBinding());
    expect(() => declare(database, 'ReportsExport', { interactiveTx: true })).toThrow(
      /DB_REQUIRES_INTERACTIVE_TX|requires interactive transactions/,
    );

    // Declaring nothing, or only capabilities the engine has, is fine.
    expect(() => declare(database, 'ReportsExport', {})).not.toThrow();
  });

  test('an empty batch is rejected: it is a caller bug, not a no-op', async () => {
    const database = databaseWith(fakeBinding());
    const error = await database.batch([]).then(
      () => undefined,
      (reason: unknown) => reason as { code: string },
    );
    expect(error?.code).toBe('DB_BATCH_EMPTY');
  });
});

describe('database · lifecycle (DB-004)', () => {
  test('queries after close are refused with a code', async () => {
    const database = databaseWith(fakeBinding());
    await database.close();

    expect(database.closed).toBe(true);
    const error = await database.query(statement('SELECT 1')).then(
      () => undefined,
      (reason: unknown) => reason as { code: string },
    );
    expect(error?.code).toBe('DB_CLOSED');
  });

  test('close waits for in-flight queries before closing the driver', async () => {
    let released = false;
    const database = createDatabase({
      driver: {
        capabilities: D1_CAPABILITIES,
        async query() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          released = true;
          return { rows: [], changes: 0 };
        },
        batch: async () => [],
        health: async () => ({ ok: true, engine: 'd1', latencyMs: 0, detail: {} }),
        close: async () => undefined,
      },
    });

    const pending = database.query(statement('SELECT 1'));
    await database.close();
    expect(released).toBe(true);
    await pending;
  });

  test('a stuck query does not hang shutdown forever', async () => {
    const database = createDatabase({
      driver: {
        capabilities: D1_CAPABILITIES,
        query: () => new Promise(() => undefined), // never settles
        batch: async () => [],
        health: async () => ({ ok: true, engine: 'd1', latencyMs: 0, detail: {} }),
        close: async () => undefined,
      },
      drainTimeoutMs: 20,
    });

    void database.query(statement('SELECT 1'));
    const started = Date.now();
    await database.close();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('health answers after close instead of throwing', async () => {
    const database = databaseWith(fakeBinding());
    await database.close();
    const health = await database.health();
    expect(health.ok).toBe(false);
    expect(health.error).toContain('closed');
  });

  test('close is idempotent under concurrency', async () => {
    const database = databaseWith(fakeBinding());
    await Promise.all([database.close(), database.close(), database.close()]);
    expect(database.closed).toBe(true);
  });
});
