/**
 * The `sync` driver (`§ 4.2`): the job runs inside `dispatch`.
 *
 * Its purpose is tests and `make dev` — a dispatch that has already happened when the call
 * returns, so a test can assert on its effects without polling. It is therefore
 * `persistent: false` and has **no trigger**: `queue:work` on a sync connection has nothing to
 * reserve, which is the honest answer rather than a worker that exits immediately and looks
 * broken.
 *
 * Retries are inline and immediate (no backoff delay — there is nowhere to wait). Exhausted
 * attempts land in a dead-letter store that lives as long as the process, so `queue:failed`
 * and `queue:retry` behave the same way they do for a durable driver.
 *
 * A production guard refuses it: an at-most-once-nowhere queue in production is a job that
 * runs inside a request and takes the request down with it.
 */

import type { JobMessage, QueueBackend, QueueCapabilities, QueueDriver } from '../port.ts';

export const SYNC_QUEUE_CAPABILITIES = {
  transactional: true,
  delay: false,
  cancel: false,
  persistent: false,
  ordered: true,
  deadLetter: true,
  // Nothing is stored, so nothing can dedupe: the work already ran inside `dispatch`.
  idempotency: false,
} as const satisfies QueueCapabilities;

/** Runs one message. Supplied by the caller so this driver does not depend on the worker. */
export interface SyncExecutor {
  (message: JobMessage): Promise<void>;
}

export interface SyncQueueOptions {
  /** Required: a sync queue with nothing to run it is a black hole. */
  readonly execute: SyncExecutor;
  readonly now?: (() => number) | undefined;
  /** Called after each attempt; the seam tests and logs use. */
  readonly onResult?:
    | ((input: {
        readonly message: JobMessage;
        readonly attempt: number;
        readonly error?: string;
      }) => void)
    | undefined;
}

export function syncQueueDriver(options: SyncQueueOptions): QueueDriver<never> {
  return {
    name: 'sync',
    capabilities: SYNC_QUEUE_CAPABILITIES,
    open(): QueueBackend {
      const dead = new Map<string, JobMessage>();
      const now = options.now ?? ((): number => Date.now());

      const backend: QueueBackend = {
        name: 'sync',
        capabilities: SYNC_QUEUE_CAPABILITIES,
        now,

        async push(message) {
          // Attempts run here, in order, until one succeeds or the budget is spent.
          for (let attempt = 1; attempt <= message.maxAttempts; attempt += 1) {
            try {
              await options.execute({ ...message, attempts: attempt - 1 });
              options.onResult?.({ message, attempt });
              return;
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error);
              options.onResult?.({ message, attempt, error: detail });
              if (attempt >= message.maxAttempts) {
                dead.set(message.id, { ...message, attempts: attempt, lastError: detail });
                return;
              }
            }
          }
        },

        // Nothing is ever stored, so nothing can be reserved: `queue:work` is a no-op here.
        reserve: () => Promise.resolve([]),
        complete: () => Promise.resolve(),
        fail: (message, { error }) => {
          dead.set(message.id, { ...message, lastError: error });
          return Promise.resolve();
        },

        dead: (limit) => Promise.resolve([...dead.values()].slice(0, limit)),

        async replay(id) {
          const message = dead.get(id);
          if (message === undefined) return false;
          dead.delete(id);
          await backend.push({ ...message, attempts: 0 });
          return true;
        },

        discard: (id) => Promise.resolve(dead.delete(id)),
        size: () => Promise.resolve(0),
        purge: () => {
          dead.clear();
          return Promise.resolve();
        },
      };

      return backend;
    },
  };
}

export const syncQueueCapabilities = SYNC_QUEUE_CAPABILITIES;
