import { defineJob } from '@tsir/queue';

/** The payload is stored in the queue table, so keep it JSON-serialisable. */
export interface SendReceiptJobPayload {
  readonly orderId: string;
  readonly customerEmail: string;
}

export const SendReceiptJob = defineJob<SendReceiptJobPayload>({
  name: 'send-receipt',
  description: 'Send a receipt email for a placed order',
  maxAttempts: 5,
  handle(context) {
    // In production this calls the mail client. The queue retries on throw.
    context.log(`sending receipt for order ${context.payload.orderId}`);
  },
});
