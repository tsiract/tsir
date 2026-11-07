/**
 * One-call events (and optional queue) bootstrap for apps that use `@tsir/events`.
 *
 * Replaces the hand-written `modules/system/services/events.ts` every app
 * previously needed. Because queued listeners become jobs, and the queue must
 * register those jobs before a dispatch can succeed, the events bus and the
 * queue are co-built here:
 *
 *   1. `createEvents({ listeners })` — no queue, just to collect `jobs()`.
 *   2. `createQueueBootstrap({ queue, jobs: [...appJobs, ...events.jobs()] })`.
 *   3. `createEvents({ listeners, queue })` — the real bus, bound to the queue.
 *
 * If no `queue` config is supplied, the bus is sync-only and no queue is built.
 */

import { token, valueProvider, type Provider, type Token } from '@tsir/container';
import { createQueueBootstrap, type QueueBootstrapOptions } from '@tsir/queue';

import { createEvents, type Events } from './bus.ts';
import type { ListenerDefinition } from './event.ts';

/** Options for `createEventsBootstrap`. */
export interface EventsBootstrapOptions {
  /** The app's listener definitions. */
  readonly listeners: readonly ListenerDefinition<unknown>[];
  /** Optional queue config — when supplied, the queue is co-built and bound. */
  readonly queue?: QueueBootstrapOptions['queue'];
  /** Bindings for the queue drivers. */
  readonly queueBindings?: QueueBootstrapOptions['bindings'];
  /** The app's own job definitions (added to the queue alongside listener jobs). */
  readonly jobs?: QueueBootstrapOptions['jobs'];
  /** Refuse ephemeral defaults in production. */
  readonly production?: boolean;
  /** Where delivery-time logs go. Defaults to discarding them. */
  readonly log?: (message: string) => void;
  readonly now?: (() => number) | undefined;
}

/** Everything an app needs to wire its events (and queue) layer. */
export interface EventsBootstrap {
  /** The event bus. */
  readonly events: Events;
  /** DI token for `events`. */
  readonly eventsToken: Token<Events>;
  /** Value provider for `events`. */
  readonly eventsProvider: Provider<Events>;
  /** The queues registry (undefined when no `queue` config was supplied). */
  readonly queues: ReturnType<typeof createQueueBootstrap>['queues'] | undefined;
  /** The default queue connection (undefined when no `queue` config was supplied). */
  readonly queue: ReturnType<typeof createQueueBootstrap>['queue'] | undefined;
  /** DI token for `queues`. */
  readonly queuesToken: ReturnType<typeof createQueueBootstrap>['queuesToken'] | undefined;
  /** DI token for `queue`. */
  readonly queueToken: ReturnType<typeof createQueueBootstrap>['queueToken'] | undefined;
  /** Value provider for `queues`. */
  readonly queuesProvider: ReturnType<typeof createQueueBootstrap>['queuesProvider'] | undefined;
  /** Value provider for `queue`. */
  readonly queueProvider: ReturnType<typeof createQueueBootstrap>['queueProvider'] | undefined;
}

/**
 * Build the events layer (and optionally the queue) from listener definitions.
 *
 * ```ts
 * import { createEventsBootstrap } from '@tsir/events';
 * import { databases } from '../../database.ts';
 * import queueConfig from '../../config/queue.ts';
 * import { SendWelcomeEmailListener } from './listeners/send-welcome-email.listener.ts';
 *
 * export const { events, eventsToken, eventsProvider, queues, queue, queuesToken, queueToken, queuesProvider, queueProvider } =
 *   createEventsBootstrap({
 *     listeners: [SendWelcomeEmailListener],
 *     queue: queueConfig,
 *     queueBindings: { databases: { primary: databases.defaultDatabase } },
 *   });
 * ```
 */
export function createEventsBootstrap(options: EventsBootstrapOptions): EventsBootstrap {
  // Step 1: build events without a queue to collect the queued listeners' jobs.
  const eventsForJobs = createEvents({
    listeners: options.listeners,
    log: options.log,
    now: options.now,
  });

  // Step 2: if a queue is configured, build it with both app jobs and listener jobs.
  let queues: EventsBootstrap['queues'];
  let queue: EventsBootstrap['queue'];
  let queuesToken: EventsBootstrap['queuesToken'];
  let queueToken: EventsBootstrap['queueToken'];
  let queuesProvider: EventsBootstrap['queuesProvider'];
  let queueProvider: EventsBootstrap['queueProvider'];

  if (options.queue !== undefined) {
    const queueBootstrap = createQueueBootstrap({
      queue: options.queue,
      bindings: options.queueBindings,
      jobs: [...(options.jobs ?? []), ...eventsForJobs.jobs()],
      ...(options.production === undefined ? {} : { production: options.production }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    queues = queueBootstrap.queues;
    queue = queueBootstrap.queue;
    queuesToken = queueBootstrap.queuesToken;
    queueToken = queueBootstrap.queueToken;
    queuesProvider = queueBootstrap.queuesProvider;
    queueProvider = queueBootstrap.queueProvider;
  }

  // Step 3: build the real events bus, bound to the queue (if any).
  const events = createEvents({
    listeners: options.listeners,
    queue,
    log: options.log,
    now: options.now,
  });

  const eventsToken = token<Events>('events');
  const eventsProvider = valueProvider(eventsToken, events);

  return {
    events,
    eventsToken,
    eventsProvider,
    queues,
    queue,
    queuesToken,
    queueToken,
    queuesProvider,
    queueProvider,
  };
}
