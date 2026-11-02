import { defineEvent } from '@tsir/events';

/** The payload every listener of this event receives. */
export interface OrderPlacedEventPayload {
  readonly orderId: string;
  readonly customerEmail: string;
  readonly amount: number;
}

export const OrderPlacedEvent = defineEvent<OrderPlacedEventPayload>({
  name: 'order.placed',
  mode: 'queued',
});
