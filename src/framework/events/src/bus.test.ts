/**
 * The bus (`§ 4.5`).
 *
 * The properties that have to hold, and are therefore what is tested:
 *
 *   · **the mode is declared, not inferred** — one event, two listeners, two different delivery
 *     paths, and `dispatch` reports which ran which way;
 *   · **a `sync` failure is the caller's problem** — it throws, and it throws *before* any queued
 *     listener is dispatched, because a queued dispatch after a failed inline listener is how a
 *     receipt job outlives the rollback that killed its order;
 *   · **one dispatch id, one delivery id per listener** — sharing a key between listeners would
 *     make the first delivery cancel the second on a backend with real idempotency;
 *   · **an undeclared event is a refusal**, not an empty fan-out.
 */

import { describe, expect, test } from 'bun:test';
import type { DispatchOptions, DispatchResult } from '@tsir/queue';

import { createEvents } from './bus.ts';
import { defineEvent, defineListener, deliveryJobName } from './event.ts';

interface OrderPlaced {
  readonly orderId: string;
}
const OrderPlaced = defineEvent<OrderPlaced>({ name: 'order.placed' });
const OrderCancelled = defineEvent<{ readonly orderId: string }>({ name: 'order.cancelled' });

function fakeQueue(connection = 'default') {
  const dispatched: { name: string; payload: unknown; options: DispatchOptions }[] = [];
  return {
    dispatched,
    connection,
    dispatch: async (
      job: { name: string },
      payload: unknown,
      options: DispatchOptions = {},
    ): Promise<DispatchResult> => {
      dispatched.push({ name: job.name, payload, options });
      return { id: `q-${String(dispatched.length)}`, connection, name: job.name, accepted: true };
    },
  };
}

