import { describe, expect, test } from 'bun:test';

import {
  Controller,
  OnEventBridge,
  OnSns,
  OnStepTask,
  removeRouteModule,
  RouteRegistry,
  routeModule,
  type RouteModule,
} from '@tsir/router';

import { compileListeners, listenerUnitFor } from './listeners.ts';
import type { ListenerApp, ListenerController } from './listeners.ts';

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

describe('listenerUnitFor (DPL-026)', () => {
  /**
   * An app handle shaped like `defineApp`'s: a loader plus a module list.
   *
   * `listenerControllers()` reads `defineApp`'s module list, so the test declares a real
   * `routeModule` — the same thing an application does — and removes it afterwards, because
   * the declaration list is process-global (and other files in this process declared modules
   * too, so removing only ours is the honest cleanup).
   */
  function appWith(module: RouteModule | undefined): ListenerApp {
    const modules = module === undefined ? [] : [module.module];
    return { load: () => ({ values: {} }), modulesFor: () => modules };
  }

  function declareOrders(): { readonly declared: RouteModule; readonly registry: RouteRegistry } {
    const registry = new RouteRegistry();
    const declared = routeModule({ name: 'orders-listeners-test', registry });

    @Controller(registry)
    class OrdersForTest {
      @OnSns({ topic: 'orders' })
      onOrder(): void {}

      @OnStepTask({ name: 'charge' })
      charge(): unknown {
        return { charged: true };
      }
    }
    void OrdersForTest;
    return { declared, registry };
  }

  test('an app with listeners yields the handlers the adapter dispatches to', () => {
    const { declared } = declareOrders();
    try {
      const unit = listenerUnitFor(appWith(declared));
      expect(Object.keys(unit).sort()).toEqual(['invoke', 'sns']);
    } finally {
      removeRouteModule(declared);
    }
  });

  test('an app with no listeners yields nothing, not undefined', () => {
    expect(listenerUnitFor(appWith(undefined))).toEqual({});
  });

  test('`expect` turns a bundle that lost its listeners into a loud init failure', () => {
    // This is the `"sideEffects": false` case: the build sees the decorators, the bundler drops
    // the registration import, and the deployed handler would otherwise ignore every event.
    expect(() => listenerUnitFor(appWith(undefined), { expect: ['sns'], unit: 'notify' })).toThrow(
      /no listener controller reached the bundle/u,
    );

    const { declared } = declareOrders();
    try {
      // The same app with its listeners but no matching handler is a different diagnosis: the
      // graph and the decorators disagree about which unit owns the trigger.
      expect(() =>
        listenerUnitFor(appWith(declared), { expect: ['eventbridge'], unit: 'notify' }),
      ).toThrow(/no listener handles it/u);
    } finally {
      removeRouteModule(declared);
    }
  });
});
