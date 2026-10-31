/**
 * `queue.connections` in `tsir.js` (`CAP-001`, `CAP-004`, `§ 2.2`).
 *
 * One registry, an explicit `default`, and the two failures a person actually hits: a
 * misspelt driver, and a driver that needs a client only the application can supply.
 *
 * The production guard is the interesting one. `memory` and `sync` are allowed everywhere a
 * developer works and refused where durability is the point — a `sync` connection in
 * production runs the job inside the request that dispatched it, which turns a slow job into a
 * slow request and a crashed job into a failed one.
 */

import { driverMissing, forbiddenInProduction, unknownConnection } from './errors.ts';
import { cloudflareQueuesDriver, type QueueProducerLike } from './drivers/cloudflare-queues.ts';
import { databaseQueueDriver } from './drivers/database.ts';
import { memoryQueueDriver } from './drivers/memory.ts';
import { sqsDriver, type SqsLike } from './drivers/sqs.ts';
import { syncQueueDriver, type SyncExecutor } from './drivers/sync.ts';
import { outboxRequired } from './errors.ts';
import { createJobRegistry, type JobDefinition, type JobRegistry } from './job.ts';
import { createQueue } from './queue.ts';
import { createWorker, type Worker } from './worker.ts';
import type { Queue, QueueBackend, QueueDriver } from './port.ts';
import type { QueueSql } from './sql.ts';

export const QUEUE_DRIVERS = ['memory', 'sync', 'database', 'cloudflare-queues', 'sqs'] as const;

/** The drivers that cannot enqueue inside the caller's write — the outbox is mandatory on them. */
export const NON_TRANSACTIONAL_QUEUE_DRIVERS: readonly string[] = ['cloudflare-queues', 'sqs'];

export interface ConfiguredConnection {
  /** As written in `tsir.js`; a string, so an unknown name is `CAP_DRIVER_MISSING`. */
  readonly driver: string;
  /** Which SQL client backs a `database` connection. Default `default`. */
  readonly connection?: string | undefined;
  readonly table?: string | undefined;
  readonly deadTable?: string | undefined;
  /**
   * Declares that this connection has a transactional outbox. **Mandatory** on
   * `cloudflare-queues` and `sqs` (`§ 4.2`): without it the enqueue is a second, independent
   * write, and the two failures it produces — a receipt for an order that rolled back, an order
   * with no receipt — are both unrecoverable after the fact.
   */
  readonly outbox?: boolean | undefined;
  /** `sqs`: the queue URL. One client may serve several connections. */
  readonly queueUrl?: string | undefined;
  /** `sqs`: FIFO queues keep order and refuse `DelaySeconds`. */
  readonly fifo?: boolean | undefined;
  readonly messageGroupId?: string | undefined;
  /**
   * Boot-validated even though it is not the default — the connection a `requires` block names,
   * or the one a cron drains.
   *
   * Without it, a `required` connection is only built on first use, so a production app whose
   * cron connection is `memory` boots cleanly and then throws at the first tick — at 3 a.m., in
   * a log nobody is watching, instead of refusing to start. The cache has the same flag with
   * the same meaning (`§ 2.2`: "refused in production on the _default_ connection and on
   * anything a `requires` block names").
   */
  readonly required?: boolean | undefined;
}

export interface QueueBindings {
  readonly databases?: Readonly<Record<string, QueueSql>> | undefined;
  /** For the `sync` driver: what runs a job inline. Normally the worker's own executor. */
  readonly executors?: Readonly<Record<string, SyncExecutor>> | undefined;
  /** For `cloudflare-queues`: the `[[queues.producers]]` binding, per connection. */
  readonly queues?: Readonly<Record<string, QueueProducerLike>> | undefined;
  /** For `sqs`: the client, per connection. */
  readonly sqs?: Readonly<Record<string, SqsLike>> | undefined;
  /** The SQL client behind a driver's dead-letter store, per connection (ADR-0027 § 1). */
  readonly deadLetters?: Readonly<Record<string, QueueSql>> | undefined;
}

export interface BuildQueuesOptions {
  readonly queue?:
    | {
        readonly default?: string | undefined;
        readonly connections?: Readonly<Record<string, ConfiguredConnection>> | undefined;
      }
    | undefined;
  readonly bindings?: QueueBindings | undefined;
  readonly jobs?: readonly JobDefinition<unknown>[] | undefined;
  readonly production?: boolean | undefined;
  readonly now?: (() => number) | undefined;
}

export interface Queues {
  readonly names: readonly string[];
  readonly default: string;
  readonly jobs: JobRegistry;
  connection(name?: string): Queue;
  /**
   * The worker for one connection, bound to the same registry and backend.
   *
   * `concurrency` and `batchSize` only — how the worker is *stopped* is the caller's business
   * (`drainOnce()` for `--once`, `stop()` for a signal), and an option here that only one caller
   * honours is an option that lies.
   */
  worker(
    name?: string,
    options?: { readonly concurrency?: number; readonly batchSize?: number },
  ): Worker;
  /** The backend, for `queue:failed`/`queue:retry` which work without jobs registered. */
  backend(name?: string): QueueBackend;
}

