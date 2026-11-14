/**
 * @tsir/telemetry — Telescope-style request logging + Horizon-style queue monitoring.
 *
 * Any Tsir app can use this to log requests and inspect queue state. The admin
 * app's `request-logger` and `queue-monitor` services are thin wrappers around
 * this package.
 *
 * ```ts
 * import { createTelemetryBootstrap } from '@tsir/telemetry';
 *
 * const { requestLogger, queueMonitor } = createTelemetryBootstrap({ drizzle });
 *
 * await requestLogger.record({ method: 'GET', path: '/', status: 200, durationMs: 12 });
 * const counts = await queueMonitor.countsByState();
 * ```
 */

export {
  createRequestLogger,
  type RequestLogDatabase,
  type RequestLogEntry,
  type RequestLoggerOptions,
} from './request-logger.ts';

export {
  createQueueMonitor,
  type JobCounts,
  type JobState,
  type PostgresConnection,
  type QueueJobRow,
  type QueueMonitor,
  type QueueMonitorOptions,
  type SqliteConnection,
} from './queue-monitor.ts';

// The tables are no longer module constants: `sqliteTable(…)` handed to a Postgres connection emits
// SQLite SQL, which is what made this package D1-and-SQLite-only while looking portable (`INF-010`).
// One factory, so the choice is made where the engine is known.
export {
  telemetryTables,
  telemetryTableDdl,
  type TelemetryEngine,
  type TelemetryTables,
} from './tables.ts';

export { createTelemetryBootstrap } from './bootstrap.ts';
export type { TelemetryBootstrap, TelemetryBootstrapOptions } from './bootstrap.ts';
