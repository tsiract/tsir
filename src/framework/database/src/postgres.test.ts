import { describe, expect, test } from 'bun:test';

import { createDatabase } from './database.ts';
import { createD1Driver } from './d1.ts';
import { statement } from './driver.ts';
import {
  createPostgresDriver,
  hyperdriveConnection,
  postgresCapabilities,
  resolvePool,
  type PgClientLike,
  type PgResultLike,
} from './postgres.ts';

/**
 * A fake `postgres.js`.
 *
 * It reproduces the four behaviours the driver depends on, none of which a
 * naive fake would have:
 *
 *   · `unsafe()` returns a **thenable**, not a Promise (postgres.js returns a
 *     `PendingQuery`), and it can hand back positional rows through `raw()`;
 *   · the resolved value is an array **with `count` and `command` attached**, not
 *     an object with `rows` — reading `rows.length` for an UPDATE is how a
 *     5-row write becomes `changes: 0`;
 *   · `begin()` opens a transaction, and a nested `begin()` becomes a savepoint,
 *     exactly like postgres.js;
 *   · `end()` closes the pool and is only on the root client.
 */
interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakeClient(
  respond: (sql: string, params: readonly unknown[]) => Record<string, unknown>[] = () => [],
) {
  const executed: Recorded[] = [];
  const events: string[] = [];

  function make(sql: string, params: readonly unknown[], depth: number): PgResultLike {
    executed.push({ sql, params });
    const rows = respond(sql, params);
    const result = rows as unknown as PgResultLike & { count?: number };
    Object.defineProperty(result, 'count', {
      value: /^\s*(insert|update|delete)\b/i.test(sql) ? rows.length + 4 : undefined,
      enumerable: false,
    });
    Object.defineProperty(result, 'command', {
      value: sql.trim().split(/\s+/)[0]?.toUpperCase(),
      enumerable: false,
    });
    Object.defineProperty(result, 'depth', { value: depth, enumerable: false });
    return result;
  }

  function scoped(depth: number): PgClientLike {
    return {
      unsafe(query: string, params: readonly unknown[] = []) {
        // A thenable, so nothing in the driver can assume a Promise.
        return {
          raw: async () => make(query, params, depth).map((row) => Object.values(row)),
          then: <T>(resolve: (value: PgResultLike) => T) =>
            Promise.resolve(make(query, params, depth)).then(resolve),
        } as never;
      },
      async begin<T>(work: (scope: PgClientLike) => Promise<T>): Promise<T> {
        events.push(depth === 0 ? 'BEGIN' : 'SAVEPOINT');
        try {
          const value = await work(scoped(depth + 1));
          events.push(depth === 0 ? 'COMMIT' : 'RELEASE');
          return value;
        } catch (error: unknown) {
          events.push(depth === 0 ? 'ROLLBACK' : 'ROLLBACK TO SAVEPOINT');
          throw error;
        }
      },
    };
  }

  const root = scoped(0);
  const client: PgClientLike = {
    ...root,
    // `end` exists only on the pool owner, like postgres.js.
    async end() {
      events.push('END');
    },
  };

  return { client, executed, events };
}

/** A client without `begin()` — e.g. a read replica or a deliberately reduced double. */
function readOnlyClient(): PgClientLike {
  return {
    unsafe: () => ({
      then: <T>(resolve: (value: PgResultLike) => T) =>
        Promise.resolve([] as unknown as PgResultLike).then(resolve),
    }),
  } as never;
}

/** The code of the error a factory throws, without matching on prose. */
function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (reason: unknown) {
    return (reason as { code?: string }).code;
  }
}

