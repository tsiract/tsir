import { describe, expect, test } from 'bun:test';

import { z } from '@tsir/validate';

import { assertConnectionRequirements, createConnections } from './connections.ts';
import { connectionNames, databaseConfigSchema } from './config.ts';
import { createDatabase } from './database.ts';
import { createD1Driver, type D1Like } from './d1.ts';
import { statement } from './driver.ts';
import { createPostgresDriver, type PgClientLike } from './postgres.ts';

/** The `TsirError` code a call throws, or `'none'` if it does not throw at all. */
function codeOf(work: () => unknown): string {
  try {
    work();
    return 'none';
  } catch (reason: unknown) {
    return (reason as { code?: string }).code ?? 'no-code';
  }
}

/** A D1 binding that answers `SELECT 1` and nothing else. */
function d1Driver(): ReturnType<typeof createD1Driver> {
  const binding: D1Like = {
    prepare: () => ({
      bind() {
        return this;
      },
      all: async <T = Record<string, unknown>>() => ({
        success: true,
        results: [{ one: 1 }] as T[],
      }),
      run: async () => ({ success: true, meta: { changes: 0 } }),
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  };
  return createD1Driver({ binding });
}

/**
 * A `postgres.js`-shaped client that records which connection ran what.
 *
 * `reserve()` hands back a client tagged with a new backend pid, which is what
 * makes the pin observable: two databases sharing one driver would be a bug the
 * assertions could not see.
 */
function pgClient(label: string, options: { readonly reserver?: boolean } = {}) {
  const executed: string[] = [];
  let pid = 1;

  function makeClient(tag: string): PgClientLike {
    const client: PgClientLike = {
      unsafe(query: string) {
        executed.push(`${tag}:${query}`);
        const rows = [{ tag, query }];
        return Promise.resolve(rows);
      },
      end: async () => {
        executed.push(`${tag}:end`);
      },
      ...(options.reserver === false
        ? {}
        : {
            reserve: async () => {
              pid += 1;
              return makeClient(`${label}#${pid}`);
            },
            release: () => {
              executed.push(`${tag}:release`);
            },
          }),
      begin: async <T>(work: (scope: PgClientLike) => Promise<T>): Promise<T> =>
        work(makeClient(`${tag}:tx`)),
    };
    return client;
  }

  return { client: makeClient(label), executed };
}

describe('named connections (DB-019)', () => {
  test('a declared name returns its own database; the default resolves to itself', async () => {
    const { client } = pgClient('reporting');

    const db = createConnections({
      default: 'app',
      connections: {
        app: { driver: d1Driver() },
        reporting: { driver: createPostgresDriver({ client }) },
      },
    });

    expect(db.names).toEqual(['app', 'reporting']);
    expect(db.connection('app')).toBe(db.defaultDatabase);
    expect(db.connection('reporting').name).toBe('reporting');
    expect(db.connection('reporting').capabilities.engine).toBe('postgres');
    // The default connection is D1, and the reporting one is not: capabilities
    // travel with the connection, not with the registry.
    expect(db.connection('app').capabilities.interactiveTx).toBe(false);
    expect(db.connection('reporting').capabilities.interactiveTx).toBe(true);
  });

  test('an unknown name fails with the declared list, not a fallback to default', () => {
    const db = createConnections({ default: 'app', connections: { app: { driver: d1Driver() } } });

    const error = (() => {
      try {
        db.connection('reportng' as 'app');
        return undefined;
      } catch (reason: unknown) {
        return reason as { code?: string; message?: string; hint?: string };
      }
    })();

    expect(error?.code).toBe('DB_UNKNOWN_CONNECTION');
    expect(error?.message).toContain('reportng');
    // The list is the fix: a typo is corrected by reading names, not stacks.
    expect(error?.message).toContain('app');
    expect(error?.hint).toContain('app');
  });

  test('a default that is not declared is refused at boot', () => {
    expect(
      codeOf(() =>
        createConnections({
          default: 'missing' as 'app',
          connections: { app: { driver: d1Driver() } },
        }),
      ),
    ).toBe('DB_UNKNOWN_DEFAULT');
  });

  test('an empty registry is refused at boot rather than resolving nothing', () => {
    expect(codeOf(() => createConnections({ default: 'app' as never, connections: {} }))).toBe(
      'DB_NO_CONNECTIONS',
    );
  });

  test('a standalone database can only resolve its own name', () => {
    const database = createDatabase({ driver: d1Driver() });

    expect(database.name).toBe('default');
    expect(database.connection('default')).toBe(database);
    expect(codeOf(() => database.connection('reporting'))).toBe('DB_UNKNOWN_CONNECTION');
  });

  test('queries reach the connection they name, and nowhere else', async () => {
    const app = pgClient('app');
    const reporting = pgClient('reporting');

    const db = createConnections({
      default: 'app',
      connections: {
        app: { driver: createPostgresDriver({ client: app.client }) },
        reporting: { driver: createPostgresDriver({ client: reporting.client }) },
      },
    });

    await db.connection('reporting').query(statement('select 2'));
    await db.defaultDatabase.query(statement('select 1'));

    expect(reporting.executed).toEqual(['reporting:select 2']);
    expect(app.executed).toEqual(['app:select 1']);
  });

  test('a transaction on one connection does not enrol another', async () => {
    const app = pgClient('app');
    const reporting = pgClient('reporting');

    const db = createConnections({
      default: 'app',
      connections: {
        app: { driver: createPostgresDriver({ client: app.client }) },
        reporting: { driver: createPostgresDriver({ client: reporting.client }) },
      },
    });

    const reportingId = db.connection('reporting');

    await db.defaultDatabase.interactiveTx(async (tx) => {
      // The tx scope is a different object over a different driver...
      expect(tx).not.toBe(db.defaultDatabase);
      // ...but `connection()` is not scoped by it: asking for another connection
      // inside a transaction returns the registry's object, not a tx of that
      // connection. Cross-connection atomicity is not something a wrapper can
      // invent (ADR-0019 § 6).
      expect(tx.connection('reporting')).toBe(reportingId);
      await tx.query(statement('select 1'));
    });

    // Everything happened on a client derived from `app`, and nothing at all
    // reached `reporting`: the tx scope did not fan out.
    expect(app.executed).toEqual(['app:tx:select 1']);
    expect(reporting.executed).toEqual([]);
  });

  test('health reports every connection and close drains every one', async () => {
    const app = pgClient('app');
    const reporting = pgClient('reporting');

    const db = createConnections({
      default: 'app',
      connections: {
        app: { driver: createPostgresDriver({ client: app.client }) },
        reporting: { driver: createPostgresDriver({ client: reporting.client }) },
      },
    });

    const health = await db.health();
    expect(Object.keys(health).sort()).toEqual(['app', 'reporting']);
    expect(health.app.ok).toBe(true);

    await db.close();
    // Default first: the request path stops before the connection it fans out to.
    expect(app.executed.at(-1)).toBe('app:end');
    expect(reporting.executed.at(-1)).toBe('reporting:end');
    expect(db.defaultDatabase.closed).toBe(true);
  });
});

describe('observability per connection (DB-021)', () => {
  test('every query event names the connection that ran it', async () => {
    const events: { connection?: string; sql?: string }[] = [];
    const app = pgClient('app');
    const reporting = pgClient('reporting');

    const db = createConnections({
      default: 'app',
      connections: {
        app: {
          driver: createPostgresDriver({ client: app.client }),
          logging: 'all',
          log: (event) => {
            events.push(event);
          },
        },
        reporting: {
          driver: createPostgresDriver({ client: reporting.client }),
          logging: 'all',
          log: (event) => {
            events.push(event);
          },
        },
      },
    });

    await db.defaultDatabase.query(statement('select 1'));
    await db.connection('reporting').query(statement('select 2'));

    // The dimension is what makes a mixed-engine log readable; without it the two
    // lines are indistinguishable after redaction removed the literals.
    expect(events.map((event) => event.connection)).toEqual(['app', 'reporting']);
    expect(events.map((event) => event.sql)).toEqual(['select 1', 'select 2']);
  });
});

describe('shutdown (DB-021)', () => {
  test('the registry spends one budget across every connection', async () => {
    const budgets: number[] = [];
    const slow = pgClient('slow');
    const fast = pgClient('fast');

    // Each driver reports the budget it was given, and the first one spends real
    // time before returning — which is what makes the second budget smaller.
    const withBudget = (client: PgClientLike) => {
      const driver = createPostgresDriver({ client });
      const close = driver.close.bind(driver);
      return {
        ...driver,
        async close(options?: { readonly timeoutMs?: number }) {
          budgets.push(options?.timeoutMs ?? -1);
          if (budgets.length === 1) await Bun.sleep(30);
          await close(options);
        },
      };
    };

    const db = createConnections({
      default: 'slow',
      connections: {
        slow: { driver: withBudget(slow.client) },
        fast: { driver: withBudget(fast.client) },
      },
    });

    await db.close({ timeoutMs: 1_000 });

    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toBeLessThanOrEqual(1_000);
    // One budget, not two: the second connection gets what is left.
    expect(budgets[1]).toBeLessThanOrEqual(970);
  });

  test('a single database still drains with its own default when no budget is given', async () => {
    const database = createDatabase({ driver: d1Driver() });
    await database.close();
    expect(database.closed).toBe(true);
  });
});

describe('the config shape of a registry', () => {
  test('requires a default that is declared', () => {
    const result = databaseConfigSchema.safeParse({
      default: 'reporting',
      connections: { app: { driver: 'd1' } },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain(
      'database.default names a connection that is not declared',
    );
  });

  test('a valid registry keeps each entry’s own settings', () => {
    const config = databaseConfigSchema.parse({
      default: 'app',
      connections: {
        app: { driver: 'd1', logging: 'slow' },
        reporting: { driver: 'postgres', pool: { max: 4 }, statementTimeoutMs: 1_000 },
      },
    });

    expect(config.connections.app?.driver).toBe('d1');
    expect(config.connections.reporting?.pool?.max).toBe(4);
    // `default` first, then declaration order — the order errors and `close()` use.
    expect(connectionNames(config)).toEqual(['app', 'reporting']);
  });

  test('a D1 entry may not carry a pool, under any name', () => {
    const result = databaseConfigSchema.safeParse({
      default: 'app',
      connections: { app: { driver: 'd1', pool: { max: 2 } } },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain(
      'has no effect on D1',
    );
  });

  test('the schema is a standard schema, so any validator can consume it', () => {
    // Same contract `@tsir/validate` relies on for application schemas.
    expect(z.object({}).safeParse({}).success).toBe(true);
    expect(typeof databaseConfigSchema['~standard'].validate).toBe('function');
  });
});

describe('per-connection capability requirements (DB-020)', () => {
  function twoEngines(): ReturnType<typeof createConnections> {
    const reporting = pgClient('reporting');
    return createConnections({
      default: 'app',
      connections: {
        app: { driver: d1Driver() },
        reporting: { driver: createPostgresDriver({ client: reporting.client }) },
      },
    });
  }

  test('a requirement is checked against the connection it names, not the default', () => {
    const db = twoEngines();

    // Same process, two answers — which is the whole point of a registry.
    expect(() =>
      assertConnectionRequirements(db, [{ component: 'ReportExport', interactiveTx: true }]),
    ).toThrow('ReportExport');

    expect(() =>
      assertConnectionRequirements(db, [
        { component: 'ReportExport', connection: 'reporting', interactiveTx: true },
      ]),
    ).not.toThrow();
  });

  test('the failure names the component, the connection and that connection’s engine', () => {
    const db = twoEngines();

    const error = (() => {
      try {
        assertConnectionRequirements(db, [
          { component: 'ReportExport', interactiveTx: true },
          { component: 'Ledger', connection: 'app', interactiveTx: true },
          { component: 'Audit' },
        ]);
        return undefined;
      } catch (reason: unknown) {
        return reason as { code?: string; message?: string; hint?: string };
      }
    })();

    expect(error?.code).toBe('DB_REQUIRES_TX_CONNECTION');
    // Both failures, in one boot error.
    expect(error?.message).toContain('ReportExport');
    expect(error?.message).toContain('Ledger');
    expect(error?.message).toContain('"app" (d1)');
    expect(error?.hint).toContain('Postgres');
  });

  test('a typo in a requirement is a name error, not a capability error', () => {
    const db = twoEngines();

    expect(
      codeOf(() =>
        assertConnectionRequirements(db, [
          { component: 'ReportExport', connection: 'reportng', interactiveTx: true },
        ]),
      ),
    ).toBe('DB_UNKNOWN_CONNECTION');
  });

  test('components that need nothing are never checked against anything', () => {
    const db = twoEngines();
    expect(() => assertConnectionRequirements(db, [{ component: 'Health' }])).not.toThrow();
  });
});
