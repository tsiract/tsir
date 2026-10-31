/**
 * Publishing through the outbox (`§ 4.5`): the durable path.
 *
 * ```ts
 * await db.batch([
 *   db.insert(orders).values(order),
 *   publisher.record(OrderPlaced, { orderId }),      // one row per `queued` listener
 * ]);
 * await publisher.relay();                           // …and only then does anything run
 * ```
 *
 * The two halves exist because they answer different questions. `record` answers "did this
 * commit with my write?" — it must be in the caller's batch, and it is why this package exists
 * at all. `relay` answers "has it been sent yet?" — it is idempotent, it is at-least-once, and it
 * can run from a cron, a `scheduled` handler or a worker tick, because none of those change what
 * happens if it runs twice.
 *
 * **Every listener on an outboxed event must be `queued`.** A `sync` listener runs inside the
 * caller's flow; by the time the relay runs, that flow is over, so "inline" would mean "inline
 * with nothing". Rather than silently run it at relay time — which is a queued listener with
 * extra steps and a misleading name — `record` refuses (`CAP_EVENTS_SYNC_OUTBOXED`).
 */

import type { JobMessage } from '@tsir/queue';

import { deliveryMessage, type Events, type EventsQueue } from './bus.ts';
import { outboxWriteFailed, syncListenerOutboxed, unknownEvent } from './errors.ts';
import { modeOf, type DeliveryEnvelope, type EventDefinition } from './event.ts';
import type { Outbox, OutboxEntry } from './outbox.ts';

export interface CreatePublisherOptions {
  readonly events: Events;
  readonly outbox: Outbox;
  /** The queue the relay publishes through; its connection is the default for a delivery. */
  readonly queue: EventsQueue;
  readonly now?: (() => number) | undefined;
  readonly newId?: (() => string) | undefined;
}

/** The statement a caller's batch collects: `(sql, params) => void`. */
export type BatchStatement = (sql: string, params: readonly unknown[]) => unknown;

export interface Publisher {
  /**
   * Record every `queued` delivery for one event. Returns the delivery ids, in declaration order.
   *
   * Pass `statement` to join the caller's `batch()`. Without it the row is written on the
   * outbox's own connection — correct for a background job that publishes outside a
   * transaction, wrong for anything that must be atomic with a business row.
   */
  record<Payload>(
    event: EventDefinition<Payload>,
    payload: Payload,
    statement?: BatchStatement,
  ): Promise<readonly string[]>;
  /** Publish what committed. Returns how many messages were handed to the queue. */
  relay(limit?: number): Promise<number>;
  /** Unpublished deliveries, oldest first — what `relay` would send. */
  pending(limit?: number): Promise<readonly OutboxEntry[]>;
  /** How many deliveries are waiting to be relayed. */
  size(): Promise<number>;
}

export function createPublisher(options: CreatePublisherOptions): Publisher {
  const now = options.now ?? ((): number => Date.now());
  const newId = options.newId ?? ((): string => crypto.randomUUID());
  const { outbox, queue, events } = options;

  /** The listeners of an event, validated: one `sync` listener makes the whole event unfittable. */
  const queuedListenersOf = (event: EventDefinition<unknown>) => {
    // An undeclared event is a refusal, not an empty fan-out: "nobody listened" and "you misspelt
    // the event" must not look the same in a log.
    if (!events.names.includes(event.name)) throw unknownEvent(event.name, events.names);

    const definitions = events.definitionsOf(event);
    for (const definition of definitions) {
      if (modeOf(definition) === 'sync') {
        throw syncListenerOutboxed(event.name, definition.name);
      }
    }
    return definitions;
  };

  return {
    async record(event, payload, statement) {
      const listeners = queuedListenersOf(event);
      if (listeners.length === 0) return [];

      const dispatchId = newId();
      const occurredAt = now();
      const ids: string[] = [];

      for (const listener of listeners) {
        const envelope: DeliveryEnvelope = {
          event: event.name,
          listener: listener.name,
          payload,
          occurredAt,
          dispatchId,
        };
        const message: JobMessage = deliveryMessage({
          listener,
          envelope,
          connection: queue.connection,
          at: occurredAt,
        });

        try {
          await outbox.record(message, statement);
        } catch (error: unknown) {
          throw outboxWriteFailed(
            event.name,
            error instanceof Error ? error.message : String(error),
          );
        }
        ids.push(message.id);
      }

      return ids;
    },

    relay(limit = 100) {
      // The relay is the queue's own outbox relay: it dispatches by job name, keeps the row id
      // as the idempotency key and marks each row individually. Nothing about events changes
      // that, which is why there is no second implementation of it.
      return outbox.relay(queue, limit);
    },

    pending(limit) {
      return limit === undefined ? outbox.pending() : outbox.pending(limit);
    },

    size() {
      return outbox.size();
    },
  };
}
