/**
 * Type-level tests for `@tsir/queue` job payloads (TST-013).
 *
 * The guarantee: a job's payload type is the one its `handle` reads, and a dispatch must carry
 * that type. A mismatch is a compile error, so it cannot reach a worker as malformed JSON.
 * Each `@ts-expect-error` below is a case that must fail to compile; if it stops failing, the
 * check reports the directive as unused.
 */

import { defineJob, type Queue } from '../src/index.ts';

interface ChargeCard {
  readonly orderId: string;
  readonly cents: number;
}

const charge = defineJob<ChargeCard>({
  name: 'billing.charge',
  handle(context) {
    const orderId: string = context.payload.orderId;
    const cents: number = context.payload.cents;
    void orderId;
    void cents;
  },
});

declare const queue: Queue;

// A dispatch with the declared payload compiles.
void queue.dispatch(charge, { orderId: 'o_1', cents: 500 });

// A missing field is an error.
// @ts-expect-error: `cents` is required by ChargeCard
void queue.dispatch(charge, { orderId: 'o_1' });

// A wrong field type is an error.
// @ts-expect-error: `cents` must be a number, not a string
void queue.dispatch(charge, { orderId: 'o_1', cents: '500' });

// A handler cannot read a field the payload does not have.
defineJob<ChargeCard>({
  name: 'billing.refund',
  handle(context) {
    // @ts-expect-error: `reason` is not part of ChargeCard
    void context.payload.reason;
  },
});
