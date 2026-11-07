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
  requestLogs,
  type RequestLog,
  type RequestLogEntry,
} from './request-logger.ts';

export {
  createQueueMonitor,
  queueJobs,
  queueDead,
  type JobCounts,
  type JobState,
  type QueueJobRow,
} from './queue-monitor.ts';

export { createTelemetryBootstrap } from './bootstrap.ts';
export type { TelemetryBootstrap, TelemetryBootstrapOptions } from './bootstrap.ts';
