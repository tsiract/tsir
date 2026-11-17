import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createDrizzle } from '@tsir/database/drizzle';
import { createConnectionsFromConfig } from '@tsir/database/from-config';
import { createQueryMonitor } from './query-monitor.ts';
import { telemetryTableDdl } from './tables.ts';

/**
 * `DX-014`, proved the only way that means anything: a statement is run through the real driver,
 * the real config factory and the real sink, and what arrives is asserted.
 *
 * A unit test of `record()` would pass while `createConnectionsFromConfig` still passed no sink —
 * which was exactly the bug the ledger recorded.
 */

const event = (over: Partial<Record<string, unknown>> = {}) => ({
  event: 'db.query' as const,
  connection: 'main',
  level: 'all' as const,
  sql: 'select * from users where id = ?',
  paramTypes: ['number'] as const,
  paramCount: 1,
  durationMs: 5,
  rows: 1,
  ok: true,
  slow: false,
  ...over,
});

/** A Drizzle stand-in that records instead of inserting. */
function fakeDrizzle() {
  const written: unknown[] = [];
  return {
    written,
    insert: () => ({
      values: (value: unknown) => {
        written.push(value);
        return Promise.resolve();
      },
    }),
  };
}

describe('the sink reaches the driver through the config factory', () => {
  test('a real statement is reported, redacted, and written', async () => {
    const handle = new Database(':memory:');
    handle.run('create table users (id integer primary key, email text)');
    handle.run("insert into users (id, email) values (1, 'ada@example.com')");

    const drizzle = fakeDrizzle();
    const monitor = createQueryMonitor({ drizzle, engine: 'd1', level: 'all' });
    const databases = createConnectionsFromConfig(
      {
        default: 'main',
        connections: {
          main: {
            driver: 'sqlite',
            url: 'file::memory:',
            logging: 'all',
            slowQueryMs: 1,
            statementTimeoutMs: 5_000,
          },
        },
      },
      async () => ({ main: handle }),
      {
        log: (reported) => {
          if (reported.event === 'db.query') void monitor.record(reported);
        },
      },
    );

    await databases.defaultDatabase.query({
      sql: "select * from users where email = 'ada@example.com'",
      params: [],
    });

    // The sink is called synchronously by the driver, but `record` awaits its insert; one tick is
    // enough and a timer would make the test flaky rather than more correct.
    await Promise.resolve();

    const [row] = monitor.recent();
    expect(row).toBeDefined();
    expect(row?.connection).toBe('main');
    // The defect: before `logging`/`slowQueryMs`/`log` were passed, this string never existed.
    expect(row?.sql).toBe('select * from users where email = ?');
    expect(row?.sql).not.toContain('ada@example.com');
    expect(drizzle.written).toHaveLength(1);
  });

  test('a second connection reports under its own name', async () => {
    const seen: string[] = [];
    const first = new Database(':memory:');
    const second = new Database(':memory:');
    const databases = createConnectionsFromConfig(
      {
        default: 'main',
        connections: {
          main: {
            driver: 'sqlite',
            url: 'file::memory:',
            logging: 'all',
            slowQueryMs: 1,
            statementTimeoutMs: 5_000,
          },
          reporting: {
            driver: 'sqlite',
            url: 'file::memory:',
            logging: 'all',
            slowQueryMs: 1,
            statementTimeoutMs: 5_000,
          },
        },
      },
      async () => ({ main: first, reporting: second }),
      {
        log: (reported) => {
          seen.push(reported.connection);
        },
      },
    );

    await databases.defaultDatabase.query({ sql: 'select 1', params: [] });
    await databases.connection('reporting').query({ sql: 'select 2', params: [] });

    expect(seen).toEqual(['main', 'reporting']);
  });

  test('with no sink configured nothing is reported — the old behaviour is opt-in, not default', async () => {
    const handle = new Database(':memory:');
    const databases = createConnectionsFromConfig(
      {
        default: 'main',
        connections: {
          main: {
            driver: 'sqlite',
            url: 'file::memory:',
            logging: 'all',
            slowQueryMs: 200,
            statementTimeoutMs: 5_000,
          },
        },
      },
      async () => ({ main: handle }),
    );
    // No throw, and nothing to assert beyond the query working: a standalone `Database` with no
    // observer must behave exactly as before.
    const result = await databases.defaultDatabase.query({ sql: 'select 1 as one', params: [] });
    expect(result.rows).toHaveLength(1);
  });
});

