/**
 * One-call bootstrap for `@tsir/telemetry`.
 */
import { token, valueProvider, type Provider, type Token } from '@tsir/container';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';

import { createQueueMonitor } from './queue-monitor.ts';
import { createRequestLogger } from './request-logger.ts';

export interface TelemetryBootstrapOptions {
  readonly drizzle: SqliteRemoteDatabase<Record<string, unknown>>;
}

export interface TelemetryBootstrap {
  readonly requestLogger: ReturnType<typeof createRequestLogger>;
  readonly queueMonitor: ReturnType<typeof createQueueMonitor>;
  readonly requestLoggerToken: Token<ReturnType<typeof createRequestLogger>>;
  readonly requestLoggerProvider: Provider<ReturnType<typeof createRequestLogger>>;
  readonly queueMonitorToken: Token<ReturnType<typeof createQueueMonitor>>;
  readonly queueMonitorProvider: Provider<ReturnType<typeof createQueueMonitor>>;
}

export function createTelemetryBootstrap(options: TelemetryBootstrapOptions): TelemetryBootstrap {
  const requestLogger = createRequestLogger(options.drizzle);
  const queueMonitor = createQueueMonitor(options.drizzle);

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
