import { defineListener } from '@tsir/events';

import { OrderPlacedEvent } from '../events/order-placed.event.ts';

export const NotifyWarehouseListener = defineListener(OrderPlacedEvent, {
  name: 'notify-warehouse',
  handle(context) {
    // A queued listener runs as a job; the queue's idempotency key covers retries.
    context.log(
      `notifying warehouse for order ${context.payload.orderId} (${context.payload.customerEmail})`,
    );
  },
});
