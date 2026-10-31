/**
 * The queue façade (`§ 4.2`): dispatch by name, refuse what cannot be done.
 *
 * `createQueue` wraps one backend and one job registry. The interesting work is all
 * validation, and all of it is **at dispatch time**, because that is the moment a wrong name
 * becomes a lost job:
 *
 *   · a job that is not registered is `CAP_UNKNOWN_JOB` — never "queue it and hope a worker
 *     knows it";
 *   · a connection that was never declared is `CAP_UNKNOWN_CONNECTION` — never a quiet trip to
 *     the default queue (`§ 2.2`);
 *   · `dispatchLater` on a driver without `delay` is `CAP_UNSUPPORTED_OPERATION`, not a
 *     message that arrives immediately and surprises the caller.
 */

import { dispatchFailed, unknownConnection, unknownJob, unsupportedOperation } from './errors.ts';
import type {
  DispatchOptions,
  DispatchResult,
  JobLike,
  JobMessage,
  Queue,
  QueueBackend,
} from './port.ts';
import type { JobRegistry } from './job.ts';
import { JOB_DEFAULTS } from './job.ts';

export interface CreateQueueOptions {
  readonly connection: string;
  readonly backend: QueueBackend;
  readonly jobs: JobRegistry;
  /** Every connection name, so an unknown one is caught before the message exists. */
  readonly connections: readonly string[];
  /** Injected clock, so tests do not sleep. */
  readonly now?: (() => number) | undefined;
  /** Ids in tests, so an assertion can name the message it expects. */
  readonly newId?: (() => string) | undefined;
}

export function createQueue(options: CreateQueueOptions): Queue {
  const now = options.now ?? ((): number => Date.now());
  const newId = options.newId ?? ((): string => crypto.randomUUID());
  const { backend, jobs } = options;

  const resolveConnection = (requested: string | undefined): string => {
    const name = requested ?? options.connection;
    if (!options.connections.includes(name)) throw unknownConnection(name, options.connections);
    if (name !== options.connection) {
      // A job may prefer another connection, but a queue instance speaks for one backend.
      throw unknownConnection(name, [options.connection]);
    }
    return name;
  };

  const build = (
    job: JobLike<unknown>,
    payload: unknown,
    dispatchOptions: DispatchOptions,
  ): JobMessage => {
    const definition = jobs.get(job.name);
    if (definition === undefined) throw unknownJob(job.name, jobs.names);

    const connection = resolveConnection(dispatchOptions.connection ?? job.connection);

    if (
      dispatchOptions.delayMs !== undefined &&
      dispatchOptions.delayMs > 0 &&
      !backend.capabilities.delay
    ) {
      throw unsupportedOperation(
        connection,
        backend.name,
        'a delayed dispatch',
        'this driver has no delay support; dispatch now and let the handler decide, or use a driver with `delay`',
      );
    }

    const at = now();
    return {
      id: newId(),
      name: job.name,
      payload: JSON.stringify(payload),
      connection,
      attempts: 0,
      maxAttempts:
        dispatchOptions.maxAttempts ?? definition.maxAttempts ?? JOB_DEFAULTS.maxAttempts,
      availableAt: at + (dispatchOptions.delayMs ?? 0),
      createdAt: at,
      ...(dispatchOptions.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: dispatchOptions.idempotencyKey }),
    };
  };

  const push = async (message: JobMessage): Promise<DispatchResult> => {
    try {
      await backend.push(message);
    } catch (error: unknown) {
      throw dispatchFailed(
        message.connection,
        message.name,
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      id: message.id,
      connection: message.connection,
      name: message.name,
      accepted: true,
    };
  };

  const queue: Queue = {
    connection: options.connection,
    driver: backend.name,
    capabilities: backend.capabilities,

    async dispatch(job, payload, dispatchOptions = {}) {
      return push(build(job, payload, dispatchOptions));
    },

    async dispatchMany(messages) {
      const results: DispatchResult[] = [];
      for (const message of messages) {
        results.push(await push(build(message.job, message.payload, message.options ?? {})));
      }
      return results;
    },

    async dispatchLater(job, payload, dispatchOptions) {
      if (dispatchOptions.delayMs < 0) {
        throw new RangeError('queue: delayMs must not be negative');
      }
      return push(build(job, payload, dispatchOptions));
    },

    async cancel(id) {
      if (!backend.capabilities.cancel) {
        throw unsupportedOperation(options.connection, backend.name, 'cancel');
      }
      // Cancelling is replay's inverse: remove it from wherever it is.
      return backend.discard(id);
    },

    size: () => backend.size(),
    dead: (limit = 50) => backend.dead(limit),
    retry: (id) => backend.replay(id, now()),
    discard: (id) => backend.discard(id),
    purge: () => backend.purge(),
  };

  return queue;
}