describe('database · Postgres driver (DB-012, ADR-0009)', () => {
  test('a query binds $n parameters and returns object rows with changes', async () => {
    const { client, executed } = fakeClient(() => [{ id: 7, email: 'ada@example.com' }]);
    const driver = createPostgresDriver({ client });

    const result = await driver.query(
      statement('select "id", "email" from "users" where "id" = $1', [7]),
    );

    expect(executed[0]).toEqual({
      sql: 'select "id", "email" from "users" where "id" = $1',
      params: [7],
    });
    expect(result.rows).toEqual([{ id: 7, email: 'ada@example.com' }]);
    expect(result.changes).toBe(1);
  });

  test('`count` wins over row count, so an UPDATE without RETURNING reports its rows', async () => {
    const { client } = fakeClient(() => [{ id: 1 }, { id: 2 }, { id: 3 }]);
    const driver = createPostgresDriver({ client });

    const result = await driver.query(statement('update "users" set "email" = $1', ['x']));

    // The fake reports `rows.length + 4`, which is deliberately *not* rows.length:
    // a driver that ignored `count` would report 3 and be silently wrong.
    expect(result.changes).toBe(7);
  });

  test('positional rows come from the client’s raw(), never from object re-ordering', async () => {
    const { client } = fakeClient(() => [{ b: 2, a: 1 }]);
    const driver = createPostgresDriver({ client });

    const result = await driver.query(statement('select "b", "a" from "t"', [], 'arrays'));

    // Values in select order: `raw()` gives [2, 1]; object re-ordering would give
    // [1, 2] because JS keeps insertion order, not select order.
    expect(result.rows).toEqual([[2, 1]]);
  });

  test('a client without raw() fails loudly rather than guessing column order', async () => {
    const client: PgClientLike = {
      unsafe: () => ({ raw: undefined, then: () => Promise.resolve([]) }) as never,
    };
    const driver = createPostgresDriver({ client });

    const error = await driver.query(statement('select 1', [], 'arrays')).then(
      () => undefined,
      (reason: unknown) => reason as { code?: string },
    );

    expect(error?.code).toBe('DB_RAW_UNSUPPORTED');
  });

  test('batch runs every statement inside one transaction', async () => {
    const { client, events } = fakeClient(() => [{ id: 1 }]);
    const driver = createPostgresDriver({ client });

    const results = await driver.batch([
      statement('insert into "users" ("email") values ($1)', ['a@example.com']),
      statement('insert into "users" ("email") values ($1)', ['b@example.com']),
    ]);

    expect(events).toEqual(['BEGIN', 'COMMIT']);
    expect(results).toHaveLength(2);
  });

  test('a failing statement rolls the whole batch back', async () => {
    const { client, events } = fakeClient((sql) => {
      if (sql.startsWith('insert into "boom"')) throw new Error('relation "boom" does not exist');
      return [{ id: 1 }];
    });
    const driver = createPostgresDriver({ client });

    const error = await driver
      .batch([
        statement('insert into "users" ("email") values ($1)', ['a@example.com']),
        statement('insert into "boom" ("email") values ($1)', ['b@example.com']),
      ])
      .then(
        () => undefined,
        (reason: unknown) => reason as Error,
      );

    expect(error?.message).toContain('does not exist');
    expect(events).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('interactiveTx is real: BEGIN, the callback, COMMIT — and queries use the tx client', async () => {
    const { client, events, executed } = fakeClient(() => [{ id: 1 }]);
    const database = createDatabase({ driver: createPostgresDriver({ client }) });

    const value = await database.interactiveTx(async (tx) => {
      await tx.query(statement('update "accounts" set "balance" = "balance" - $1', [100]));
      await tx.query(statement('update "accounts" set "balance" = "balance" + $1', [100]));
      return 'done';
    });

    expect(value).toBe('done');
    expect(events).toEqual(['BEGIN', 'COMMIT']);
    expect(executed).toHaveLength(2);
  });

  test('a failing transaction rolls back and the error reaches the caller', async () => {
    const { client, events } = fakeClient((sql) => {
      if (sql.includes('boom')) throw new Error('deadlock detected');
      return [{ id: 1 }];
    });
    const database = createDatabase({ driver: createPostgresDriver({ client }) });

    const error = await database
      .interactiveTx(async (tx) => {
        await tx.query(statement('select "boom"'));
      })
      .then(
        () => undefined,
        (reason: unknown) => reason as Error,
      );

    expect(error?.message).toContain('deadlock');
    expect(events).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('a query on the transaction scope after it settles is refused', async () => {
    const { client } = fakeClient(() => [{ id: 1 }]);
    const database = createDatabase({ driver: createPostgresDriver({ client }) });

    let escaped: Parameters<typeof database.query>[0] | undefined;
    await database.interactiveTx(async (tx) => {
      escaped = statement('select 1');
      void tx;
    });

    // The scope is closed once the callback returns: a query that outlived its
    // transaction must not run outside it.
    const error = await database
      .interactiveTx(async (tx) => {
        await tx.close();
        return tx.query(escaped!).then(
          () => 'ran',
          (reason: unknown) => (reason as { code?: string }).code,
        );
      })
      .then(
        (value) => value,
        (reason: unknown) => reason,
      );

    expect(error).toBe('DB_CLOSED');
  });

  test('nesting opens a savepoint, like postgres.js', async () => {
    const { client, events } = fakeClient(() => [{ id: 1 }]);
    const database = createDatabase({ driver: createPostgresDriver({ client }) });

    await database.interactiveTx(async (tx) => {
      await tx.interactiveTx(async (inner) => {
        await inner.query(statement('select 1'));
      });
    });

    expect(events).toEqual(['BEGIN', 'SAVEPOINT', 'RELEASE', 'COMMIT']);
  });

  test('nesting is capped at 16, because a deeper chain has no owner', async () => {
    const { client } = fakeClient(() => [{ id: 1 }]);
    const database = createDatabase({ driver: createPostgresDriver({ client }) });

    const descend = async (tx: typeof database, depth: number): Promise<number> => {
      if (depth === 0) return 0;
      return tx.interactiveTx(async (inner) => descend(inner, depth - 1));
    };

    const error = await descend(database, 20).then(
      () => undefined,
      (reason: unknown) => reason as { code?: string },
    );
    expect(error?.code).toBe('DB_TX_DEPTH_EXCEEDED');
  });

  test('a client without begin() cannot claim interactiveTx, and the boot check refuses it', () => {
    expect(postgresCapabilities(true).interactiveTx).toBe(true);
    expect(postgresCapabilities(false)).toMatchObject({
      interactiveTx: false,
      batch: false,
      placeholder: 'dollar',
      engine: 'postgres',
    });

    // A driver that declares the capability without implementing it is refused
    // at construction, not at the first request that needs a transaction.
    const liar = {
      ...createPostgresDriver({ client: readOnlyClient() }),
      capabilities: { ...postgresCapabilities(false), interactiveTx: true },
    };
    expect(codeOf(() => createDatabase({ driver: liar }))).toBe('DB_CAPABILITY_MISMATCH');
  });

  test('declaring interactiveTx on a driver that has begin() but claims false is refused too', () => {
    const understated = {
      ...createPostgresDriver({ client: fakeClient().client }),
      capabilities: postgresCapabilities(false),
    };
    expect(codeOf(() => createDatabase({ driver: understated }))).toBe('DB_CAPABILITY_MISMATCH');
  });

  test('health is a real round trip, and reports the pool it was built with', async () => {
    const { client, executed } = fakeClient(() => [{ ok: 1 }]);
    const driver = createPostgresDriver({ client, poolMax: 5 });

    const health = await driver.health();

    expect(health).toMatchObject({ ok: true, engine: 'postgres', detail: { poolMax: 5 } });
    expect(executed[0]?.sql).toBe('select 1 as ok');

    const broken = createPostgresDriver({
      client: {
        unsafe: () => {
          throw new Error('connection refused');
        },
      },
    });
    expect(await broken.health()).toMatchObject({ ok: false, error: 'connection refused' });
  });

  test('close ends the pool once, and a transaction scope never ends it', async () => {
    const { client, events } = fakeClient(() => [{ id: 1 }]);
    const driver = createPostgresDriver({ client });

    await driver.close({ timeoutMs: 250 });
    await driver.close();

    const database = createDatabase({ driver: createPostgresDriver({ client }) });
    await database.interactiveTx(async (tx) => {
      await tx.close(); // closing the scope must not close the pool
    });
    await database.close();

    expect(events.filter((event) => event === 'END').length).toBe(3);
  });
});

describe('database · Postgres pool rules (DB-012)', () => {
  test('Lambda is forced to one connection per instance', () => {
    const resolved = resolvePool({ target: 'lambda', pool: { max: 20 } });

    expect(resolved.max).toBe(1);
    expect(resolved.clamped).toBe(true);
    expect(resolved.options.max).toBe(1);
  });

  test('Workers on Hyperdrive stay at the pooler’s size, not above it', () => {
    expect(resolvePool({ target: 'cloudflare', pool: { max: 20 } }).max).toBe(5);
    expect(resolvePool({ target: 'cloudflare', pool: { max: 2 } }).max).toBe(2);
  });

  test('a long-running server gets the configured pool', () => {
    const resolved = resolvePool({ target: 'bun', pool: { max: 20 } });

    expect(resolved.max).toBe(20);
    expect(resolved.clamped).toBe(false);
  });

  test('timeouts are converted to the client’s seconds, and application_name is passed', () => {
    const { options } = resolvePool({
      target: 'bun',
      pool: { idleTimeoutMs: 45_000, connectTimeoutMs: 2_500 },
      applicationName: 'tsir-app',
    });

    expect(options).toMatchObject({
      idle_timeout: 45,
      connect_timeout: 3,
      application_name: 'tsir-app',
      max: 10,
    });
  });
});

describe('database · Hyperdrive transport (DB-014)', () => {
  test('the connection string comes from the binding', () => {
    expect(hyperdriveConnection({ connectionString: 'postgres://user:pw@host/db' })).toBe(
      'postgres://user:pw@host/db',
    );
    expect(hyperdriveConnection({ connectionString: 'postgresql://host/db' })).toBe(
      'postgresql://host/db',
    );
  });

  test('a missing binding fails with the wrangler.toml fix, not a connection error', () => {
    type Caught = { code?: string; message?: string; hint?: string };
    // Assigned rather than copied: `Error.prototype.message` is non-enumerable,
    // so `Object.assign` would silently drop the one field the test asserts on.
    let caught: Caught | undefined;
    try {
      hyperdriveConnection(undefined);
    } catch (reason: unknown) {
      caught = reason as Caught;
    }

    expect(caught?.code).toBe('DB_DRIVER_UNAVAILABLE');
    expect(caught?.message).toContain('HYPERDRIVE');
    expect(caught?.hint).toContain('wrangler.toml');
  });

  test('a binding that is not a Postgres URL is refused', () => {
    expect(() => hyperdriveConnection({ connectionString: 'http://example.com' })).toThrow(
      /DB_DRIVER_UNAVAILABLE|did not provide a Postgres connection string/,
    );
  });
});

describe('database · the D1 driver is unaffected', () => {
  test('D1 still declares no interactive transactions, and both engines share one contract', () => {
    const d1 = createD1Driver({
      binding: {
        prepare: () => ({
          bind() {
            return this;
          },
          all: async () => ({ success: true, results: [] }),
          run: async () => ({ success: true, meta: { changes: 0 } }),
        }),
        batch: async () => [],
        exec: async () => ({ count: 0, duration: 0 }),
      },
    });

    expect(d1.capabilities.interactiveTx).toBe(false);
    expect('begin' in d1).toBe(false);
    expect(createPostgresDriver({ client: readOnlyClient() }).capabilities.placeholder).toBe(
      'dollar',
    );
  });
});
