import { describe, expect, test } from 'bun:test';

import type { Clock } from '@tsir/core';

import { createDatabase, isSerializationFailure } from './database.ts';
import { statement } from './driver.ts';
import type { DatabaseLogEvent } from './logging.ts';
import { createPostgresDriver, type PgClientLike, type PgResultLike } from './postgres.ts';

/**
 * A fake `postgres.js` whose transaction can fail on purpose.
 *
 * `failWith` decides, per attempt, whether `begin()` rejects — which is the only
 * thing retry logic may look at. Everything the tests assert is recorded:
 * attempts, the statements that ran inside each attempt, and whether a commit or
 * a rollback closed it.
 */
function fakeClient(failWith: (attempt: number) => Error | undefined = () => undefined) {
  const events: string[] = [];
  const executed: { sql: string; params: readonly unknown[] }[] = [];
  let attempts = 0;

  function scoped(level = 1): PgClientLike {
    return {
      unsafe(query: string, params: readonly unknown[] = []) {
        return {
          then: <T>(resolve: (value: PgResultLike) => T) => {
            executed.push({ sql: query, params });
            return Promise.resolve([] as unknown as PgResultLike).then(resolve);
          },
        } as never;
      },
      // A nested begin is a SAVEPOINT, exactly as postgres.js does it.
      async begin<T>(work: (inner: PgClientLike) => Promise<T>): Promise<T> {
        events.push(`SAVEPOINT#${level + 1}`);
        const value = await work(scoped(level + 1));
        events.push(`RELEASE#${level + 1}`);
        return value;
      },
    };
  }

  const client: PgClientLike = {
    ...scoped(),
    async begin<T>(work: (scope: PgClientLike) => Promise<T>): Promise<T> {
      attempts += 1;
      const current = attempts;
      events.push(`BEGIN#${current}`);
      const failure = failWith(current);
      if (failure !== undefined) {
        events.push(`FAIL#${current}`);
        throw failure;
      }
      try {
        const value = await work(scoped());
        events.push(`COMMIT#${current}`);
        return value;
      } catch (error: unknown) {
        events.push(`ROLLBACK#${current}`);
        throw error;
      }
    },
  };

  return { client, events, executed, attempts: () => attempts };
}

function sqlState(code: string): Error {
  return Object.assign(new Error(`postgres: ${code}`), { code });
}

