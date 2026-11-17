import { describe, expect, test } from 'bun:test';
import {
  createQueueMonitor,
  createRequestLogger,
  telemetryTableDdl,
  telemetryTables,
} from './index.ts';
import { eq } from 'drizzle-orm';
import { drizzle as postgresDrizzle } from 'drizzle-orm/pg-proxy';
import { drizzle as sqliteDrizzle } from 'drizzle-orm/sqlite-proxy';

/** An in-memory Drizzle-like store that returns empty results. */
function createMockDrizzle() {
  const empty = {
    from: () => empty,
    where: () => empty,
    orderBy: () => empty,
    limit: () => empty,
    offset: () => Promise.resolve([]),
  };
  return {
    select: () => empty,
    insert: () => ({ values: () => Promise.resolve(undefined) }),
    delete: () => ({ where: () => Promise.resolve(undefined) }),
    // The mock is not a connection; both overloads accept it only through this cast, which the
    // cases below pair with `expect(monitor.tables)` — the real dialect assertion.
  } as unknown as Parameters<typeof createQueueMonitor>[0];
}

describe('telemetry request logger', () => {
  test('record inserts a row without throwing', async () => {
    const drizzle = createMockDrizzle();
    const logger = createRequestLogger(drizzle);
    await logger.record({ method: 'GET', path: '/', status: 200, durationMs: 5 });
    expect(true).toBe(true);
  });
});

describe('telemetry queue monitor', () => {
  test('countsByState returns zeros for empty store', async () => {
    const drizzle = createMockDrizzle();
    const monitor = createQueueMonitor(drizzle);
    const counts = await monitor.countsByState();
    expect(counts).toEqual({ pending: 0, running: 0, delayed: 0, failed: 0 });
  });

  test('getJob returns null for unknown id', async () => {
    const drizzle = createMockDrizzle();
    const monitor = createQueueMonitor(drizzle);
    const job = await monitor.getJob('nope');
    expect(job).toBeNull();
  });

  test('listJobs returns empty array', async () => {
    const drizzle = createMockDrizzle();
    const monitor = createQueueMonitor(drizzle);
    const rows = await monitor.listJobs();
    expect(rows).toEqual([]);
  });

  test('retryJob returns false when not found', async () => {
    const drizzle = createMockDrizzle();
    const monitor = createQueueMonitor(drizzle);
    const ok = await monitor.retryJob('nope');
    expect(ok).toBe(false);
  });
});

