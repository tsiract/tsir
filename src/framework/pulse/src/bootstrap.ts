/**
 * One-call observability bootstrap for apps that use `@tsir/pulse`.
 *
 * Replaces the hand-written `modules/system/services/pulse.ts` every app
 * previously needed: it creates the logger, an optional console logger,
 * metrics, and an optional health registry — each with its DI token + value
 * provider.
 *
 * Sinks and health checks are app-specific, so the app passes them in.
 * Health checks that need the database close over it directly (the same
 * pattern `@tsir/cache` and `@tsir/storage` use for their bindings).
 */

import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { createLogger, type Logger, type LoggerOptions } from './logger.ts';
import { createMetrics, type Metrics } from './metrics.ts';
import { createHealth, type Health, type HealthOptions } from './health.ts';
import { memorySink } from './sinks.ts';

/** Options for `createPulseBootstrap`. */
export interface PulseBootstrapOptions {
  /** Options for the main logger. Defaults to a memory sink at `info` level. */
  readonly logger?: LoggerOptions;
  /** When supplied, a second logger writing to this sink (e.g. `stdoutSink()`). */
  readonly consoleLogger?: LoggerOptions;
  /** Metrics options. Omit to use defaults. */
  readonly metrics?: Parameters<typeof createMetrics>[0];
  /** Health checks. When supplied, a health registry is created with them. */
  readonly health?: HealthOptions;
}

/** Everything an app needs to wire its observability layer. */
export interface PulseBootstrap {
  /** The main logger. */
  readonly logger: Logger;
  /** DI token for `logger`. */
  readonly loggerToken: Token<Logger>;
  /** Value provider for `logger`. */
  readonly loggerProvider: Provider<Logger>;
  /** The console logger (only when `consoleLogger` options were supplied). */
  readonly consoleLogger: Logger | undefined;
  /** DI token for `consoleLogger`. */
  readonly consoleLoggerToken: Token<Logger> | undefined;
  /** Value provider for `consoleLogger`. */
  readonly consoleLoggerProvider: Provider<Logger> | undefined;
  /** The metrics registry. */
  readonly metrics: Metrics;
  /** DI token for `metrics`. */
  readonly metricsToken: Token<Metrics>;
  /** Value provider for `metrics`. */
  readonly metricsProvider: Provider<Metrics>;
  /** The health registry (only when `health` checks were supplied). */
  readonly health: Health | undefined;
  /** DI token for `health`. */
  readonly healthToken: Token<Health> | undefined;
  /** Value provider for `health`. */
  readonly healthProvider: Provider<Health> | undefined;
}

/**
 * Build the observability layer.
 *
 * ```ts
 * import { createPulseBootstrap, memorySink, stdoutSink } from '@tsir/pulse';
 * import { db } from '../../database.ts';
 * import { statement } from '@tsir/database';
 *
 * export const { logger, loggerToken, loggerProvider, metrics, metricsToken, metricsProvider, health, healthToken, healthProvider } =
 *   createPulseBootstrap({
 *     logger: { level: 'info', sink: memorySink() },
 *     consoleLogger: { level: 'info', sink: stdoutSink({ format: 'tsir' }) },
 *     health: {
 *       checks: [{
 *         name: 'database',
 *         async run() { await db.query(statement('select 1 as ok')); return true; },
 *       }],
 *     },
 *   });
 * ```
 */
export function createPulseBootstrap(options: PulseBootstrapOptions = {}): PulseBootstrap {
  const logger = createLogger({
    level: 'info',
    sink: memorySink(),
    ...options.logger,
  });

  const loggerToken = token<Logger>('logger');
  const loggerProvider = valueProvider(loggerToken, logger);

  let consoleLogger: PulseBootstrap['consoleLogger'];
  let consoleLoggerToken: PulseBootstrap['consoleLoggerToken'];
  let consoleLoggerProvider: PulseBootstrap['consoleLoggerProvider'];
  if (options.consoleLogger !== undefined) {
    consoleLogger = createLogger(options.consoleLogger);
    consoleLoggerToken = token<Logger>('consoleLogger');
    consoleLoggerProvider = valueProvider(consoleLoggerToken, consoleLogger);
  }

  const metrics = createMetrics(options.metrics);
  const metricsToken = token<Metrics>('metrics');
  const metricsProvider = valueProvider(metricsToken, metrics);

  let health: PulseBootstrap['health'];
  let healthToken: PulseBootstrap['healthToken'];
  let healthProvider: PulseBootstrap['healthProvider'];
  if (options.health !== undefined) {
    health = createHealth(options.health);
    healthToken = token<Health>('health');
    healthProvider = valueProvider(healthToken, health);
  }

  return {
    logger,
    loggerToken,
    loggerProvider,
    consoleLogger,
    consoleLoggerToken,
    consoleLoggerProvider,
    metrics,
    metricsToken,
    metricsProvider,
    health,
    healthToken,
    healthProvider,
  };
}
