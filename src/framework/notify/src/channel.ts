/**
 * The channel port (`§ 4.4`).
 *
 * A channel takes one rendered payload and one recipient, and answers whether it accepted the
 * delivery. That is the whole contract, and it is the same contract `@tsir/mail` gives a transport
 * — on purpose, because a notification package that invents a second shape for "send this
 * somewhere" doubles what every integration has to learn.
 *
 * Three things it deliberately leaves out:
 *
 *   · **No queueing inside the channel.** The notifier queues; the channel sends. A channel that
 *     queued would hide a worker dependency inside the thing that is supposed to be the worker.
 *   · **No retries.** A channel reports the failure and stops. Retrying is the queue's job, and a
 *     channel that retried would multiply the attempts the queue already granted it.
 *   · **No rendering from data.** The payload arrived already built by the notification, so a
 *     channel never sees the notification's data — which is what keeps a channel swappable.
 *
 * Capabilities are declared per channel and **checked before anything is sent** (`assertCarriable`),
 * for the same reason mail does it: a body that silently lost its HTML, or an attachment a channel
 * dropped, is a notification that arrived wrong and reported success.
 */

import { TsirError } from '@tsir/container';

import { duplicateChannel, noChannels, unsupportedOperation, unknownChannel } from './errors.ts';
import type { ChannelName } from './payloads.ts';

/** What a channel can carry. Three facts, declared and enforced. */
export interface ChannelCapabilities {
  /** The channel reaches the recipient (or their endpoint). `memory` is `false`. */
  readonly delivers: boolean;
  /** It can carry rich (`html`) content. */
  readonly html: boolean;
  /** It can carry files. */
  readonly attachments: boolean;
}

/** One delivery, handed to a channel. */
export interface ChannelDelivery {
  /** Stable per (notification, channel, dispatch). The queue's idempotency key. */
  readonly deliveryId: string;
  /** The notification's name — a log field and the webhook event's default. */
  readonly notification: string;
  /** Who is being notified. Channels read `email`/`phone`/`webhookUrl` from it. */
  readonly to: Notifiable;
  /** What the notification's builder returned, validated again by the channel. */
  readonly payload: unknown;
  /** When the delivery was dispatched — not when the channel ran. */
  readonly at: number;
}

/** A notifiable is anything with an address on it. A `User` row usually satisfies it as-is. */
export interface Notifiable {
  /** Stable id, when the project has one. Used for the inbox and the delivery log. */
  readonly id?: string | number | undefined;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly webhookUrl?: string | undefined;
  readonly locale?: string | undefined;
}

export interface ChannelResult {
  /** The channel did the thing: sent, stored, posted. */
  readonly accepted: boolean;
  /** What the provider called it: a message id, a row id, `202`. */
  readonly id?: string | undefined;
  /** One line for a log or `notify:test`. Never a credential, never a full body. */
  readonly detail?: string | undefined;
}

export interface Channel {
  readonly name: ChannelName;
  /** `mail`, `database`, `webhook`, `chat`, `sms`, `memory`, `twilio`, `slack`, … */
  readonly driver: string;
  readonly capabilities: ChannelCapabilities;
  /**
   * Refuse a payload the channel cannot use, **before** it is queued.
   *
   * The notifier calls this on both paths, so a payload with no `subject` fails in the request that
   * produced it rather than in a worker three retries later. Optional for a custom channel: the
   * `send` path still validates, this only moves the failure earlier.
   */
  check?(payload: unknown): void;
  send(delivery: ChannelDelivery): Promise<ChannelResult>;
}

/** Declare a channel of your own. It is checked like a built-in one: name, driver, capabilities. */
export function defineChannel(channel: Channel): Channel {
  if (channel.name === '') throw new TypeError('a channel needs a name');
  if (channel.driver === '') throw new TypeError(`channel "${channel.name}" needs a driver name`);
  if (typeof channel.send !== 'function') {
    throw new TypeError(`channel "${channel.name}" needs a \`send\` method`);
  }
  return channel;
}

/**
 * A capability the channel does not have, refused **before** the send.
 *
 * Two payload keys are checked because they are the two that change what a recipient sees: an HTML
 * body that a channel drops is plain text with the tags still in it, and an attachment a channel
 * drops is a message that says "see attached" and attaches nothing.
 */
export function assertCarriable(channel: Channel, payload: unknown): void {
  if (typeof payload !== 'object' || payload === null) return;
  const record = payload as { readonly html?: unknown; readonly attachments?: unknown };

  if (record.html !== undefined && !channel.capabilities.html) {
    throw unsupportedOperation(channel.name, 'an HTML body');
  }
  if (
    record.attachments !== undefined &&
    Array.isArray(record.attachments) &&
    record.attachments.length > 0 &&
    !channel.capabilities.attachments
  ) {
    throw unsupportedOperation(channel.name, 'attachments');
  }
}

/** The channel registry: name → channel, with no fallback and no default. */
export interface Channels {
  /** Every declared channel name, sorted. */
  readonly names: readonly string[];
  get(name: ChannelName): Channel;
  has(name: ChannelName): boolean;
  /** Every channel, in declaration order — what `notify:channels` prints. */
  readonly all: readonly Channel[];
}

export function createChannels(channels: readonly Channel[]): Channels {
  if (channels.length === 0) throw noChannels();

  const byName = new Map<string, Channel>();
  for (const channel of channels) {
    if (byName.has(channel.name)) throw duplicateChannel(channel.name);
    byName.set(channel.name, channel);
  }

  const names = [...byName.keys()].sort((a, b) => a.localeCompare(b));
  const all = channels.slice();

  return {
    names,
    all,
    has(name) {
      return byName.has(name);
    },
    get(name) {
      const channel = byName.get(name);
      if (channel === undefined) throw unknownChannel(name, names);
      return channel;
    },
  };
}

/**
 * Run one delivery, turning a thrown error into `NOTIFY_DELIVERY_FAILED` with the channel named.
 *
 * The channel's own message survives in the detail (and in `cause`), because a transport error
 * that has been flattened to "delivery failed" costs an hour of somebody's evening.
 */
export async function runChannel(
  channel: Channel,
  delivery: ChannelDelivery,
): Promise<ChannelResult> {
  try {
    const result = await channel.send(delivery);
    if (typeof result?.accepted !== 'boolean') {
      throw new TypeError(`channel "${channel.name}" answered without \`accepted\``);
    }
    return result;
  } catch (error: unknown) {
    if (error instanceof TsirError && error.code === 'NOTIFY_DELIVERY_FAILED') throw error;
    const detail = error instanceof Error ? error.message : String(error);
    const wrapped = new TsirError(
      'NOTIFY_DELIVERY_FAILED',
      `"${delivery.notification}" could not be delivered on "${channel.name}": ${detail}`,
      {
        kind: 'capability',
        hint: "the channel reported the failure and stopped; retrying is the queue's job, not the notifier's",
        context: { notification: delivery.notification, channel: channel.name, detail },
        cause: error instanceof Error ? error : undefined,
      },
    );
    throw wrapped;
  }
}
