/**
 * A `QueueBackend` in a JSON file, for this fixture only.
 *
 * The fixture exists so `tsir queue:work|failed|retry` can be tested as **separate processes**,
 * which is how they run in anger. `memory` cannot do that (the messages die with the process
 * that dispatched them) and `database` would need a real Postgres in a unit test, so the fixture
 * carries the smallest honest broker: one file, one lock-free write, at-least-once delivery.
 *
 * It is deliberately not part of `@tsir/queue`. A file is not a transaction with the business
 * write, there is no lease renewal, and two workers would race on the last write — which is why
 * `transactional: false` is declared below and why nobody should ship it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JobMessage, QueueBackend, QueueCapabilities } from '@tsir/queue';

const STATE = join(process.cwd(), '.queue-state.json');

interface Held {
  readonly message: JobMessage;
  readonly leasedUntil: number;
}

interface State {
  readonly pending: Held[];
  readonly dead: JobMessage[];
}

const EMPTY: State = { pending: [], dead: [] };

function read(): State {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8')) as State;
  } catch {
    return { pending: [...EMPTY.pending], dead: [...EMPTY.dead] };
  }
}

function write(state: State): void {
  writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8');
}

export const FILE_QUEUE_CAPABILITIES = {
  // A file is not a transaction with the row that caused the job: the outbox is mandatory.
  transactional: false,
  delay: true,
  cancel: true,
  persistent: true,
  ordered: true,
  deadLetter: true,
  // One file, no index: a duplicate key is two messages, same as any broker without dedupe.
  idempotency: false,
} as const satisfies QueueCapabilities;

export function fileQueueBackend(now: () => number = Date.now): QueueBackend {
  const backend: QueueBackend = {
    name: 'file',
    capabilities: FILE_QUEUE_CAPABILITIES,
    now,

    push(message) {
      const state = read();
      state.pending.push({ message, leasedUntil: 0 });
      write(state);
      return Promise.resolve();
    },

    reserve({ connection, limit, now: clock, leaseMs }) {
      const state = read();
      const claimed: JobMessage[] = [];
      const pending: Held[] = [];

      for (const held of state.pending) {
        const due =
          held.message.connection === connection &&
          held.message.availableAt <= clock &&
          held.leasedUntil <= clock;

        if (due && claimed.length < limit) {
          const message: JobMessage = { ...held.message, attempts: held.message.attempts + 1 };
          pending.push({ message, leasedUntil: clock + leaseMs });
          claimed.push(message);
          continue;
        }
        pending.push(held);
      }

      write({ ...state, pending });
      return Promise.resolve(claimed);
    },

    complete(message) {
      const state = read();
      write({ ...state, pending: state.pending.filter((held) => held.message.id !== message.id) });
      return Promise.resolve();
    },

    fail(message, { error, retryAt }) {
      const state = read();
      if (retryAt === undefined) {
        const held = state.pending.find((entry) => entry.message.id === message.id);
        write({
          pending: state.pending.filter((entry) => entry.message.id !== message.id),
          dead: [
            ...state.dead,
            { ...(held?.message ?? message), attempts: message.attempts, lastError: error },
          ],
        });
        return Promise.resolve();
      }

      write({
        ...state,
        pending: state.pending.map((held) =>
          held.message.id === message.id
            ? {
                message: {
                  ...held.message,
                  attempts: message.attempts,
                  availableAt: retryAt,
                  lastError: error,
                },
                leasedUntil: 0,
              }
            : held,
        ),
      });
      return Promise.resolve();
    },

    dead(limit) {
      return Promise.resolve(read().dead.slice(0, limit));
    },

    replay(id, clock) {
      const state = read();
      const message = state.dead.find((entry) => entry.id === id);
      if (message === undefined) return Promise.resolve(false);

      write({
        pending: [
          ...state.pending,
          {
            message: {
              id: message.id,
              name: message.name,
              payload: message.payload,
              connection: message.connection,
              attempts: 0,
              maxAttempts: message.maxAttempts,
              availableAt: clock,
              createdAt: message.createdAt,
            },
            leasedUntil: 0,
          },
        ],
        dead: state.dead.filter((entry) => entry.id !== id),
      });
      return Promise.resolve(true);
    },

    discard(id) {
      const state = read();
      const had =
        state.dead.some((entry) => entry.id === id) ||
        state.pending.some((held) => held.message.id === id);
      write({
        pending: state.pending.filter((held) => held.message.id !== id),
        dead: state.dead.filter((entry) => entry.id !== id),
      });
      return Promise.resolve(had);
    },

    size() {
      return Promise.resolve(read().pending.length);
    },

    purge() {
      write({ pending: [], dead: [] });
      return Promise.resolve();
    },
  };

  return backend;
}
