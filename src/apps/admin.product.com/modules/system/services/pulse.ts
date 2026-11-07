/**
 * Observability: structured logging, health checks, and metrics.
 *
 * `@tsir/pulse` gives the admin app a single logger, a health report, and
 * named metrics. The logger writes structured records; fields are redacted by
 * default so a password or token passed to a log call is never written out.
 *
 * The health check answers `/system/ready` — a readiness probe that the
 * platform (and `tsir doctor`) can call. Metrics are in-memory counters and
 * timers; a real deployment would add a Prometheus exporter.
 */
import { createPulseBootstrap, memorySink, stdoutSink } from '@tsir/pulse';
import { statement } from '@tsir/database';
import { db } from '../../../database.ts';

export const {
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
} = createPulseBootstrap({
  logger: { level: 'info', sink: memorySink() },
  consoleLogger: { level: 'info', sink: stdoutSink({ format: 'tsir' }) },
  health: {
    checks: [
      {
        name: 'database',
        async run() {
          await db.query(statement('select 1 as ok'));
          return true;
        },
      },
    ],
  },
});