describe('what the monitor keeps', () => {
  test('`slow` level keeps slow statements and every failure, and drops fast successes', async () => {
    const monitor = createQueryMonitor({ drizzle: fakeDrizzle(), level: 'slow' });
    await monitor.record(event({ durationMs: 1, slow: false }));
    await monitor.record(event({ durationMs: 900, slow: true }));
    await monitor.record(event({ ok: false, slow: false, error: 'boom' }));

    expect(monitor.recent()).toHaveLength(2);
    expect(monitor.failures()).toHaveLength(1);
    expect(monitor.slowerThan(500).map((row) => row.durationMs)).toEqual([900]);
  });

  test('`all` level keeps a fast success too', async () => {
    const monitor = createQueryMonitor({ drizzle: fakeDrizzle(), level: 'all' });
    await monitor.record(event({ durationMs: 1, slow: false }));
    expect(monitor.recent()).toHaveLength(1);
  });

  test('an insert that fails is counted, not thrown', async () => {
    // Observability must not become a dependency: the statement already ran.
    const monitor = createQueryMonitor({
      drizzle: {
        insert: () => ({
          values: () => Promise.reject(new Error('telemetry table is gone')),
        }),
      },
      level: 'all',
    });
    void monitor.record(event());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(monitor.dropped).toBe(1);
    // Still readable in memory, which is what a page shows before a migration has run.
    expect(monitor.recent()).toHaveLength(1);
  });

  test('the monitor does not record its own insert', async () => {
    // The defect this test exists for: the monitor's insert goes through the driver, which emits an
    // event, which the monitor records, which inserts… The process did not crash, it stopped
    // answering — and the first version of this file shipped that shape.
    const monitor = createQueryMonitor({ drizzle: fakeDrizzle(), level: 'all' });
    await monitor.record(
      event({
        sql: 'insert into "query_logs" ("id", "connection", "sql") values (?, ?, ?)',
      }),
    );
    expect(monitor.recent()).toEqual([]);
  });

  test('a real table called query_logs_archive is not mistaken for the monitor', async () => {
    const monitor = createQueryMonitor({ drizzle: fakeDrizzle(), level: 'all' });
    await monitor.record(event({ sql: 'select * from query_logs_archive where id = ?' }));
    expect(monitor.recent()).toHaveLength(1);
  });

  test('a real driver, a real table: one row written, no runaway', async () => {
    // The fake provider above cannot recurse. This one can: the sink is the same object that runs
    // the statement, which is the exact configuration the admin app has.
    const handle = new Database(':memory:');
    for (const ddl of telemetryTableDdl('d1')) handle.run(ddl);

    // Assigned before any query runs; the sink closes over it, which is why it is a holder rather
    // than a value that exists when `createConnectionsFromConfig` is called.
    const holder: { monitor?: ReturnType<typeof createQueryMonitor> } = {};
    const databases = createConnectionsFromConfig(
      {
        default: 'main',
        connections: {
          main: {
            driver: 'sqlite',
            url: 'file::memory:',
            logging: 'all',
            slowQueryMs: 1,
            statementTimeoutMs: 5_000,
          },
        },
      },
      async () => ({ main: handle }),
      {
        log: (reported) => {
          if (reported.event === 'db.query') void holder.monitor?.record(reported);
        },
      },
    );
    const drizzle = createDrizzle(databases.defaultDatabase);
    const monitor = createQueryMonitor({ drizzle: drizzle, engine: 'd1', level: 'all' });
    holder.monitor = monitor;

    await databases.defaultDatabase.query({ sql: 'select 1 as one', params: [] });
    // Long enough for the nested insert to have completed, short enough that a runaway would still
    // be running when the assertion fired.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stored = handle.query<{ c: number }, []>('select count(*) as c from query_logs').get();
    expect(stored?.c).toBe(1);
    expect(monitor.recent()).toHaveLength(1);
  });

  test('the buffer is bounded, newest first', async () => {
    const monitor = createQueryMonitor({ drizzle: fakeDrizzle(), level: 'all', bufferLimit: 2 });
    await monitor.record(event({ durationMs: 1 }));
    await monitor.record(event({ durationMs: 2 }));
    await monitor.record(event({ durationMs: 3 }));
    expect(monitor.recent().map((row) => row.durationMs)).toEqual([3, 2]);
  });
});