function driverFor(
  connection: string,
  definition: ConfiguredConnection,
  bindings: QueueBindings,
  now: (() => number) | undefined,
): QueueDriver<never> {
  switch (definition.driver) {
    case 'memory':
      return memoryQueueDriver(now === undefined ? {} : { now });
    case 'sync': {
      const execute = bindings.executors?.[connection];
      if (execute === undefined) {
        throw driverMissing(
          connection,
          'sync',
          `the "sync" driver needs an executor — pass \`bindings.executors.${connection}\``,
        );
      }
      return syncQueueDriver({ execute, ...(now === undefined ? {} : { now }) });
    }
    case 'database': {
      const name = definition.connection ?? 'default';
      const sql = bindings.databases?.[name];
      if (sql === undefined) {
        throw driverMissing(
          connection,
          'database',
          `no \`databases.${name}\` SQL client was supplied`,
        );
      }
      return databaseQueueDriver({
        sql,
        ...(definition.table === undefined ? {} : { table: definition.table }),
        ...(definition.deadTable === undefined ? {} : { deadTable: definition.deadTable }),
        ...(now === undefined ? {} : { now }),
      });
    }
    case 'cloudflare-queues': {
      const producer = bindings.queues?.[connection];
      if (producer === undefined) {
        throw driverMissing(
          connection,
          'cloudflare-queues',
          `no \`queues.${connection}\` producer binding was supplied — it is the \`QUEUES\` binding Cloudflare injects`,
        );
      }
      // The dead-letter store is optional and *declared*: without one the driver reports
      // `deadLetter: false`, and `queue:failed` says so rather than showing an empty list that
      // looks like "nothing failed".
      const sql = bindings.deadLetters?.[connection];
      return cloudflareQueuesDriver({
        producer,
        ...(sql === undefined ? {} : { sql }),
        ...(definition.deadTable === undefined ? {} : { deadTable: definition.deadTable }),
        ...(now === undefined ? {} : { now }),
      });
    }
    case 'sqs': {
      const client = bindings.sqs?.[connection];
      if (client === undefined) {
        throw driverMissing(
          connection,
          'sqs',
          `no \`sqs.${connection}\` client was supplied — pass the SDK client wrapped with \`sqsClientOf\``,
        );
      }
      if (definition.queueUrl === undefined) {
        throw driverMissing(
          connection,
          'sqs',
          `no \`queueUrl\` for connection "${connection}" — an SQS client without a queue URL is a client that cannot say which queue`,
        );
      }
      const sql = bindings.deadLetters?.[connection];
      return sqsDriver({
        client,
        queueUrl: definition.queueUrl,
        ...(definition.fifo === undefined ? {} : { fifo: definition.fifo }),
        ...(definition.messageGroupId === undefined
          ? {}
          : { messageGroupId: definition.messageGroupId }),
        ...(sql === undefined ? {} : { sql }),
        ...(definition.deadTable === undefined ? {} : { deadTable: definition.deadTable }),
        ...(now === undefined ? {} : { now }),
      });
    }
    default:
      throw driverMissing(
        connection,
        definition.driver,
        `expected one of ${QUEUE_DRIVERS.join(', ')}`,
      );
  }
}

export function createQueues(options: BuildQueuesOptions): Queues {
  const declared = options.queue?.connections ?? {};
  const names = Object.keys(declared);
  const jobs = createJobRegistry(options.jobs ?? []);

  const chosen = options.queue?.default ?? names[0];
  if (chosen === undefined) {
    throw unknownConnection('(none)', []);
  }
  if (!names.includes(chosen)) throw unknownConnection(chosen, names);

  const built = new Map<string, Queue>();
  const backends = new Map<string, QueueBackend>();
  const now = options.now;

  const ensure = (name: string): Queue => {
    const existing = built.get(name);
    if (existing !== undefined) return existing;

    const definition = declared[name];
    if (definition === undefined) throw unknownConnection(name, names);

    if (
      options.production === true &&
      (definition.driver === 'memory' || definition.driver === 'sync')
    ) {
      throw forbiddenInProduction(
        name,
        definition.driver,
        definition.driver === 'sync'
          ? 'the job would run inside the request that dispatched it, so a slow job becomes a slow request'
          : 'the queue would die with the process, losing every message between restarts',
      );
    }

    const driver = driverFor(name, definition, options.bindings ?? {}, now);
    // The outbox rule (`§ 4.2`) is a *correctness* rule, not a production guard: a broker
    // enqueue is a second, independent write, and losing that atomicity loses messages in
    // development too — quietly, which is worse. The outbox itself lives in `@tsir/events`
    // (it needs to know what a delivery is); this is the half the queue can check alone.
    if (!driver.capabilities.transactional && definition.outbox !== true) {
      throw outboxRequired(name, definition.driver);
    }

    const backend = driver.open();
    const queue = createQueue({
      connection: name,
      backend,
      jobs,
      connections: names,
      ...(now === undefined ? {} : { now }),
    });

    built.set(name, queue);
    backends.set(name, backend);
    return queue;
  };

  // The default connection is built eagerly — the same choice `createCaches` makes, for the
  // same reason: a production app whose default queue is `memory` must fail at boot, not at the
  // first dispatch, hours later, in a request. `required` extends that to the connections a
  // `requires` block or a cron names, because "validated at boot" is a promise about *those*
  // too. Every other connection stays lazy, so declaring one that is not used costs nothing.
  ensure(chosen);
  for (const name of names) {
    if (name !== chosen && declared[name]?.required === true) ensure(name);
  }

  return {
    names,
    default: chosen,
    jobs,
    connection: (name) => ensure(name ?? chosen),
    backend: (name) => {
      // Building the queue also builds the backend; both are memoised together.
      ensure(name ?? chosen);
      return backends.get(name ?? chosen) as QueueBackend;
    },
    worker: (name, workerOptions = {}) => {
      const connection = name ?? chosen;
      ensure(connection);
      return createWorker({
        connection,
        backend: backends.get(connection) as QueueBackend,
        jobs,
        ...(workerOptions.concurrency === undefined
          ? {}
          : { concurrency: workerOptions.concurrency }),
        ...(workerOptions.batchSize === undefined ? {} : { batchSize: workerOptions.batchSize }),
        ...(now === undefined ? {} : { now }),
      });
    },
  };
}
