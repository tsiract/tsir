import { routeModule as _routeModule } from '@tsir/router';
import { registry } from './registry.ts';
import { classProvider, factoryProvider } from '@tsir/container';

import { dbProvider, drizzleProvider } from '../../database.ts';
import {
  consoleLoggerProvider,
  healthProvider,
  loggerProvider,
  metricsProvider,
} from './services/pulse.ts';
import { cachesProvider } from './services/cache.ts';
import { disksProvider } from './services/storage.ts';
import { vaultProvider } from './services/vault.ts';
import { notifierProvider, userRegisteredNotificationProvider } from './services/notify.ts';
import { eventsProvider, queueProvider, queuesProvider } from './services/events.ts';
import { schedulerProvider } from './services/schedule.ts';
import { policyRegistryProvider } from './services/policy.ts';
import { analyticsClientProvider } from './services/link.ts';
import { SystemController, systemControllerToken } from './http/system.controller.ts';
import { RequestLogController, requestLogControllerToken } from './http/request-log.controller.ts';
import { QueueController, queueControllerToken } from './http/queue.controller.ts';
import { healthToken, metricsToken } from './services/pulse.ts';
import { AuditService, auditServiceToken } from '../shared/audit.ts';
import { drizzleToken } from '../../database.ts';
import { createAdminRequestLogger, requestLoggerToken } from './services/request-logger.ts';
import { createAdminQueueMonitor, queueMonitorToken } from './services/queue-monitor.ts';
import { featureManagerProvider, featureManagerToken } from './services/pennant.ts';
import { searchEngineProvider, searchEngineToken } from './services/scout.ts';
import { mediaManagerProvider } from './services/media.ts';
import {
  FeatureFlagsController,
  featureFlagsControllerToken,
} from './http/feature-flags.controller.ts';
import { SearchController, searchControllerToken } from './http/search.controller.ts';

// health is always configured in this app, so the token is defined at runtime.
const healthTk = healthToken;
if (healthTk === undefined) {
  throw new Error('health token is required — pulse bootstrap must include health config');
}

/** This module's route table. Only its own controllers add to it. */

/**
 * All infrastructure providers live in the `system` module so other modules
 * can depend on them without reaching for global singletons.
 *
 * `queuesProvider` and `queueProvider` come from the events bootstrap, which
 * returns `undefined` for them when no queue is configured — filter those out.
 */
export const providers = [
  dbProvider,
  drizzleProvider,
  loggerProvider,
  consoleLoggerProvider,
  metricsProvider,
  healthProvider,
  cachesProvider,
  disksProvider,
  vaultProvider,
  notifierProvider,
  userRegisteredNotificationProvider,
  queuesProvider,
  queueProvider,
  eventsProvider,
  schedulerProvider,
  policyRegistryProvider,
  analyticsClientProvider,
  classProvider(systemControllerToken, SystemController, [healthTk, metricsToken], {
    lifetime: 'scoped',
  }),
  classProvider(auditServiceToken, AuditService, [drizzleToken]),
  factoryProvider(requestLoggerToken, createAdminRequestLogger, [drizzleToken]),
  factoryProvider(queueMonitorToken, createAdminQueueMonitor, [drizzleToken]),
  classProvider(requestLogControllerToken, RequestLogController, [drizzleToken], {
    lifetime: 'scoped',
  }),
  classProvider(queueControllerToken, QueueController, [queueMonitorToken], {
    lifetime: 'scoped',
  }),
  featureManagerProvider,
  searchEngineProvider,
  mediaManagerProvider,
  classProvider(featureFlagsControllerToken, FeatureFlagsController, [featureManagerToken], {
    lifetime: 'scoped',
  }),
  classProvider(searchControllerToken, SearchController, [searchEngineToken], {
    lifetime: 'scoped',
  }),
].filter((p): p is NonNullable<typeof p> => p !== undefined);

export const system = _routeModule({
  name: 'system',
  registry,
  unit: 'http',
  providers,
});
