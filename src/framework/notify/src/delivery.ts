/**
 * The queued delivery (`§ 4.4`).
 *
 * One job per **(notification, channel)** — not one job per notification. That single decision is
 * worth more than it looks:
 *
 *   · a mail provider having a bad afternoon retries the email, and does not re-post the webhook
 *     that already went through;
 *   · the job name says where it goes (`notify:deliver:mail`), so `tsir queue:failed` reads like a
 *     list of destinations rather than a list of notifications;
 *   · a channel can be given its own connection, retry budget and concurrency, because on Tsir a
 *     worker is bound to a connection (`QUEUE-13`) and destination is exactly the axis along which
 *     failure domains differ.
 *
 * The envelope is JSON, so it holds the payload rather than the data that built it: a queued
 * delivery that re-ran a builder would produce a different message every retry.
 */

import type { ChannelName } from './payloads.ts';

export interface DeliveryEnvelope {
  /** The notification's name. Resolved against the registry when the job runs. */
  readonly notification: string;
  readonly channel: ChannelName;
  /** What the builder produced, already serialized. Validated again by the channel. */
  readonly payload: unknown;
  /** Who is being notified, frozen to JSON — an address, not a row reference. */
  readonly to: {
    readonly id?: string | number | undefined;
    readonly email?: string | undefined;
    readonly phone?: string | undefined;
    readonly webhookUrl?: string | undefined;
    readonly locale?: string | undefined;
  };
  /** The dispatch id, shared by every channel of one `send`. */
  readonly dispatchId: string;
  /** When the notification was dispatched; when it runs is the queue's business. */
  readonly at: number;
}

/** The job name for one channel: `notify:deliver:mail`. */
export function deliveryJobName(channel: ChannelName): string {
  return `notify:deliver:${channel}`;
}

/** The delivery id: dispatch id plus channel. Stable, and the queue's idempotency key. */
export function deliveryId(dispatchId: string, channel: ChannelName): string {
  return `${dispatchId}:${channel}`;
}

/**
 * Validate an envelope that came back from a queue.
 *
 * A queue is a JSON boundary, so anything in here can be a string somebody edited in a table
 * viewer. A missing channel or payload is `NOTIFY_INVALID_PAYLOAD` at the channel, not a crash in
 * the worker.
 */
export function isDeliveryEnvelope(value: unknown): value is DeliveryEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Partial<DeliveryEnvelope>;
  return (
    typeof envelope.notification === 'string' &&
    typeof envelope.channel === 'string' &&
    typeof envelope.dispatchId === 'string' &&
    typeof envelope.at === 'number' &&
    typeof envelope.to === 'object' &&
    envelope.to !== null &&
    'payload' in envelope
  );
}
