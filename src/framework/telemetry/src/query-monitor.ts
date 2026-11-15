/**
 * Query timings, recorded where a page can read them (`DX-014`).
 *
 * `@tsir/database` has had `logging`, `slowQueryMs` and a `log` sink on `DatabaseOptions` for a
 * while, and `createConnectionsFromConfig` passed none of them: an application configured
 * `logging: 'all'` and nothing observed a single statement. This module is the other end of that
 * sink — it takes the events the driver already emits and writes one row per statement.
 *
 * Two decisions worth stating, because both are the kind that look arbitrary from outside:
 *
 * **The statement is redacted before it is stored, not before it is displayed.** A monitor page is
 * a read of whatever the writer saved; if the writer saves the email address, every later reader
 * has it. `redactSql` runs here so there is exactly one place a value could have escaped, and it is
 * not in a view.
 *
 * **The monitor does not monitor itself.** Its own insert goes through the same driver that emits
 * the event, so recording it would emit another event, which records another row, forever. The
 * first version of this file did exactly that: the process did not crash, it stopped answering,
 * which is worse. A statement naming the monitor's own table is therefore not recorded — see the
 * comment on the guard for why the table name is the signal rather than a re-entrancy flag.
 *
 * **A failure to write a telemetry row never fails the query.** The statement already ran; the
 * monitor is an observer. `record` swallows its own errors and counts them, because the alternative
 * is a monitoring table outage turning into an application outage — the classic way observability
 * becomes a dependency.
 *
 * ```ts
 * const queryMonitor = createQueryMonitor({ drizzle, engine: 'd1' });
 * const { db } = createAppServices(config, { queryLog: (event) => queryMonitor.record(event) });
 * ```
 */

import type { QueryLogEvent } from '@tsir/database';
import { redactSql } from '@tsir/database/redaction';
import { telemetryTables, type TelemetryEngine } from './tables.ts';

/** The Drizzle surface this module needs: one insert, nothing else. */
export interface QueryMonitorDatabase {
  insert(table: never): { values(value: never): Promise<unknown> };
}

export interface QueryMonitorOptions {
  readonly drizzle: QueryMonitorDatabase;
  readonly engine?: TelemetryEngine | undefined;
  /**
   * `slow` keeps the point of a monitor — the statements worth looking at — while staying off the
   * hot path of a healthy application. `all` is for a debugging session, not a deployment.
   */
  readonly level?: 'slow' | 'all' | undefined;
  /** Rows kept in memory for a page that has not run a migration yet. */
  readonly bufferLimit?: number | undefined;
}

/** One stored statement, as a page reads it. */
export interface QueryRecord {
  readonly id: string;
  readonly connection: string;
  readonly sql: string;
  readonly durationMs: number;
  readonly rows: number;
  readonly ok: boolean;
  readonly error: string | undefined;
  readonly createdAt: number;
}

export interface QueryMonitor {
  /** The sink to hand `createConnectionsFromConfig` / `createAppServices`. */
  record(event: QueryLogEvent): Promise<void>;
  /** Newest first. Reads the in-memory buffer, not the table. */
  recent(limit?: number): readonly QueryRecord[];
  /** Failures only — the page's second tab, and the one that is usually empty. */
  failures(limit?: number): readonly QueryRecord[];
  /** Every statement slower than the threshold, newest first. */
  slowerThan(ms: number): readonly QueryRecord[];
  /** Rows that could not be written. A monitor that is silently broken is worse than none. */
  readonly dropped: number;
  /** The table to reference from a migration; same object the writer inserts into. */
  readonly table: ReturnType<typeof telemetryTables>['queryLogs'];
}

const DEFAULT_BUFFER = 500;

export function createQueryMonitor(options: QueryMonitorOptions): QueryMonitor {
  const engine = options.engine ?? 'd1';
  const level = options.level ?? 'slow';
  const limit = options.bufferLimit ?? DEFAULT_BUFFER;
  const table = telemetryTables(engine).queryLogs;
  /**
   * The table's own name, for the guard below.
   *
   * A re-entrancy flag cannot work here: `record` is async, the insert is awaited, and the driver
   * emits the nested event *inside* that await — so a boolean would already be back to `false` for
   * concurrent requests, and would be stuck `true` for an interleaved one. The statement text is
   * the only thing that is true at the moment the event is emitted, and "the statement writes my
   * own table" is exactly the condition that has to be excluded.
   */
  const ownTable = /query_logs\b/iu;
  const buffer: QueryRecord[] = [];
  let dropped = 0;

  const keep = (record: QueryRecord): void => {
    buffer.unshift(record);
    if (buffer.length > limit) buffer.length = limit;
  };

  return {
    table,
    get dropped() {
      return dropped;
    },
    async record(event: QueryLogEvent): Promise<void> {
      // The event carries a level because the *driver* decided to emit it. A monitor asked for
      // `all` should not be silently narrowed by that, and a monitor asked for `slow` should not
      // record every statement just because an app logs them all.
      if (level === 'slow' && event.ok && !event.slow) return;
      // See `ownTable`: this is the statement the monitor itself just issued.
      if (ownTable.test(event.sql)) return;

      const entry: QueryRecord = {
        id: crypto.randomUUID(),
        connection: event.connection,
        sql: redactSql(event.sql),
        durationMs: event.durationMs,
        rows: event.rows,
        ok: event.ok,
        error: event.error,
        createdAt: Date.now(),
      };
      keep(entry);
      try {
        await options.drizzle.insert(table as never).values(entry as never);
      } catch {
        // Counted, not thrown: see the header.
        dropped += 1;
      }
    },
    recent(count = 50) {
      return buffer.slice(0, count);
    },
    failures(count = 50) {
      return buffer.filter((record) => !record.ok).slice(0, count);
    },
    slowerThan(ms) {
      return buffer.filter((record) => record.durationMs >= ms);
    },
  };
}