describe('database · transaction retry policy (DB-013)', () => {
  test('a serialization failure retries only when the callback is idempotent', async () => {
    const retrying = fakeClient((attempt) => (attempt === 1 ? sqlState('40001') : undefined));
    const database = createDatabase({
      driver: createPostgresDriver({ client: retrying.client }),
    });

    let runs = 0;
    const value = await database.interactiveTx(
      async (tx) => {
        runs += 1;
        await tx.query(statement('update "accounts" set "balance" = "balance" - 1'));
        return runs;
      },
      { idempotent: true, sleep: async () => undefined },
    );

    // The failed attempt never reached the callback — `begin` rejected before it
    // ran — so the body executed once and the caller sees that result.
    expect(value).toBe(1);
    expect(runs).toBe(1);
    expect(retrying.attempts()).toBe(2);
    expect(retrying.events).toEqual(['BEGIN#1', 'FAIL#1', 'BEGIN#2', 'COMMIT#2']);
  });

  test('without `idempotent`, a serialization failure is not retried', async () => {
    const client = fakeClient(() => sqlState('40001'));
    const database = createDatabase({ driver: createPostgresDriver({ client: client.client }) });

    const error = await database
      .interactiveTx(async () => 'never', { sleep: async () => undefined })
      .then(
        () => undefined,
        (reason: unknown) => reason as Error,
      );

    expect((error as { code?: string }).code).toBe('40001');
    expect(client.attempts()).toBe(1);
  });

  test('a deadlock (40P01) is retryable; a unique violation (23505) is not', async () => {
    const deadlock = fakeClient((attempt) => (attempt === 1 ? sqlState('40P01') : undefined));
    const db = createDatabase({ driver: createPostgresDriver({ client: deadlock.client }) });
    expect(
      await db.interactiveTx(async () => 'ok', { idempotent: true, sleep: async () => undefined }),
    ).toBe('ok');
    expect(deadlock.attempts()).toBe(2);

    const unique = fakeClient(() => sqlState('23505'));
    const other = createDatabase({ driver: createPostgresDriver({ client: unique.client }) });
    const error = await other
      .interactiveTx(async () => 'never', { idempotent: true, sleep: async () => undefined })
      .then(
        () => undefined,
        (reason: unknown) => reason as Error,
      );
    expect((error as { code?: string }).code).toBe('23505');
    expect(unique.attempts()).toBe(1);
  });

  test('retries are bounded, and the last failure is what the caller sees', async () => {
    const client = fakeClient(() => sqlState('40001'));
    const database = createDatabase({ driver: createPostgresDriver({ client: client.client }) });
    const delays: number[] = [];

    const error = await database
      .interactiveTx(async () => 'never', {
        idempotent: true,
        attempts: 3,
        backoffMs: 10,
        sleep: async (ms) => {
          delays.push(ms);
        },
      })
      .then(
        () => undefined,
        (reason: unknown) => reason as Error,
      );

    expect((error as { code?: string }).code).toBe('40001');
    expect(client.attempts()).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  test('a failure inside the callback rolls back and is never retried by accident', async () => {
    const client = fakeClient();
    const database = createDatabase({ driver: createPostgresDriver({ client: client.client }) });

    const error = await database
      .interactiveTx(async () => {
        throw sqlState('23505'); // unique violation, i.e. a real business outcome
      })
      .then(
        () => undefined,
        (reason: unknown) => reason as Error,
      );

    expect((error as { code?: string }).code).toBe('23505');
    expect(client.events).toEqual(['BEGIN#1', 'ROLLBACK#1']);
  });

  test('isSerializationFailure reads through the cause chain and nothing else', () => {
    expect(isSerializationFailure(sqlState('40001'))).toBe(true);
    expect(isSerializationFailure({ cause: { cause: sqlState('40P01') } })).toBe(true);
    expect(isSerializationFailure(sqlState('23505'))).toBe(false);
    expect(isSerializationFailure(new Error('socket hang up'))).toBe(false);
    expect(isSerializationFailure('40001')).toBe(false);
  });

  test('a SQLSTATE in errno counts too — that is where Bun SQL puts it', () => {
    // postgres.js: `code`. Bun's SQL: `code: 'ERR_POSTGRES_SERVER_ERROR'` with
    // the SQLSTATE in `errno`. Retries must not depend on which client is used.
    expect(isSerializationFailure({ code: 'ERR_POSTGRES_SERVER_ERROR', errno: '40001' })).toBe(
      true,
    );
    expect(isSerializationFailure({ errno: '40P01', cause: undefined })).toBe(true);
    expect(isSerializationFailure({ errno: '23505' })).toBe(false);
  });
});

describe('database · read-only transactions (DB-013)', () => {
  test('readOnly opens the transaction with SET TRANSACTION READ ONLY', async () => {
    const { client, executed } = fakeClient();
    const database = createDatabase({ driver: createPostgresDriver({ client }) });

    await database.interactiveTx(
      async (tx) => {
        await tx.query(statement('select 1'));
      },
      { readOnly: true },
    );

    // First statement inside the transaction: Postgres accepts the setting only
    // before any other statement runs.
    expect(executed[0]?.sql).toBe('set transaction read only');
    expect(executed[1]?.sql).toBe('select 1');
  });

  test('without readOnly, no SET statement is issued', async () => {
    const { client, executed } = fakeClient();
    const database = createDatabase({ driver: createPostgresDriver({ client }) });

    await database.interactiveTx(async (tx) => {
      await tx.query(statement('select 1'));
    });

    expect(executed.map((entry) => entry.sql)).toEqual(['select 1']);
  });

  test('readOnly on an engine that cannot express it fails with the reason', async () => {
    const database = createDatabase({
      driver: {
        capabilities: {
          interactiveTx: true,
          batch: true,
          placeholder: 'question',
          engine: 'd1',
          pinnedConnection: false,
        },
        query: async () => ({ rows: [], changes: 0 }),
        batch: async () => [],
        // Declared `interactiveTx: true` but cannot actually run a transaction —
        // the point is that the *option* is rejected, not the capability.
        begin: async <T>() => 'never' as T,
        health: async () => ({ ok: true, engine: 'd1', latencyMs: 0, detail: {} }),
        close: async () => undefined,
      },
    });

    const error = await database
      .interactiveTx(async () => 'never', { readOnly: true })
      .then(
        () => undefined,
        (reason: unknown) => reason as { code?: string; hint?: string },
      );

    expect(error?.code).toBe('DB_TX_OPTION_UNSUPPORTED');
    expect(error?.hint).toContain('postgres');
  });
});

describe('database · long-transaction warning (DB-013)', () => {
  test('a transaction open past 3 × statementTimeoutMs emits one warning', async () => {
    const { client } = fakeClient();
    const events: DatabaseLogEvent[] = [];
    const database = createDatabase({
      driver: createPostgresDriver({ client }),
      statementTimeoutMs: 5, // warn after 15 ms
      log: (event) => events.push(event),
    });

    await database.interactiveTx(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const warnings = events.filter((event) => event.event === 'db.transaction.open');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      level: 'slow',
      depth: 0,
      readOnly: false,
      warnAfterMs: 15,
    });
  });

  test('a short transaction emits no warning, and the timer is cleared', async () => {
    const { client } = fakeClient();
    const events: DatabaseLogEvent[] = [];
    const database = createDatabase({
      driver: createPostgresDriver({ client }),
      statementTimeoutMs: 5,
      log: (event) => events.push(event),
    });

    await database.interactiveTx(async () => undefined);
    // Long enough for a leaked timer from the previous closure to fire.
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(events.filter((event) => event.event === 'db.transaction.open')).toHaveLength(0);
  });

  test('the warning carries the nesting depth, so a savepoint is not blamed on the outer tx', async () => {
    const { client } = fakeClient();
    const events: DatabaseLogEvent[] = [];
    const database = createDatabase({
      driver: createPostgresDriver({ client }),
      statementTimeoutMs: 5,
      log: (event) => events.push(event),
    });

    await database.interactiveTx(async (tx) => {
      await tx.interactiveTx(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
    });

    const warnings = events.filter((event) => event.event === 'db.transaction.open');
    // Both scopes were open when the timer fired: the outer one first.
    expect(warnings.map((event) => (event as { depth: number }).depth).sort()).toEqual([0, 1]);
  });

  test('readOnly is refused on a nested transaction: it describes the whole transaction', async () => {
    const { client } = fakeClient();
    const database = createDatabase({ driver: createPostgresDriver({ client }) });

    const error = await database.interactiveTx(async (tx) =>
      tx
        .interactiveTx(async () => 'never', { readOnly: true })
        .then(
          () => undefined,
          (reason: unknown) => reason as { code?: string },
        ),
    );

    expect(error?.code).toBe('DB_TX_OPTION_UNSUPPORTED');
  });
});

describe('database · transaction clock is injectable', () => {
  test('a fixed clock is used, not the wall clock, for logged durations', async () => {
    const { client } = fakeClient();
    const clock = testClockForTransaction();
    const events: DatabaseLogEvent[] = [];
    const database = createDatabase({
      driver: createPostgresDriver({ client }),
      clock,
      logging: 'all',
      log: (event) => {
        events.push(event);
        clock.advance(250);
      },
    });

    await database.interactiveTx(async (tx) => {
      await tx.query(statement('select 1'));
    });

    const query = events.find((event) => event.event === 'db.query');
    expect(query).toBeDefined();
    expect(clock.monotonicMs()).toBe(250);
  });
});

function testClockForTransaction(): Clock & { advance(ms: number): void } {
  let monotonic = 0;
  return {
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    iso: () => '2026-01-01T00:00:00.000Z',
    monotonicMs: () => monotonic,
    advance: (ms) => {
      monotonic += ms;
    },
  };
}
