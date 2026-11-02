import { defineApp } from '@tsir/core';
import { defineConfig, env } from '@tsir/config';
import { createFetchHandler } from '@tsir/http';
import { createEvents, type ListenerDefinition } from '@tsir/events';
import {
  createJobRegistry,
  createQueue,
  createWorker,
  type Queues,
} from '@tsir/queue';
import { memoryQueueDriver } from '@tsir/queue/memory';

import { orders } from './orders/index.ts';
import { routes } from './routes.gen.ts';
import { SendReceiptJob } from './orders/queues/send-receipt.job.ts';
import { OrderPlacedEvent } from './orders/events/order-placed.event.ts';
import { NotifyWarehouseListener } from './orders/listeners/notify-warehouse.listener.ts';

export const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
  APP_NAME: env.string({ default: 'full-actions-example' }),
});

export default defineApp({
  name: 'full-actions-example',
  config: spec,
  modules: [orders.module],
});

/**
 * The job registry. Every job the app can run is declared here so the worker
 * can look it up by name and `tsir queue:failed` can print a human label.
 *
 * Event listeners declared `mode: 'queued'` run as jobs too — the events bus
 * names them `event:<event.name>:<listener>`. We collect them from a throwaway
 * `createEvents` call before building the registry, because the registry is
 * immutable and the queue needs it before the real bus can dispatch.
 */
const listeners: readonly ListenerDefinition<unknown>[] = [NotifyWarehouseListener];
const eventJobs = createEvents({ listeners }).jobs();

export const jobs = [SendReceiptJob, ...eventJobs];
const jobRegistry = createJobRegistry(jobs);

/**
 * The queue. In development and tests the `memory` driver keeps everything in
 * process. For production, swap `memoryQueueDriver()` for `sqsDriver()` and
 * supply an SQS client in `QueueBindings.sqs` (see `tsir queue:table` for the
 * outbox DDL that a non-transactional broker requires).
 */
const backend = memoryQueueDriver().open();
const connection = 'default';

export const queues: Queues = {
  names: [connection],
  default: connection,
  jobs: jobRegistry,
  connection: (name) =>
    createQueue({
      connection: name ?? connection,
      backend,
      jobs: jobRegistry,
      connections: [connection],
    }),
  backend: () => backend,
  worker: (name, options) =>
    createWorker({
      connection: name ?? connection,
      backend,
      jobs: jobRegistry,
      pollMs: 50,
      ...(options?.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options?.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    }),
};

/**
 * The event bus. `OrderPlaced` is a `queued` event, so its listeners run as
 * jobs on the queue above. SNS and EventBridge are not separate buses here:
 * a `queued` event is delivered through the queue, and the queue's driver
 * (SQS in production) is what crosses the process boundary. To fan out to
 * SNS or EventBridge, add a listener that publishes to that broker — the
 * event contract (`order.placed`) stays the same.
 */
export const events = createEvents({
  listeners,
  queue: queues.connection(),
});

/** What a Worker/Lambda adapter exports: a plain fetch handler, no globals. */
export const handler = createFetchHandler({ routes });