describe('createEvents', () => {
  test('sync runs inline and queued becomes a job — the mode is declared, never inferred', async () => {
    const ran: string[] = [];
    const SendReceipt = defineListener(OrderPlaced, {
      name: 'send-receipt',
      mode: 'queued',
      handle: ({ payload }) => {
        ran.push(`receipt:${payload.orderId}`);
      },
    });
    const WarmDashboard = defineListener(OrderPlaced, {
      name: 'warm-dashboard',
      mode: 'sync',
      handle: ({ payload }) => {
        ran.push(`dashboard:${payload.orderId}`);
      },
    });

    const queue = fakeQueue();
    const events = createEvents({
      listeners: [SendReceipt, WarmDashboard],
      queue,
      newId: () => 'd-1',
      now: () => 1_000,
    });

    const report = await events.dispatch(OrderPlaced, { orderId: 'o-1' });

    // Inline half: already done when `dispatch` resolved.
    expect(ran).toEqual(['dashboard:o-1']);
    expect(report.sync).toEqual(['warm-dashboard']);
    expect(report.queued).toEqual([{ listener: 'send-receipt', id: 'd-1:send-receipt' }]);
    expect(queue.dispatched).toHaveLength(1);
    expect(queue.dispatched[0]?.name).toBe('event:order.placed:send-receipt');
    expect(queue.dispatched[0]?.payload).toEqual({
      event: 'order.placed',
      listener: 'send-receipt',
      payload: { orderId: 'o-1' },
      occurredAt: 1_000,
      dispatchId: 'd-1',
    });
  });

  test('the event default is used when a listener names no mode', async () => {
    const ran: string[] = [];
    // `order.cancelled` is declared `sync`, so a listener without a mode inherits it…
    const SyncDefault = defineEvent<{ readonly orderId: string }>({
      name: 'order.cancelled',
      mode: 'sync',
    });
    const Listener = defineListener(SyncDefault, {
      name: 'audit',
      handle: () => {
        ran.push('audit');
      },
    });

    const events = createEvents({ listeners: [Listener] });
    const report = await events.dispatch(SyncDefault, { orderId: 'o-2' });

    expect(ran).toEqual(['audit']);
    expect(report.queued).toEqual([]);
    // …and a sync-only bus does not need a queue at all.
  });

  test('a sync listener that throws stops the dispatch before anything is queued', async () => {
    const ReserveStock = defineListener(OrderPlaced, {
      name: 'reserve-stock',
      mode: 'sync',
      handle: () => {
        throw new Error('out of stock');
      },
    });
    const SendReceipt = defineListener(OrderPlaced, {
      name: 'send-receipt',
      mode: 'queued',
      handle: () => undefined,
    });

    const queue = fakeQueue();
    const events = createEvents({ listeners: [ReserveStock, SendReceipt], queue });

    const error = await events
      .dispatch(OrderPlaced, { orderId: 'o-3' })
      .then(() => undefined)
      .catch((caught: unknown) => caught as { code?: string; message: string });

    expect(error?.code).toBe('CAP_EVENT_FAILED');
    expect(error?.message).toContain('reserve-stock');
    expect(error?.message).toContain('out of stock');
    // The queue write is the one that would have survived the caller's rollback.
    expect(queue.dispatched).toEqual([]);
  });

  test('every failing sync listener is named, not just the first', async () => {
    const A = defineListener(OrderPlaced, {
      name: 'a',
      mode: 'sync',
      handle: () => {
        throw new Error('a failed');
      },
    });
    const B = defineListener(OrderPlaced, {
      name: 'b',
      mode: 'sync',
      handle: () => {
        throw new Error('b failed');
      },
    });

    const events = createEvents({ listeners: [A, B] });
    const error = await events
      .dispatch(OrderPlaced, { orderId: 'o-4' })
      .then(() => undefined)
      .catch((caught: unknown) => caught as { message: string });

    expect(error?.message).toContain('2 listener(s)');
    expect(error?.message).toContain('a (a failed)');
    expect(error?.message).toContain('b (b failed)');
  });

  test('a queued listener with no queue is refused before the sync half runs', async () => {
    const ran: string[] = [];
    const Inline = defineListener(OrderPlaced, {
      name: 'inline',
      mode: 'sync',
      handle: () => {
        ran.push('inline');
      },
    });
    const Job = defineListener(OrderPlaced, {
      name: 'job',
      mode: 'queued',
      handle: () => undefined,
    });

    const events = createEvents({ listeners: [Inline, Job] });
    const error = await events
      .dispatch(OrderPlaced, { orderId: 'o-5' })
      .then(() => undefined)
      .catch((caught: unknown) => caught as { code?: string; message: string });

    expect(error?.code).toBe('CAP_EVENTS_NO_QUEUE');
    expect(error?.message).toContain('event "order.placed"');
    // Half a fan-out is worse than none: nothing ran.
    expect(ran).toEqual([]);
  });

  test('an undeclared event is a refusal, not an empty fan-out', async () => {
    const events = createEvents({
      listeners: [
        defineListener(OrderPlaced, {
          name: 'send-receipt',
          mode: 'queued',
          handle: () => undefined,
        }),
      ],
      queue: fakeQueue(),
    });

    const error = await events
      .dispatch(OrderCancelled, { orderId: 'o-6' })
      .then(() => undefined)
      .catch((caught: unknown) => caught as { code?: string; message: string });

    expect(error?.code).toBe('CAP_UNKNOWN_EVENT');
    expect(error?.message).toContain('declared: order.placed');
  });

  test('one dispatch, one id per listener — never one id shared between them', async () => {
    const First = defineListener(OrderPlaced, {
      name: 'first',
      mode: 'queued',
      handle: () => undefined,
    });
    const Second = defineListener(OrderPlaced, {
      name: 'second',
      mode: 'queued',
      handle: () => undefined,
    });

    const queue = fakeQueue();
    const events = createEvents({ listeners: [First, Second], queue, newId: () => 'd-9' });
    const report = await events.dispatch(OrderPlaced, { orderId: 'o-7' });

    expect(report.id).toBe('d-9');
    expect(queue.dispatched.map((entry) => entry.options.idempotencyKey)).toEqual([
      'd-9:first',
      'd-9:second',
    ]);
  });

  test('a dispatch id can be supplied, so a request id can follow the delivery', async () => {
    const Listener = defineListener(OrderPlaced, {
      name: 'send-receipt',
      mode: 'queued',
      handle: () => undefined,
    });
    const queue = fakeQueue();
    const events = createEvents({ listeners: [Listener], queue });

    const report = await events.dispatch(OrderPlaced, { orderId: 'o-8' }, { id: 'req-42' });

    expect(report.id).toBe('req-42');
    expect(queue.dispatched[0]?.options.idempotencyKey).toBe('req-42:send-receipt');
  });

  test('a listener connection overrides the queue default', async () => {
    const Heavy = defineListener(OrderPlaced, {
      name: 'heavy',
      mode: 'queued',
      connection: 'heavy',
      maxAttempts: 9,
      handle: () => undefined,
    });
    const queue = fakeQueue('default');
    const events = createEvents({ listeners: [Heavy], queue });

    await events.dispatch(OrderPlaced, { orderId: 'o-9' });

    expect(queue.dispatched[0]?.options.connection).toBe('heavy');
    expect(queue.dispatched[0]?.options.maxAttempts).toBe(9);
  });

  test('listenersOf and names describe what was declared', () => {
    const events = createEvents({
      listeners: [
        defineListener(OrderPlaced, {
          name: 'send-receipt',
          mode: 'queued',
          handle: () => undefined,
        }),
        defineListener(OrderCancelled, { name: 'audit', mode: 'sync', handle: () => undefined }),
      ],
    });

    expect(events.names).toEqual(['order.cancelled', 'order.placed']);
    expect(events.listenersOf(OrderPlaced)).toEqual(['send-receipt']);
    expect(events.listenersOf(OrderCancelled)).toEqual(['audit']);
  });
});

