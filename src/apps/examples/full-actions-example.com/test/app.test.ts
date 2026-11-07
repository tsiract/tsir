import { describe, expect, test } from 'bun:test';

import { compileRoutes, type ControllerEntry } from '@tsir/router';

import app, { events, handler, queues } from '../app.ts';
import { orders } from '../orders/index.ts';
import { OrderPlacedEvent } from '../orders/events/order-placed.event.ts';
import { SendReceiptJob } from '../orders/queues/send-receipt.job.ts';

const appEntries = (): readonly ControllerEntry[] => [...orders.registry.entries()];

const get = (path: string, init?: RequestInit): Promise<Response> =>
  handler(new Request(`http://tsir.test${path}`, init));

describe('full-actions example', () => {
  test('boots through the same path production uses', async () => {
    const instance = await app.createApp({ mode: 'test', env: { APP_ENV: 'test' } });
    expect(instance.state.kind).toBe('ready');
    await instance.shutdown('manual');
  });

  test('the registry compiles into a table with the declared routes', () => {
    const table = compileRoutes(appEntries());
    expect(table.routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'GET /api/orders',
      'GET /api/orders/:id',
      'POST /api/orders',
    ]);
  });

  test('creates an order and lists it', async () => {
    const created = await get('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerEmail: 'ada@example.com', amount: 42 }),
    });
    expect(created.status).toBe(201);
    const order = (await created.json()) as { id: string; customerEmail: string; amount: number };
    expect(order.customerEmail).toBe('ada@example.com');
    expect(order.amount).toBe(42);

    const list = await get('/api/orders');
    const json = (await list.json()) as { data: { customerEmail: string }[] };
    expect(json.data.some((o) => o.customerEmail === 'ada@example.com')).toBe(true);
  });

  test('validates the order body', async () => {
    const rejected = await get('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerEmail: 'not-an-email', amount: -1 }),
    });
    expect(rejected.status).toBe(422);
  });
});

describe('full-actions example · queue (CAP-004)', () => {
  test('the job registry contains the send-receipt job', () => {
    expect(queues.jobs.has('send-receipt')).toBe(true);
    expect(queues.jobs.get('send-receipt')).toBe(SendReceiptJob);
  });

  test('a dispatch creates a message the worker can run', async () => {
    const queue = queues.connection();
    const result = await queue.dispatch(SendReceiptJob, {
      orderId: 'order-123',
      customerEmail: 'ada@example.com',
    });
    expect(result.accepted).toBe(true);

    const worker = queues.worker();
    const ran = await worker.drainOnce();
    expect(ran.length).toBe(1);
  });
});

describe('full-actions example · events (§ 4.5)', () => {
  test('the order.placed event is declared with a queued listener', () => {
    expect(OrderPlacedEvent.name).toBe('order.placed');
    expect(events.definitionsOf(OrderPlacedEvent).some((l) => l.name === 'notify-warehouse')).toBe(
      true,
    );
  });

  test('dispatching the event hands the listener to the queue', async () => {
    const report = await events.dispatch(OrderPlacedEvent, {
      orderId: 'order-456',
      customerEmail: 'grace@example.com',
      amount: 99,
    });
    expect(report.queued.length).toBeGreaterThan(0);
    expect(report.queued[0]?.listener).toBe('notify-warehouse');

    const worker = queues.worker();
    const ran = await worker.drainOnce();
    expect(ran.length).toBe(1);
  });
});