describe('the tables are built for the engine (INF-010)', () => {
  // These tables were `sqliteTable` constants, which looked portable and were not: a sqliteTable
  // handed to a Postgres connection emits SQLite SQL, and Postgres answers with a syntax error. The
  // bugs that hid behind that are the ones this block pins.

  const columnsOf = (table: unknown): string[] =>
    Object.keys(
      (table as Record<symbol, Record<string, unknown>>)[Symbol.for('drizzle:Columns')] ?? {},
    );

  test('a Postgres table is a Postgres table, and a D1 table is not', () => {
    // Drizzle marks the dialect with a symbol on the table object. Asserting it is the difference
    // between having a factory and having one that returns sqlite tables for both engines — which
    // is what the constants did, invisibly, because nothing ever asked.
    const pg = telemetryTables('postgres').queueJobs;
    const d1 = telemetryTables('d1').queueJobs;
    const symbolsOf = (table: unknown): string[] =>
      Object.getOwnPropertySymbols(table).map((symbol) => String(symbol));
    expect(symbolsOf(pg).some((s) => s.includes('drizzle:PgInlineForeignKeys'))).toBe(true);
    expect(symbolsOf(d1).some((s) => s.includes('drizzle:SQLiteInlineForeignKeys'))).toBe(true);
    expect(symbolsOf(pg)).not.toEqual(symbolsOf(d1));
  });

  test('both engines expose the same column names, so app code does not branch', () => {
    // The point of a factory is that only the *tables* differ. If the column accessors diverged,
    // every query would need a dialect branch and the factory would have moved the problem.
    for (const table of ['requestLogs', 'queueJobs', 'queueDead'] as const) {
      expect(columnsOf(telemetryTables('postgres')[table])).toEqual(
        columnsOf(telemetryTables('d1')[table]),
      );
    }
  });

  test('the DDL differs where the dialects differ, and only there', () => {
    const pg = telemetryTableDdl('postgres').join('\n');
    const d1 = telemetryTableDdl('d1').join('\n');
    // Epoch milliseconds are BIGINT on Postgres and INTEGER on SQLite; reading a BIGINT as
    // `integer` truncates a timestamp to a plausible-looking wrong date.
    expect(pg).toContain('BIGINT');
    expect(d1).toContain('INTEGER');
    expect(d1).not.toContain('BIGINT');
    expect(pg.replaceAll('BIGINT', 'INTEGER')).toBe(d1);
  });

  test('the logger writes the table it reports, so a migration cannot disagree', () => {
    const mock = createMockDrizzle();
    const d1 = createRequestLogger(mock);
    const pg = createRequestLogger(mock, { engine: 'postgres' });
    expect(d1.table).toBe(telemetryTables('d1').requestLogs);
    expect(pg.table).toBe(telemetryTables('postgres').requestLogs);
  });

  test('the monitor reports the tables it queries', () => {
    const monitor = createQueueMonitor(createMockDrizzle(), { engine: 'postgres' });
    expect(monitor.tables.queueDead).toBe(telemetryTables('postgres').queueDead);
  });

  test('a created-at value is a number on both engines', () => {
    // The first version of this factory kept `integer(…, 'timestamp_ms')` on SQLite, which returns a
    // `Date`, while Postgres's `bigint(…, mode: 'number')` returns a number. That is a type split
    // across targets — exactly what the factory is supposed to remove — and this case caught it.
    for (const engine of ['d1', 'postgres'] as const) {
      const columns = (
        telemetryTables(engine).requestLogs as unknown as Record<
          symbol,
          Record<string, { dataType: string }>
        >
      )[Symbol.for('drizzle:Columns')];
      expect(columns?.['createdAt']?.dataType).toBe('number');
    }
  });
});

describe('the same query speaks both dialects (INF-010)', () => {
  test('Postgres gets `$1` and D1 gets `?`, from one code path', () => {
    // The failure `INF-010` describes: a `sqliteTable` handed to a Postgres connection emits `?`
    // placeholders, and Postgres rejects that with a syntax error pointing at the parameter rather
    // than at the table that caused it. Rendering the SQL to text proves the factory fixed it
    // without a live database — the placeholder is the dialect's signature.
    const rows = { rows: [] as unknown[] };
    const postgres = postgresDrizzle<Record<string, never>>(async () => rows);
    const sqlite = sqliteDrizzle(async () => rows);

    // The tables come back typed as a union of both dialects, which is honest but awkward to call
    // directly; each builder is handed the one built for it, as an application does by choosing an
    // engine once at construction. The assertion is on the rendered SQL, not on the types.
    const pg = telemetryTables('postgres').queueJobs;
    const d1 = telemetryTables('d1').queueJobs;
    const pgQuery = postgres
      .select()
      .from(pg as never)
      .where(eq(pg.id as never, 'job-1'))
      .toSQL();
    const d1Query = sqlite
      .select()
      .from(d1 as never)
      .where(eq(d1.id as never, 'job-1'))
      .toSQL();

    expect(pgQuery.sql).toContain('$1');
    expect(pgQuery.sql).not.toContain('?');
    expect(d1Query.sql).toContain('?');
    expect(d1Query.sql).not.toContain('$1');
    // Same statement otherwise: the columns and the table name do not differ between the dialects.
    expect(pgQuery.sql.replace('$1', '?')).toBe(d1Query.sql);
  });
});
