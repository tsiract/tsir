/**
 * The bus (`§ 4.5`): one registry of listeners, and two ways to deliver to them.
 *
 * ```
 *   events.dispatch(OrderPlaced, payload)      ── sync listeners inline, queued listeners as jobs
 *
 *   publisher.record(OrderPlaced, payload)     ── queued listeners into the caller's batch
 *   publisher.relay()                          ── …published after the commit
 * ```
 *
 * `dispatch` is the honest fast path: it runs `sync` listeners and dispatches `queued` ones to
 * the queue, and it is *correct* exactly when a lost enqueue is acceptable — a transactional
 * driver (`database`), a development `memory`/`sync` connection, or work whose absence costs
 * nothing. `publisher.record` is the durable path, and the one a non-transactional broker
 * requires (`§ 4.2`).
 *
 * Two orderings are deliberate:
 *
 *   · **Sync listeners run first, and their failure stops everything.** A queued dispatch is a
 *     second write; doing it after an inline listener threw is how a receipt job outlives the
 *     rollback that killed its order.
 *   · **One dispatch id, one delivery id.** The envelope carries the dispatch id, and each
 *     listener's delivery key is `${dispatchId}:${listener}` — sharing one key across listeners
 *     of the same event would make a backend with real idempotency drop all but the first.
 */

import { JOB_DEFAULTS, defineJob } from '@tsir/queue';
import type { DispatchOptions, JobContext, JobDefinition, JobMessage, Queue } from '@tsir/queue';

import { eventFailed, noQueueForListener, unknownEvent } from './errors.ts';
import {
  deliveryJobName,
  modeOf,
  type DeliveryEnvelope,
  type EventContext,
  type EventDefinition,
  type ListenerDefinition,
} from './event.ts';

/** The queue slice the bus needs: dispatch, and the name of the connection it is on. */
export type EventsQueue = Pick<Queue, 'connection' | 'dispatch'>;

export interface CreateEventsOptions {
  /** `unknown` rather than `never`: a concrete `ListenerDefinition<OrderPlaced>` must fit. */
  readonly listeners: readonly ListenerDefinition<unknown>[];
  /** Required only if any listener is `queued`; a sync-only bus is a legitimate shape. */
  readonly queue?: EventsQueue | undefined;
  readonly now?: (() => number) | undefined;
  /** Delivery ids, injectable so a test can name the delivery it expects. */
  readonly newId?: (() => string) | undefined;
  /** Where `deliver`-time logs go. Defaults to discarding them: a library does not own stdout. */
  readonly log?: ((message: string) => void) | undefined;
}

export interface DispatchReport {
  readonly id: string;
  /** Listeners that ran before `dispatch` returned. */
  readonly sync: readonly string[];
  /** Listeners handed to the queue, with the id each delivery was dispatched under. */
  readonly queued: readonly { readonly listener: string; readonly id: string }[];
}

export interface DispatchContextOptions {
  /** Reuse a known id — a request id, an outbox row — instead of generating one. */
  readonly id?: string | undefined;
  readonly occurredAt?: number | undefined;
}

export interface Events {
  /** Every declared event name, sorted. */
  readonly names: readonly string[];
  /** The listener names declared for one event, in declaration order. */
  listenersOf(event: EventDefinition<unknown>): readonly string[];
  /** The declarations themselves — what the publisher needs to know each one's mode. */
  definitionsOf(event: EventDefinition<unknown>): readonly ListenerDefinition<unknown>[];
  /**
   * Deliver now: `sync` listeners inline, `queued` listeners as jobs.
   *
   * Not atomic with anything the caller is writing — use a publisher for that.
   */
  dispatch<Payload>(
    event: EventDefinition<Payload>,
    payload: NoInfer<Payload>,
    options?: DispatchContextOptions,
  ): Promise<DispatchReport>;
  /** The jobs `queued` listeners run as, ready for `createQueues({ jobs: [...] })`. */
  jobs(): readonly JobDefinition<DeliveryEnvelope>[];
}

/** The registry: listener definitions indexed by event name, and the names they claim. */
function indexListeners(listeners: readonly ListenerDefinition<unknown>[]): {
  readonly byEvent: Map<string, ListenerDefinition<unknown>[]>;
  readonly jobNames: Set<string>;
} {
  const byEvent = new Map<string, ListenerDefinition<unknown>[]>();
  const jobNames = new Set<string>();

  for (const listener of listeners) {
    const name = deliveryJobName(listener.event, listener.name);
    if (jobNames.has(name)) {
      throw new TypeError(
        `two listeners for event "${listener.event.name}" are both named "${listener.name}" — ` +
          'the name is half of the job name, so a duplicate is a job nobody can address',
      );
    }
    jobNames.add(name);

    const existing = byEvent.get(listener.event.name) ?? [];
    existing.push(listener);
    byEvent.set(listener.event.name, existing);
  }

  return { byEvent, jobNames };
}

