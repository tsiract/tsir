/**
 * @tsir/queue — named job connections over one port (`§ 4.2`).
 *
 * Public surface:
 *   defineJob, createJobRegistry, createQueue, createWorker, retryDelayMs
 *
 * The transactional outbox is **not** here: writing one means knowing what a delivery is, which
 * is `@tsir/events`' half of the pair (`§ 4.5`). What stays is the refusal — a non-transactional
 * connection with no outbox is a boot error, not a runtime surprise.
 *
 * Drivers are subpaths, one manifest per dependency (ADR-0027):
 *   `@tsir/queue/memory` (tests, single process) · `/sync` (inline) · `/database` (Postgres/D1)
 *
 * What this package deliberately does not do: pretend delivery is exactly-once (it is
 * at-least-once, and `JobContext.id` is the idempotency key), retry a job declared
 * `retryable: false`, or dispatch to a connection that was never declared.
 */

export { createJobRegistry, defineJob, JOB_DEFAULTS } from './job.ts';
export type { BackoffOptions, JobContext, JobDefinition, JobRegistry } from './job.ts';

export { createQueue } from './queue.ts';
export type { CreateQueueOptions } from './queue.ts';

export { createWorker } from './worker.ts';
export type { JobOutcome, JobResult, Worker, WorkerOptions } from './worker.ts';

export type { SyncExecutor, SyncQueueOptions } from './drivers/sync.ts';

export { describeSchedule, retryDelayMs, retrySchedule } from './backoff.ts';
export type { RetryDelayOptions } from './backoff.ts';

export type {
  DispatchOptions,
  DispatchResult,
  JobLike,
  JobMessage,
  Queue,
  QueueBackend,
  QueueCapabilities,
  QueueDriver,
} from './port.ts';
export type { QueueSql, QueueSqlResult, QueueSqlStatement } from './sql.ts';

export { createQueues, QUEUE_DRIVERS } from './config.ts';
// The DDL, from the root, for the same reason `cacheTableDdl` is there: `tsir queue:table` prints
// a migration, and a person writing one should not have to know which driver subpath owns it.
export { queueTableDdl } from './drivers/database.ts';
export type { BuildQueuesOptions, ConfiguredConnection, QueueBindings, Queues } from './config.ts';
export type { QueueErrorCode } from './errors.ts';

export { createQueueBootstrap } from './bootstrap.ts';
export type { QueueBootstrap, QueueBootstrapOptions } from './bootstrap.ts';
