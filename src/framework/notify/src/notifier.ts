/**
 * The notifier (`§ 4.4`).
 *
 * One call, one dispatch id, N channels. What makes this file worth reading is the order of the
 * work, because every alternative order has a failure mode that only shows up in production:
 *
 *   1. **Resolve the channels by name, refusing an undeclared one.** A typo is a notification
 *      that never arrives on the channel someone believes it does.
 *   2. **Build every payload now, then check it.** Capabilities (`html`, `attachments`) and each
 *      channel's own shape are validated *before* anything is queued — a payload refused here
 *      fails in the request that produced it, not in a worker three retries later.
 *   3. **Queue one job per channel, or deliver inline when asked.** Queued is the default,
 *      because on Tsir the queue is transactional and the request path should not contain a
 *      provider's latency. Inline is one flag and one node in the declaration.
 *   4. **Report what happened per channel.** `delivered` and `queued` are lists of records, not a
 *      boolean: "the email went, the webhook is queued" is the sentence an operator needs.
 *
 * It never swallows a failure. Inline delivery runs every channel, then throws the first failure:
 * a channel that was skipped because an earlier one threw is a notification that silently never
 * existed.
 */

import { TsirError } from '@tsir/container';
import { defineJob, type JobContext, type JobDefinition, type Queue } from '@tsir/queue';

import {
  runChannel,
  assertCarriable,
  type Channel,
  type Channels,
  type Notifiable,
} from './channel.ts';
import { createChannels } from './channel.ts';
import {
  deliveryId,
  deliveryJobName,
  isDeliveryEnvelope,
  type DeliveryEnvelope,
} from './delivery.ts';
import {
  channelNotDeclared,
  forbiddenInProduction,
  invalidPayload,
  noQueue,
  nothingSelected,
} from './errors.ts';
import {
  createNotifications,
  type NotificationDefinition,
  type Notifications,
} from './notification.ts';
import type { ChannelName } from './payloads.ts';

/** The queue slice a notifier needs. `Queue` satisfies it; so does a fake in a test. */
export type NotifyQueue = Pick<Queue, 'connection' | 'dispatch'>;

export interface CreateNotifierOptions {
  readonly channels: readonly Channel[];
  /** `unknown` rather than `never`: a concrete `NotificationDefinition<Order>` must fit. */
  readonly notifications: readonly NotificationDefinition<unknown>[];
  /** Required only for queued notifications — `queued: false` ones never touch it. */
  readonly queue?: NotifyQueue | undefined;
  /**
   * Refuse channels that do not deliver. `memory` is the one; production should never notify
   * into a list nobody reads, which is the same rule `@tsir/mail` applies to `log`.
   */
  readonly production?: boolean | undefined;
  readonly now?: (() => number) | undefined;
  /** Dispatch ids, injectable so a test can name the id it expects. */
  readonly newId?: (() => string) | undefined;
  /** Where delivery-time logs go. Defaults to discarding them: a library owns no stdout. */
  readonly log?: ((message: string) => void) | undefined;
}

export interface SendOptions {
  readonly to: Notifiable;
  /** Deliver inside this call. Defaults to the notification's `queued` setting. */
  readonly immediately?: boolean | undefined;
  /** Send on a subset of the notification's channels. Never a superset. */
  readonly only?: readonly ChannelName[] | undefined;
  /** Reuse a known id — a request id — as the dispatch id. */
  readonly id?: string | undefined;
  /**
   * What an inline delivery does when a channel fails. `throw` (default) refuses to let a failure
   * pass silently; `collect` records it in `delivered` with `accepted: false` and a detail, which
   * is what `tsir notify:test` needs to print one line per channel instead of one exception.
   */
  readonly onError?: 'throw' | 'collect' | undefined;
}

export interface ChannelRecord {
  readonly channel: ChannelName;
  readonly accepted: boolean;
  /** The provider's id (message id, row id, `202`). */
  readonly id?: string | undefined;
  readonly detail?: string | undefined;
  /** The delivery id: dispatch id plus channel. Also the queue's idempotency key. */
  readonly deliveryId: string;
}

export interface QueuedRecord {
  readonly channel: ChannelName;
  readonly job: string;
  readonly id: string;
}

export interface NotificationReport {
  readonly id: string;
  readonly notification: string;
  readonly channels: readonly ChannelName[];
  readonly queued: readonly QueuedRecord[];
  readonly delivered: readonly ChannelRecord[];
}

