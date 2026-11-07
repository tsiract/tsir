/**
 * The `system` module — cross-cutting infrastructure.
 *
 * Every `@tsir/*` package the app uses is wired here as DI providers. Other
 * modules receive them via constructor injection rather than importing
 * singletons. The `queues` and `events` singletons are still exported because
 * the CLI reads them without a booted container.
 */
export { system, providers } from './routes.ts';
export { registry } from './registry.ts';

// Observability
export { logger, consoleLogger, metrics } from './services/pulse.ts';
export {
  healthToken,
  healthProvider,
  loggerToken,
  loggerProvider,
  consoleLoggerToken,
  consoleLoggerProvider,
  metricsToken,
  metricsProvider,
} from './services/pulse.ts';

// Caching
export { caches } from './services/cache.ts';
export { cachesToken, cachesProvider } from './services/cache.ts';

// Storage
export { disks } from './services/storage.ts';
export { disksToken, disksProvider } from './services/storage.ts';

// Encryption
export { vault } from './services/vault.ts';
export { vaultToken, vaultProvider } from './services/vault.ts';

// Notifications
export { userRegisteredNotification } from './services/notify.ts';
export {
  notifierToken,
  notifierProvider,
  userRegisteredNotificationToken,
  userRegisteredNotificationProvider,
} from './services/notify.ts';

// Queue + events (co-located because they reference each other)
export { queues, events, UserRegisteredEvent } from './services/events.ts';
export {
  queuesToken,
  queuesProvider,
  queueToken,
  queueProvider,
  eventsToken,
  eventsProvider,
} from './services/events.ts';

// Scheduling
export { schedulerToken, schedulerProvider } from './services/schedule.ts';

// Authorization
export { registry as policyRegistry } from './services/policy.ts';
export { policyRegistryToken, policyRegistryProvider } from './services/policy.ts';

// Outbound HTTP
export { analyticsClient } from './services/link.ts';
export { analyticsClientToken, analyticsClientProvider } from './services/link.ts';

// Generated artifacts
export { SendWelcomeEmailJob } from './queues/send-welcome-email.job.ts';
export { SendWelcomeEmailListener } from './listeners/send-welcome-email.listener.ts';

// Feature flags (Pennant)
export { featureManagerToken, featureManagerProvider } from './services/pennant.ts';

// Search (Scout)
export { searchEngineToken, searchEngineProvider } from './services/scout.ts';

// Media processing
export { mediaManagerToken, mediaManagerProvider } from './services/media.ts';