export function createEvents(options: CreateEventsOptions): Events {
  const { byEvent } = indexListeners(options.listeners);
  const now = options.now ?? ((): number => Date.now());
  const newId = options.newId ?? ((): string => crypto.randomUUID());
  const log = options.log;

  const names = [...byEvent.keys()].sort((a, b) => a.localeCompare(b));

  const listenersFor = (
    event: EventDefinition<unknown>,
  ): readonly ListenerDefinition<unknown>[] => {
    const declared = byEvent.get(event.name);
    if (declared === undefined) throw unknownEvent(event.name, names);
    return declared;
  };

  /** What a `queued` listener runs inside the worker: no bus, no registry — just the envelope. */
  const jobs = options.listeners
    .filter((listener) => modeOf(listener) === 'queued')
    .map((listener) =>
      defineJob<DeliveryEnvelope>({
        name: deliveryJobName(listener.event, listener.name),
        ...(listener.connection === undefined ? {} : { connection: listener.connection }),
        ...(listener.maxAttempts === undefined ? {} : { maxAttempts: listener.maxAttempts }),
        ...(listener.retryable === undefined ? {} : { retryable: listener.retryable }),
        ...(listener.description === undefined ? {} : { description: listener.description }),
        handle: async (context: JobContext<DeliveryEnvelope>) => {
          await runListener(listener, {
            id: context.id,
            payload: context.payload.payload,
            occurredAt: context.payload.occurredAt,
            attempt: context.attempt,
            signal: context.signal,
            // Wrapped rather than passed by reference: `JobContext.log` is a method, and a method
            // separated from its object loses its `this` (`unbound-method` is right to say so).
            log: (message) => {
              context.log(message);
            },
          });
        },
      }),
    );

  async function runListener(
    listener: ListenerDefinition<unknown>,
    delivery: {
      readonly id: string;
      readonly payload: unknown;
      readonly occurredAt: number;
      readonly attempt: number;
      readonly signal: AbortSignal;
      readonly log: (message: string) => void;
    },
  ): Promise<void> {
    const context: EventContext<unknown> = {
      event: listener.event,
      listener: listener.name,
      id: delivery.id,
      payload: delivery.payload,
      occurredAt: delivery.occurredAt,
      attempt: delivery.attempt,
      signal: delivery.signal,
      log: delivery.log,
    };
    await listener.handle(context);
  }

  return {
    names,

    listenersOf(event) {
      return listenersFor(event).map((listener) => listener.name);
    },

    definitionsOf(event) {
      return listenersFor(event);
    },

    async dispatch(event, payload, dispatchOptions = {}) {
      const listeners = listenersFor(event);
      const id = dispatchOptions.id ?? newId();
      const occurredAt = dispatchOptions.occurredAt ?? now();

      const syncListeners = listeners.filter((listener) => modeOf(listener) === 'sync');
      const queuedListeners = listeners.filter((listener) => modeOf(listener) === 'queued');

      // Checked before anything runs: a `queued` listener with no queue is a delivery that can
      // never happen, and finding out after the sync half already ran is the worst ordering.
      if (queuedListeners.length > 0 && options.queue === undefined) {
        throw noQueueForListener(event.name, queuedListeners[0]?.name ?? '(unknown)');
      }

      const controller = new AbortController();
      const failures: { listener: string; detail: string }[] = [];
      for (const listener of syncListeners) {
        try {
          await runListener(listener, {
            id: `${id}:${listener.name}`,
            payload,
            occurredAt,
            attempt: 1,
            signal: controller.signal,
            log: log ?? ((): void => undefined),
          });
        } catch (error: unknown) {
          failures.push({
            listener: listener.name,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // Every listener that ran is reported, not just the first: one failing `sync` listener
      // should not hide that another also failed.
      if (failures.length > 0) throw eventFailed(event.name, failures);

      const queue = options.queue;
      const queued: { listener: string; id: string }[] = [];
      for (const listener of queuedListeners) {
        const deliveryId = `${id}:${listener.name}`;
        const envelope: DeliveryEnvelope = {
          event: event.name,
          listener: listener.name,
          payload,
          occurredAt,
          dispatchId: id,
        };
        const dispatchOptionsFor: DispatchOptions = {
          idempotencyKey: deliveryId,
          ...(listener.connection === undefined ? {} : { connection: listener.connection }),
          ...(listener.maxAttempts === undefined ? {} : { maxAttempts: listener.maxAttempts }),
        };
        // `queue` is defined whenever `queuedListeners` is non-empty — checked above — but the
        // narrowing has to be local for the compiler to believe it.
        if (queue === undefined) throw noQueueForListener(event.name, listener.name);
        await queue.dispatch(
          { name: deliveryJobName(listener.event, listener.name) },
          envelope,
          dispatchOptionsFor,
        );
        queued.push({ listener: listener.name, id: deliveryId });
      }

      return { id, sync: syncListeners.map((listener) => listener.name), queued };
    },

    jobs() {
      return jobs;
    },
  };
}

/**
 * The message one delivery becomes in the outbox.
 *
 * Exported because the equivalence matters: a `queued` listener delivered directly and the same
 * listener delivered through the outbox are the *same job*, with the same name, the same payload
 * shape and the same attempts. Two shapes would mean a retry that behaves differently depending
 * on how the event happened to be published.
 */
export function deliveryMessage(input: {
  readonly listener: ListenerDefinition<unknown>;
  readonly envelope: DeliveryEnvelope;
  readonly connection: string;
  readonly at: number;
}): JobMessage {
  const id = `${input.envelope.dispatchId}:${input.listener.name}`;
  return {
    id,
    name: deliveryJobName(input.listener.event, input.listener.name),
    payload: JSON.stringify(input.envelope),
    connection: input.listener.connection ?? input.connection,
    attempts: 0,
    maxAttempts: input.listener.maxAttempts ?? JOB_DEFAULTS.maxAttempts,
    availableAt: input.at,
    createdAt: input.at,
    idempotencyKey: id,
  };
}
