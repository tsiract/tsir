/**
 * Type-level tests for `@tsir/events` payloads (TST-013).
 *
 * The guarantee: `dispatch` takes the payload type the event was declared with, and a listener
 * sees that same type. Each `@ts-expect-error` must fail to compile; if it stops failing, the
 * check reports the directive as unused.
 */

import { defineEvent, defineListener, type Events } from '../src/index.ts';

interface OrderPlaced {
  readonly orderId: string;
  readonly totalCents: number;
}

const orderPlaced = defineEvent<OrderPlaced>({ name: 'order.placed' });
const orderCancelled = defineEvent<{ readonly orderId: string }>({ name: 'order.cancelled' });

declare const events: Events;

// The declared payload compiles.
void events.dispatch(orderPlaced, { orderId: 'o_1', totalCents: 1200 });

// A missing field is an error.
// @ts-expect-error: `totalCents` is required by OrderPlaced
void events.dispatch(orderPlaced, { orderId: 'o_1' });

// A field of the wrong type is an error.
// @ts-expect-error: `totalCents` must be a number
void events.dispatch(orderPlaced, { orderId: 'o_1', totalCents: '12' });

// A listener sees the declared payload type.
defineListener(orderPlaced, {
  name: 'send-receipt',
  handle(context) {
    const total: number = context.payload.totalCents;
    void total;
    // @ts-expect-error: `totalCents` is a number, not a string
    const wrong: string = context.payload.totalCents;
    void wrong;
  },
});

void orderCancelled;
