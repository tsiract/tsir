/**
 * The `memory` driver: a queue in a `Map`, for tests and for a single-process dev server.
 *
 * It exists because the *worker* needs a backend to be tested against, and because
 * `make dev` should not require Postgres to try a dispatch. It is honest about what it is:
 * `persistent: false`, so it is refused as a production default exactly like the cache's
 * memory driver.
 *
 * It implements the whole port correctly — leases, delayed dispatch, dead letters, replay —
 * because a fake that only does the happy path teaches the worker the wrong habits.
 */

import type { JobMessage, QueueBackend, QueueCapabilities, QueueDriver } from '../port.ts';

export const MEMORY_QUEUE_CAPABILITIES = {
  transactional: true,
  delay: true,
  cancel: true,
  persistent: false,
  ordered: true,
  deadLetter: true,
  // A `seen` set here, a partial unique index on `database`: the store enforces it.
  idempotency: true,
} as const satisfies QueueCapabilities;

interface Held {
  message: JobMessage;
  /** Epoch ms until which another worker must not see it. `0` = free. */
  leasedUntil: number;
}

export interface MemoryQueueOptions {
  readonly now?: (() => number) | undefined;
}

export function memoryQueueDriver(options: MemoryQueueOptions = {}): QueueDriver<never> {
  return {
    name: 'memory',
    capabilities: MEMORY_QUEUE_CAPABILITIES,
    open(): QueueBackend {
      const pending = new Map<string, Held>();
      const dead = new Map<string, JobMessage>();
      const seen = new Set<string>();
      const now = options.now ?? ((): number => Date.now());

      // A message is *addressed*: `connection` is part of its identity, not a label. A driver
      // that ignored it would hand one connection's work to another's worker, which is the
      // quietest possible version of the wrong job running in the wrong place.
      const due = (connection: string, clock: number): Held[] =>
        [...pending.values()]
          .filter((held) => held.message.connection === connection)
          .filter((held) => held.message.availableAt <= clock && held.leasedUntil <= clock)
          .sort(
            (a, b) =>
              a.message.availableAt - b.message.availableAt ||
              a.message.createdAt - b.message.createdAt,
          );

      const backend: QueueBackend = {
        name: 'memory',
        capabilities: MEMORY_QUEUE_CAPABILITIES,
        now,

        async push(message) {
          if (message.idempotencyKey !== undefined) {
            if (seen.has(message.idempotencyKey)) return;
            seen.add(message.idempotencyKey);
          }
          pending.set(message.id, { message, leasedUntil: 0 });
        },

        async reserve({ connection, limit, now: clock, leaseMs }) {
          const claimed: JobMessage[] = [];
          for (const held of due(connection, clock)) {
            if (claimed.length >= limit) break;
            held.leasedUntil = clock + leaseMs;
            // The attempt is counted here, on the stored message, so an abandoned lease that
            // comes back reports the attempt after this one — not the same number again.
            const next: JobMessage = { ...held.message, attempts: held.message.attempts + 1 };
            held.message = next;
            claimed.push(next);
          }
          return claimed;
        },

        async complete(message) {
          pending.delete(message.id);
        },

        async fail(message, { error, retryAt }) {
          const held = pending.get(message.id);
          if (held === undefined) return;

          if (retryAt === undefined) {
            pending.delete(message.id);
            dead.set(message.id, { ...held.message, attempts: message.attempts, lastError: error });
            return;
          }

          const next: Held = {
            message: {
              ...held.message,
              attempts: message.attempts,
              availableAt: retryAt,
              lastError: error,
            },
            leasedUntil: 0,
          };
          pending.set(message.id, next);
        },

        async dead(limit) {
          return [...dead.values()].slice(0, limit);
        },

        async replay(id, clock) {
          const message = dead.get(id);
          if (message === undefined) return false;
          dead.delete(id);
          // A replay is a fresh budget *and* a clean slate: the old error belongs to the run
          // that was abandoned, and carrying it forward makes the next listing lie. Written out
          // field by field rather than by spreading `message`, so `lastError` cannot sneak back.
          pending.set(id, {
            message: {
              id: message.id,
              name: message.name,
              payload: message.payload,
              connection: message.connection,
              attempts: 0,
              maxAttempts: message.maxAttempts,
              availableAt: clock,
              createdAt: message.createdAt,
              ...(message.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: message.idempotencyKey }),
            },
            leasedUntil: 0,
          });
          return true;
        },

        async discard(id) {
          const had = dead.delete(id) || pending.delete(id);
          return had;
        },

        async size() {
          return pending.size;
        },

        async purge() {
          pending.clear();
          dead.clear();
          seen.clear();
        },
      };

      return backend;
    },
  };
}

export const memoryQueueCapabilities = MEMORY_QUEUE_CAPABILITIES;