describe('the jobs the bus hands to a worker', () => {
  test('a queued listener is a real job definition, named after the event', () => {
    const SendReceipt = defineListener(OrderPlaced, {
      name: 'send-receipt',
      mode: 'queued',
      maxAttempts: 3,
      connection: 'heavy',
      retryable: false,
      handle: () => undefined,
    });
    const events = createEvents({ listeners: [SendReceipt], queue: fakeQueue() });

    const [job] = events.jobs();
    expect(job?.name).toBe(deliveryJobName(OrderPlaced, 'send-receipt'));
    expect(job?.name).toBe('event:order.placed:send-receipt');
    expect(job?.maxAttempts).toBe(3);
    expect(job?.connection).toBe('heavy');
    expect(job?.retryable).toBe(false);
  });

  test('a sync listener is not a job — there is nothing for a worker to pick up', () => {
    const events = createEvents({
      listeners: [
        defineListener(OrderPlaced, { name: 'inline', mode: 'sync', handle: () => undefined }),
      ],
    });

    expect(events.jobs()).toEqual([]);
  });

  test('the job body runs the listener with the worker’s context', async () => {
    const seen: { id: string; attempt: number; orderId: string }[] = [];
    const SendReceipt = defineListener(OrderPlaced, {
      name: 'send-receipt',
      mode: 'queued',
      handle: ({ id, attempt, payload }) => {
        seen.push({ id, attempt, orderId: payload.orderId });
      },
    });
    const events = createEvents({ listeners: [SendReceipt], queue: fakeQueue() });

    const [job] = events.jobs();
    const controller = new AbortController();
    await job?.handle({
      id: 'ob-7:send-receipt',
      name: 'event:order.placed:send-receipt',
      payload: {
        event: 'order.placed',
        listener: 'send-receipt',
        payload: { orderId: 'o-1' },
        occurredAt: 0,
        dispatchId: 'ob-7',
      },
      attempt: 2,
      maxAttempts: 5,
      connection: 'default',
      signal: controller.signal,
      log: () => undefined,
    });

    // The id is the delivery id the outbox row (or the dispatch) used — the same key an
    // idempotent handler would use, and the same one across retries.
    expect(seen).toEqual([{ id: 'ob-7:send-receipt', attempt: 2, orderId: 'o-1' }]);
  });

  test('a listener that logs writes through the worker’s log, not a detached function', async () => {
    // `JobContext.log` is a *method*, so passing it by reference would lose its `this` and the
    // line would vanish (or throw) — the wrapper at the call site is why this works.
    const lines: string[] = [];
    const SendReceipt = defineListener(OrderPlaced, {
      name: 'send-receipt',
      mode: 'queued',
      // Deliberately NOT destructured: destructuring `log` here would unbind the very method this
      // test exists to prove is bound at the call site.
      handle: (context) => {
        context.log(`receipt queued for ${context.payload.orderId}`);
      },
    });
    const events = createEvents({ listeners: [SendReceipt], queue: fakeQueue() });

    const [job] = events.jobs();
    await job?.handle({
      id: 'ob-8:send-receipt',
      name: 'event:order.placed:send-receipt',
      payload: {
        event: 'order.placed',
        listener: 'send-receipt',
        payload: { orderId: 'o-9' },
        occurredAt: 0,
        dispatchId: 'ob-8',
      },
      attempt: 1,
      maxAttempts: 5,
      connection: 'default',
      signal: new AbortController().signal,
      log: (message: string) => {
        lines.push(message);
      },
    });

    expect(lines).toEqual(['receipt queued for o-9']);
  });
});