export interface PreviewRecord {
  readonly channel: ChannelName;
  readonly driver: string;
  readonly payload: unknown;
}

export interface Notifier {
  readonly channels: Channels;
  readonly notifications: Notifications;
  readonly names: readonly string[];
  /** Send (or queue) one notification to one recipient. */
  send<Data>(
    notification: NotificationDefinition<Data>,
    data: Data,
    options: SendOptions,
  ): Promise<NotificationReport>;
  /** Build every channel's payload without sending: what `notify:preview` prints. */
  preview<Data>(
    notification: NotificationDefinition<Data>,
    data: Data,
    to: Notifiable,
  ): readonly PreviewRecord[];
  /** Deliver one envelope — the body of the queued job. */
  deliver(envelope: DeliveryEnvelope): Promise<ChannelRecord>;
  /** The jobs a worker needs, one per channel a notification uses. */
  jobs(): readonly JobDefinition<DeliveryEnvelope>[];
}

export function createNotifier(options: CreateNotifierOptions): Notifier {
  const channels = createChannels(options.channels);
  const notifications = createNotifications(options.notifications);
  const now = options.now ?? ((): number => Date.now());
  const newId = options.newId ?? ((): string => crypto.randomUUID());
  const log = options.log;

  /** A production deployment refuses a channel that reaches nobody. */
  const assertUsable = (channel: Channel): void => {
    if (options.production === true && !channel.capabilities.delivers) {
      throw forbiddenInProduction(channel.name);
    }
  };

  const selected = (
    notification: NotificationDefinition<unknown>,
    only: readonly ChannelName[] | undefined,
  ): readonly Channel[] => {
    if (only !== undefined) {
      for (const name of only) {
        if (!notification.channels.includes(name)) {
          throw channelNotDeclared(notification.name, name, notification.channels);
        }
      }
    }
    const wanted = notification.channels.filter(
      (name) => only === undefined || only.includes(name),
    );
    if (wanted.length === 0) throw nothingSelected(notification.name, notification.channels);
    return wanted.map((name) => {
      const channel = channels.get(name);
      assertUsable(channel);
      return channel;
    });
  };

  /** Build and check one payload. Shared by the send, queue and preview paths. */
  const render = (
    notification: NotificationDefinition<unknown>,
    channel: Channel,
    data: unknown,
    to: Notifiable,
  ): unknown => {
    const payload = notification.build(channel.name, data, to);
    assertCarriable(channel, payload);
    channel.check?.(payload);
    return payload;
  };

  const notifier: Notifier = {
    channels,
    notifications,
    names: notifications.names,

    async send(notification, data, sendOptions) {
      const dispatchId = sendOptions.id ?? newId();
      const at = now();
      const targets = selected(notification, sendOptions.only);

      // Build everything first: a payload refused here never reaches a queue.
      const payloads = targets.map((channel) => ({
        channel,
        payload: render(notification, channel, data, sendOptions.to),
      }));

      const inline = sendOptions.immediately === true || !notification.queued;
      const base = {
        id: dispatchId,
        notification: notification.name,
        channels: targets.map((channel) => channel.name),
      } as const;

      if (inline) {
        const delivered = await deliverAll(
          payloads,
          dispatchId,
          notification.name,
          sendOptions.to,
          at,
          sendOptions.onError === 'collect',
        );
        return { ...base, queued: [], delivered };
      }

      const queue = options.queue;
      if (queue === undefined) {
        throw noQueue(
          notification.name,
          targets.map((channel) => channel.name),
        );
      }

      const queued: QueuedRecord[] = [];
      for (const entry of payloads) {
        const job = deliveryJobName(entry.channel.name);
        const envelope: DeliveryEnvelope = {
          notification: notification.name,
          channel: entry.channel.name,
          payload: entry.payload,
          to: toEnvelope(sendOptions.to),
          dispatchId,
          at,
        };
        const result = await queue.dispatch({ name: job }, envelope, {
          idempotencyKey: deliveryId(dispatchId, entry.channel.name),
        });
        queued.push({ channel: entry.channel.name, job, id: result.id });
      }

      return { ...base, queued, delivered: [] };
    },

    preview(notification, data, to) {
      const targets = selected(notification, undefined);
      return targets.map((channel) => ({
        channel: channel.name,
        driver: channel.driver,
        payload: render(notification, channel, data, to),
      }));
    },

    async deliver(envelope) {
      if (!isDeliveryEnvelope(envelope)) {
        throw invalidPayload(
          typeof (envelope as { channel?: unknown } | null)?.channel === 'string'
            ? String((envelope as { channel: string }).channel)
            : 'unknown',
          'not a delivery envelope — `notification`, `channel`, `dispatchId`, `at`, `payload` and `to` are required',
        );
      }
      const channel = channels.get(envelope.channel);
      assertUsable(channel);
      const notification = notifications.get(envelope.notification);
      // A queued payload is JSON from a database: the channel validates it again, here.
      assertCarriable(channel, envelope.payload);
      channel.check?.(envelope.payload);
      const record = await runChannel(channel, {
        deliveryId: deliveryId(envelope.dispatchId, envelope.channel),
        notification: notification.name,
        to: envelope.to,
        payload: envelope.payload,
        at: envelope.at,
      });
      log?.(`${notification.name} → ${channel.name}: ${record.accepted ? 'accepted' : 'refused'}`);
      return {
        channel: channel.name,
        accepted: record.accepted,
        ...(record.id === undefined ? {} : { id: record.id }),
        ...(record.detail === undefined ? {} : { detail: record.detail }),
        deliveryId: deliveryId(envelope.dispatchId, envelope.channel),
      };
    },

    jobs() {
      const used = new Set<ChannelName>();
      for (const notification of notifications.all()) {
        for (const name of notification.channels) {
          if (channels.has(name)) used.add(name);
        }
      }

      return [...used]
        .sort((a, b) => a.localeCompare(b))
        .map((name) => {
          const channel = channels.get(name);
          return defineJob<DeliveryEnvelope>({
            name: deliveryJobName(name),
            description: `notify — ${channel.driver} (${name})`,
            // A delivery is a plain POST or INSERT: it is safe to retry, and the delivery id is the
            // idempotency key the queue already dedupes on.
            retryable: true,
            handle: async (context: JobContext<DeliveryEnvelope>) => {
              await notifier.deliver(context.payload);
            },
          });
        });
    },
  };

  /** Inline delivery: run every channel, then throw the first failure. */
  async function deliverAll(
    payloads: readonly { readonly channel: Channel; readonly payload: unknown }[],
    dispatchId: string,
    notification: string,
    to: Notifiable,
    at: number,
    collect: boolean,
  ): Promise<readonly ChannelRecord[]> {
    const settled = await Promise.allSettled(
      payloads.map(async ({ channel, payload }) =>
        runChannel(channel, {
          deliveryId: deliveryId(dispatchId, channel.name),
          notification,
          to,
          payload,
          at,
        }).then((result) => ({ channel, result })),
      ),
    );

    const records: ChannelRecord[] = [];
    let failure: unknown;
    for (const [index, outcome] of settled.entries()) {
      const channel = payloads[index]?.channel;
      if (channel === undefined) continue;
      if (outcome.status === 'fulfilled') {
        const { result } = outcome.value;
        records.push({
          channel: channel.name,
          accepted: result.accepted,
          ...(result.id === undefined ? {} : { id: result.id }),
          ...(result.detail === undefined ? {} : { detail: result.detail }),
          deliveryId: deliveryId(dispatchId, channel.name),
        });
        continue;
      }
      if (collect) {
        records.push({
          channel: channel.name,
          accepted: false,
          detail:
            outcome.reason instanceof Error ? outcome.reason.message : describe(outcome.reason),
          deliveryId: deliveryId(dispatchId, channel.name),
        });
        continue;
      }
      failure ??= outcome.reason;
    }

    // `failure` is whatever a channel threw; a channel that throws a non-Error is wrapped so the
    // worker sees a real error object rather than a rejection with a string in it.
    if (failure instanceof Error) throw failure;
    if (failure !== undefined)
      throw new TsirError(
        'NOTIFY_DELIVERY_FAILED',
        `a channel rejected a delivery with: ${describe(failure)}`,
        { kind: 'capability' },
      );
    return records;
  }

  return notifier;
}

/** A thrown value that is not an `Error`, rendered without `[object Object]`. */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return 'an unserializable value';
  }
}

/** The recipient, frozen to JSON: an address travels, a row reference does not. */
function toEnvelope(to: Notifiable): DeliveryEnvelope['to'] {
  return {
    ...(to.id === undefined ? {} : { id: to.id }),
    ...(to.email === undefined ? {} : { email: to.email }),
    ...(to.phone === undefined ? {} : { phone: to.phone }),
    ...(to.webhookUrl === undefined ? {} : { webhookUrl: to.webhookUrl }),
    ...(to.locale === undefined ? {} : { locale: to.locale }),
  };
}
