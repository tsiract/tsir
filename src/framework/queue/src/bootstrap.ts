/**
 * One-call queue bootstrap for apps that use `@tsir/queue`.
 *
 * Replaces the hand-written queue setup every app previously needed: it builds
 * the named connections from `config/queue.ts`, registers the app's jobs, and
 * exposes the `queues` registry + default `queue` connection with their DI
 * tokens and value providers.
 */

import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { createQueues, type BuildQueuesOptions, type Queues } from './config.ts';
import type { Queue } from './port.ts';
import type { JobDefinition } from './job.ts';

/** Options for `createQueueBootstrap`. */
export interface QueueBootstrapOptions {
  /** The app's queue configuration (the `queue` field of `BuildQueuesOptions`). */
  readonly queue: BuildQueuesOptions['queue'];
  /** Bindings for drivers that need a backend (database, cloudflare-queues, sqs). */
  readonly bindings?: BuildQueuesOptions['bindings'];
  /** Job definitions to register. */
  readonly jobs?: readonly JobDefinition<unknown>[];
  /** Refuse ephemeral defaults in production. */
  readonly production?: boolean;
  readonly now?: BuildQueuesOptions['now'];
}

/** Everything an app needs to wire its queue layer. */
export interface QueueBootstrap {
  /** The named queue connections registry. */
  readonly queues: Queues;
  /** The default queue connection. */
  readonly queue: Queue;
  /** DI token for `queues`. */
  readonly queuesToken: Token<Queues>;
  /** DI token for `queue`. */
  readonly queueToken: Token<Queue>;
  /** Value provider for `queues`. */
  readonly queuesProvider: Provider<Queues>;
  /** Value provider for `queue`. */
  readonly queueProvider: Provider<Queue>;
}

/**
 * Build the queue layer from `config/queue.ts`.
 *
 * ```ts
 * import { createQueueBootstrap } from '@tsir/queue';
 * import { databases } from '../../database.ts';
 * import config from '../../config/queue.ts';
 * import { SendWelcomeEmailJob } from './jobs/send-welcome-email.job.ts';
 *
 * export const { queues, queue, queuesToken, queueToken, queuesProvider, queueProvider } =
 *   createQueueBootstrap({
 *     queue: config,
 *     bindings: { databases: { primary: databases.defaultDatabase } },
 *     jobs: [SendWelcomeEmailJob],
 *   });
 * ```
 */
export function createQueueBootstrap(options: QueueBootstrapOptions): QueueBootstrap {
  const queues = createQueues({
    queue: options.queue,
    bindings: options.bindings,
    jobs: options.jobs,
    production: options.production,
    now: options.now,
  });

  const queue = queues.connection();

  const queuesToken = token<Queues>('queues');
  const queueToken = token<Queue>('queue');
  const queuesProvider = valueProvider(queuesToken, queues);
  const queueProvider = valueProvider(queueToken, queue);

  return { queues, queue, queuesToken, queueToken, queuesProvider, queueProvider };
}
