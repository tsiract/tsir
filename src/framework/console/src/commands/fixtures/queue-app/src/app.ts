// The queue fixture (`CAP-004`): a job that succeeds, a job that fails, and a broker that
// survives the process so `queue:work`, `queue:failed` and `queue:retry` can be tested the way
// they actually run — one process each, sharing one store.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineApp } from '@tsir/core';
import { defineConfig } from '@tsir/config';
import { createJobRegistry, createQueue, createWorker, defineJob, type Queues } from '@tsir/queue';

import { fileQueueBackend } from './file-backend.ts';

export const spec = defineConfig({});

export default defineApp({
  name: 'queue-app',
  config: spec,
  modules: [],
});

/** Succeeds, and records that it did — the file is how a test sees the handler really ran. */
export const SendReceipt = defineJob<{ orderId: string; fail?: boolean }>({
  name: 'SendReceipt',
  maxAttempts: 1,
  backoff: { baseMs: 1, jitter: 0 },
  timeoutMs: 5_000,
  handle({ payload }) {
    if (payload.fail === true) throw new Error(`could not send receipt for ${payload.orderId}`);
    appendFileSync(join(process.cwd(), '.sent.log'), `${payload.orderId}\n`, 'utf8');
  },
});

export const jobs = [SendReceipt];

const registry = createJobRegistry(jobs);
const backend = fileQueueBackend();
const connection = 'default';

export const queues: Queues = {
  names: [connection],
  default: connection,
  jobs: registry,
  connection: (name) =>
    createQueue({
      connection: name ?? connection,
      backend,
      jobs: registry,
      connections: [connection],
    }),
  backend: () => backend,
  worker: (name, options) =>
    createWorker({
      connection: name ?? connection,
      backend,
      jobs: registry,
      pollMs: 5,
      ...(options?.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options?.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    }),
};

export const handler = (): Response => new Response('ok');
