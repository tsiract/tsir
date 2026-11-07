import { describe, expect, test } from 'bun:test';

import { Controller, OnEventBridge, OnSns, OnStepTask, RouteRegistry } from '@tsir/router';

import { compileListeners } from './listeners.ts';
import type { ListenerController } from './listeners.ts';

const fakeContext = { functionName: 'test', getRemainingTimeInMillis: () => 1000 } as never;

describe('compileListeners (DPL-026)', () => {
  test('SNS message routes to the @OnSns method by topic', async () => {
    let received: unknown;
    const registry = new RouteRegistry();

    @Controller(registry)
    class Orders {
      @OnSns({ topic: 'orders' })
      onOrder(body: unknown): void {
        received = body;
      }
    }
    void Orders;

    const [entry] = registry.entries();
    const unit = compileListeners([
      { controller: Orders, listeners: entry?.listeners ?? [] },
    ] satisfies readonly ListenerController[]);

    expect(unit.sns).toBeDefined();
    await unit.sns!(
      {
        id: 'msg-1',
        topicArn: 'arn:aws:sns:us-east-1:123456789012:orders',
        body: { orderId: 'abc' },
        record: {} as never,
      },
      fakeContext,
    );
    expect(received).toEqual({ orderId: 'abc' });
  });

  test('unknown SNS topic throws', async () => {
    const registry = new RouteRegistry();

    @Controller(registry)
    class Orders {
      @OnSns({ topic: 'orders' })
      onOrder(): void {}
    }
    void Orders;

    const [entry] = registry.entries();
    const unit = compileListeners([
      { controller: Orders, listeners: entry?.listeners ?? [] },
    ] satisfies readonly ListenerController[]);

    return expect(
      unit.sns!(
        {
          id: 'msg-1',
          topicArn: 'arn:aws:sns:us-east-1:123456789012:other',
          body: null,
          record: {} as never,
        },
        fakeContext,
      ),
    ).rejects.toThrow('no @OnSns listener for "other"');
  });

  test('EventBridge event routes by detail-type', async () => {
    let received: unknown;
    let ctx: unknown;
    const registry = new RouteRegistry();

    @Controller(registry)
    class Events {
      @OnEventBridge({ eventBus: 'default', detailType: 'order.placed' })
      onPlaced(detail: unknown, context: unknown): void {
        received = detail;
        ctx = context;
      }
    }
    void Events;

    const [entry] = registry.entries();
    const unit = compileListeners([
      { controller: Events, listeners: entry?.listeners ?? [] },
    ] satisfies readonly ListenerController[]);

    expect(unit.eventbridge).toBeDefined();
    await unit.eventbridge!(
      {
        source: 'orders',
        'detail-type': 'order.placed',
        detail: { orderId: 'xyz' },
        time: '2026-01-01T00:00:00Z',
        signal: new AbortController().signal,
      },
      fakeContext,
    );
    expect(received).toEqual({ orderId: 'xyz' });
    expect(ctx).toMatchObject({
      functionName: 'test',
      eventbridge: { 'detail-type': 'order.placed', source: 'orders' },
    });
  });

  test('uses resolveController for DI', async () => {
    let instantiated = false;
    const registry = new RouteRegistry();

    @Controller(registry)
    class Orders {
      constructor() {
        instantiated = true;
      }
      @OnSns({ topic: 'orders' })
      onOrder(): void {}
    }
    void Orders;

    const [entry] = registry.entries();
    const customInstance = { onOrder: () => {} };
    const unit = compileListeners([{ controller: Orders, listeners: entry?.listeners ?? [] }], {
      resolveController: () => customInstance,
    });

    await unit.sns!(
      { id: '1', topicArn: 'arn:aws:sns:us-east-1:1:orders', body: null, record: {} as never },
      fakeContext,
    );
    expect(instantiated).toBe(false);
  });
});

describe('compileListeners · Step Functions tasks (DPL-029)', () => {
  test('direct invoke routes to the @OnStepTask method by name and returns its value', async () => {
    let received: unknown;
    const registry = new RouteRegistry();

    @Controller(registry)
    class Tasks {
      @OnStepTask({ name: 'process-refund' })
      onRefund(input: unknown): { refunded: true } {
        received = input;
        return { refunded: true };
      }
    }
    void Tasks;

    const [entry] = registry.entries();
    const unit = compileListeners([
      { controller: Tasks, listeners: entry?.listeners ?? [] },
    ] satisfies readonly ListenerController[]);

    expect(unit.invoke).toBeDefined();
    const result = await unit.invoke!(
      { task: 'process-refund', orderId: 'ord-1', amount: 42 },
      fakeContext,
    );
    expect(received).toEqual({ orderId: 'ord-1', amount: 42 });
    // DPL-029: the task's return value is the Step Functions task output — it must not
    // be replaced by `{ ok: true }`.
    expect(result).toEqual({ refunded: true });
  });

  test('single task is invoked without an explicit task name', async () => {
    let received: unknown;
    const registry = new RouteRegistry();

    @Controller(registry)
    class Tasks {
      @OnStepTask({ name: 'process-refund' })
      onRefund(input: unknown): void {
        received = input;
      }
    }
    void Tasks;

    const [entry] = registry.entries();
    const unit = compileListeners([
      { controller: Tasks, listeners: entry?.listeners ?? [] },
    ] satisfies readonly ListenerController[]);

    await unit.invoke!({ orderId: 'ord-2' }, fakeContext);
    expect(received).toEqual({ orderId: 'ord-2' });
  });

  test('unknown task name fails with the list of known names', async () => {
    const registry = new RouteRegistry();

    @Controller(registry)
    class Tasks {
      @OnStepTask({ name: 'process-refund' })
      onRefund(): void {}
      @OnStepTask({ name: 'send-invoice' })
      onInvoice(): void {}
    }
    void Tasks;

    const [entry] = registry.entries();
    const unit = compileListeners([
      { controller: Tasks, listeners: entry?.listeners ?? [] },
    ] satisfies readonly ListenerController[]);

    return expect(unit.invoke!({ task: 'nonexistent' }, fakeContext)).rejects.toThrow(
      /known: process-refund, send-invoice/,
    );
  });
});
