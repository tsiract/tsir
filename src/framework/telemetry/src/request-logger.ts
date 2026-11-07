/**
 * Telescope-style request logger.
 *
 * Records one row per HTTP request. The logger is a thin wrapper around a
 * Drizzle insert; the caller (app handler) extracts only safe fields before
 * calling `record()`.
 *
 * Security: no request/response bodies, and no `authorization`, `cookie`, or
 * `set-cookie` headers are ever stored.
 */
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';

/** Drizzle schema for the `request_logs` table. Import and use in migrations. */
export const requestLogs = sqliteTable('request_logs', {
  id: text('id').primaryKey(),
  method: text('method').notNull(),
  path: text('path').notNull(),
  status: integer('status').notNull(),
  durationMs: integer('duration_ms').notNull(),
  principalSubject: text('principal_subject'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(strftime('%s','now') * 1000)`),
});

export type RequestLog = typeof requestLogs.$inferSelect;

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  principalSubject?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Create a request logger bound to a Drizzle instance and the `requestLogs`
 * table. Any Tsir app using `@tsir/database` can call this.
 */
export function createRequestLogger(drizzle: SqliteRemoteDatabase<Record<string, unknown>>): {
  record(entry: RequestLogEntry): Promise<void>;
} {
  return {
    async record(entry: RequestLogEntry): Promise<void> {
      await drizzle.insert(requestLogs).values({
        id: crypto.randomUUID(),
        method: entry.method,
        path: entry.path,
        status: entry.status,
        durationMs: entry.durationMs,
        ...(entry.principalSubject !== undefined
          ? { principalSubject: entry.principalSubject }
          : {}),
        ...(entry.ip !== undefined ? { ip: entry.ip } : {}),
        ...(entry.userAgent !== undefined ? { userAgent: entry.userAgent } : {}),
      });
    },
  };
}
