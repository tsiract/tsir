/**
 * One-call bootstrap for `@tsir/telemetry`.
 */
import { token, valueProvider, type Provider, type Token } from '@tsir/container';
import type { PostgresConnection, QueueMonitor, SqliteConnection } from './queue-monitor.ts';

import { createQueueMonitor } from './queue-monitor.ts';
import { createRequestLogger, type RequestLoggerOptions } from './request-logger.ts';
import type { TelemetryEngine } from './tables.ts';

/** Either dialect. The engine decides which tables are built (`INF-010`). */
export type TelemetryDatabase = SqliteConnection | PostgresConnection;

export interface TelemetryBootstrapOptions {
  readonly drizzle: TelemetryDatabase;
  /**
   * Default `'d1'`. On AWS the database is Postgres, and the previous version had no way to say so
   * — it built SQLite tables unconditionally and failed at the first query.
   */
  readonly engine?: TelemetryEngine | undefined;
}

export interface TelemetryBootstrap {
  readonly requestLogger: ReturnType<typeof createRequestLogger>;
  readonly queueMonitor: QueueMonitor;
  readonly requestLoggerToken: Token<ReturnType<typeof createRequestLogger>>;
  readonly requestLoggerProvider: Provider<ReturnType<typeof createRequestLogger>>;
  readonly queueMonitorToken: Token<ReturnType<typeof createQueueMonitor>>;
  readonly queueMonitorProvider: Provider<ReturnType<typeof createQueueMonitor>>;
}

export function createTelemetryBootstrap(options: TelemetryBootstrapOptions): TelemetryBootstrap {
  const loggerOptions: RequestLoggerOptions =
    options.engine === undefined ? {} : { engine: options.engine };
  const requestLogger = createRequestLogger(options.drizzle, loggerOptions);
  const queueMonitor = createQueueMonitor(options.drizzle, loggerOptions);

  const requestLoggerToken = token<typeof requestLogger>('requestLogger');
  const queueMonitorToken = token<typeof queueMonitor>('queueMonitor');

  return {
    requestLogger,
    queueMonitor,
    requestLoggerToken,
    requestLoggerProvider: valueProvider(requestLoggerToken, requestLogger),
    queueMonitorToken,
    queueMonitorProvider: valueProvider(queueMonitorToken, queueMonitor),
  };
}
