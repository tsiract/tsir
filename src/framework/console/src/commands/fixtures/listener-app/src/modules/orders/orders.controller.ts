import { Controller, OnEventBridge, OnSns, OnStepTask } from '@tsir/router';

import { registry } from './routes.ts';

/**
 * Three listeners, three dispatch paths, and **no HTTP route at all** — the unit this
 * controller lives in is reachable only through an AWS event. Before `INF-005` was fixed,
 * `adapterTriggers()` returned `[]` for it and the build skipped it with a warning while
 * still writing a SAM template for it.
 */
@Controller(registry, '')
export class OrdersController {
  readonly seen: string[] = [];

  @OnSns({ topic: 'orders', unit: 'notify' })
  async onOrderPlaced(message: { readonly orderId: string }): Promise<void> {
    this.seen.push(`sns:${message.orderId}`);
  }

  @OnEventBridge({ eventBus: 'orders', detailType: 'order.placed', unit: 'notify' })
  async onOrderPlacedEvent(event: { readonly orderId: string }): Promise<void> {
    this.seen.push(`eventbridge:${event.orderId}`);
  }

  @OnStepTask({ name: 'charge', unit: 'notify' })
  async charge(input: { readonly orderId: string }): Promise<{ readonly ok: true }> {
    this.seen.push(`steptask:${input.orderId}`);
    return { ok: true };
  }
}
