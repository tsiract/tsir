/**
 * Telescope-style request logger.
 *
 * Records one row per HTTP request. The logger is a thin wrapper around a Drizzle insert; the caller
 * (app handler) extracts only safe fields before calling `record()`.
 *
 * The engine is an argument, not an assumption (`INF-010`). These tables were `sqliteTable`
 * constants, which read as portable code and were not: Drizzle does not translate one dialect's
 * table into another, so on the documented AWS default (Postgres) every query this module built
 * carried SQLite syntax. `telemetryTables(engine)` returns tables built for the engine, and the
 * logger asks for the ones it will query.
 *
 * Security: no request/response bodies, and no `authorization`, `cookie`, or `set-cookie` headers are
 * ever stored.
 */
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { telemetryTables, type TelemetryEngine } from './tables.ts';

export type { TelemetryEngine };

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  principalSubject?: string;
  ip?: string;
  userAgent?: string;
}

/** The minimum a Drizzle instance must offer. Both dialects satisfy it. */
export type RequestLogDatabase =
  | BaseSQLiteDatabase<'sync' | 'async', unknown, Record<string, unknown>>
  | PgDatabase<never, Record<string, unknown>>;

export interface RequestLoggerOptions {
  /**
   * Which dialect the connection speaks. Default `'d1'` — the Cloudflare default — because a caller
   * that says nothing is on the default target, and guessing from the driver object is not possible
   * without importing the driver.
   */
  readonly engine?: TelemetryEngine | undefined;
}

/**
 * Create a request logger bound to a Drizzle instance.
 *
 * `engine` defaults to `'d1'`; pass `'postgres'` on AWS, or the insert fails with a syntax error
 * naming a SQLite function — which is a confusing way to learn the argument was missing.
 */
export function createRequestLogger(
  drizzle: RequestLogDatabase,
  options: RequestLoggerOptions = {},
): {
  record(entry: RequestLogEntry): Promise<void>;
  /** The table to reference from a migration. Same object the logger writes to. */
  readonly table: ReturnType<typeof telemetryTables>['requestLogs'];
} {
  const engine = options.engine ?? 'd1';
  const table = telemetryTables(engine).requestLogs;

  return {
    table,
    async record(entry: RequestLogEntry): Promise<void> {
      // `createdAt` is set here rather than by a column default: `strftime` is SQLite's, and a
      // default that only one dialect understands is how the previous version failed on Postgres.
      await (drizzle as unknown as { insert(t: unknown): { values(v: unknown): Promise<void> } })
        .insert(table)
        .values({
          id: crypto.randomUUID(),
          method: entry.method,
          path: entry.path,
          status: entry.status,
          durationMs: entry.durationMs,
          createdAt: Date.now(),
          ...(entry.principalSubject !== undefined
            ? { principalSubject: entry.principalSubject }
            : {}),
          ...(entry.ip !== undefined ? { ip: entry.ip } : {}),
          ...(entry.userAgent !== undefined ? { userAgent: entry.userAgent } : {}),
        });
    },
  };
}
