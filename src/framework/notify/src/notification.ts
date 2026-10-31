/**
 * Notifications (`§ 4.4`).
 *
 * A notification is **a name, a channel list, and one payload builder per channel**. That is the
 * whole shape, and it is where this package differs from a "send a template" helper:
 *
 * > The data is typed, the channels are declared, and the payload each channel receives is built
 * > by the notification — never by the channel, and never by the caller.
 *
 * Why the builder lives here rather than in the channel: the same fact ("order #41 shipped") is an
 * email with a subject and a tracking link, an inbox row with a title and a URL, and a webhook body
 * with an event name and an id. One channel that tried to render all three would have to know the
 * notification's data, and would then be impossible to swap.
 *
 * Two declaration-time refusals, because both produce a delivery that silently does nothing: a
 * declared channel with no builder, and a builder for a channel that is not declared.
 */

import type { Notifiable } from './channel.ts';
import {
  channelNotDeclared,
  duplicateNotification,
  noBuilder,
  strayBuilder,
  unknownNotification,
} from './errors.ts';
import type {
  ChannelName,
  ChatPayload,
  InboxPayload,
  MailPayload,
  SmsPayload,
  WebhookPayload,
} from './payloads.ts';

/** A builder gets the notification's data and the recipient, and returns that channel's payload. */
export type ChannelBuilder<Data, Payload> = (data: Data, to: Notifiable) => Payload;

export interface DefineNotificationInput<Data> {
  /** Dotted, lowercase, stable: `order.shipped`. It travels in the queued delivery. */
  readonly name: string;
  /** Where this notification goes. Each one needs a builder below. */
  readonly channels: readonly ChannelName[];
  /**
   * Deliver inside the call that sends it instead of queueing. Default `true` — queued.
   *
   * On Tsir the queue is transactional, so queueing costs correctness nothing and buys the request
   * path a great deal; `queued: false` is for a notification whose loss is genuinely acceptable.
   */
  readonly queued?: boolean | undefined;
  readonly description?: string | undefined;
  /** What `notify:preview` and `notify:test` render when no `--data` is given. */
  readonly sample?: Data | undefined;
  /**
   * A payload builder per **channel name**, for a channel whose name is not one of the six typed
   * ones below (`hooks`, `alerts`, `room`). The payload is `unknown` because this package cannot
   * know which shape a name refers to — the channel validates it at delivery, which it has to do
   * anyway for a payload that came back through a queue.
   */
  readonly builders?: Readonly<Record<ChannelName, ChannelBuilder<Data, unknown>>> | undefined;
  readonly mail?: ChannelBuilder<Data, MailPayload> | undefined;
  readonly database?: ChannelBuilder<Data, InboxPayload> | undefined;
  readonly webhook?: ChannelBuilder<Data, WebhookPayload> | undefined;
  readonly chat?: ChannelBuilder<Data, ChatPayload> | undefined;
  readonly sms?: ChannelBuilder<Data, SmsPayload> | undefined;
  readonly memory?: ChannelBuilder<Data, unknown> | undefined;
  /** A channel of your own, by name. */
  readonly build?: ((channel: ChannelName, data: Data, to: Notifiable) => unknown) | undefined;
}

export interface NotificationDefinition<Data> {
  readonly name: string;
  readonly channels: readonly ChannelName[];
  readonly queued: boolean;
  readonly description?: string | undefined;
  readonly sample?: Data | undefined;
  /**
   * Build one channel's payload. Declared as a **method** so the definition is bivariant in `Data`:
   * a `NotificationDefinition<OrderShipped>` fits a registry of unknown data, while
   * `notifier.send(notification, data)` still checks `data` against the notification's own type.
   */
  build(channel: ChannelName, data: Data, to: Notifiable): unknown;
}

const NOTIFICATION_NAME = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/u;

/** The payload builders this package knows by name; anything else needs `build`. */
const BUILDERS = ['mail', 'database', 'webhook', 'chat', 'sms', 'memory'] as const;

/**
 * Declare a notification.
 *
 * The name is checked here rather than at the first send: it is what the queue carries and what
 * `notify:preview` takes on the command line, so renaming one after a release is a migration.
 */
export function defineNotification<Data>(
  input: DefineNotificationInput<Data>,
): NotificationDefinition<Data> {
  if (!NOTIFICATION_NAME.test(input.name)) {
    throw new TypeError(
      `notification name "${input.name}" is not a dotted lowercase name — use \`order.shipped\`, ` +
        'because the name travels in the queued delivery',
    );
  }
  if (input.channels.length === 0) {
    throw new TypeError(
      `notification "${input.name}" declares no channels — a notification with nowhere to go is ` +
        'a declaration that only reads like one',
    );
  }
  if (new Set(input.channels).size !== input.channels.length) {
    throw new TypeError(`notification "${input.name}" declares the same channel twice`);
  }

  const builders = new Map<ChannelName, (data: Data, to: Notifiable) => unknown>();
  for (const [channel, builder] of Object.entries(input.builders ?? {})) {
    if (typeof builder === 'function') builders.set(channel, builder);
  }
  for (const channel of BUILDERS) {
    const builder = input[channel];
    // A named entry in `builders` wins: a project that writes both is describing one channel twice,
    // and the explicit record is the one it can see in its own config.
    if (builder !== undefined && !builders.has(channel)) builders.set(channel, builder);
  }
  const anyBuilder = input.build;

  const declared = new Set(input.channels);
  for (const channel of declared) {
    if (!builders.has(channel) && anyBuilder === undefined) throw noBuilder(input.name, channel);
  }
  for (const channel of builders.keys()) {
    if (!declared.has(channel)) throw strayBuilder(input.name, channel);
  }

  return {
    name: input.name,
    channels: input.channels.slice(),
    queued: input.queued ?? true,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.sample === undefined ? {} : { sample: input.sample }),
    build(channel, data, to) {
      // `only` narrows a send; nothing widens it. Building a channel this notification does not
      // declare would hand back a payload shaped for something else.
      if (!declared.has(channel)) throw channelNotDeclared(input.name, channel, input.channels);
      const builder = builders.get(channel);
      if (builder !== undefined) return builder(data, to);
      if (anyBuilder !== undefined) return anyBuilder(channel, data, to);
      throw noBuilder(input.name, channel);
    },
  };
}

/** The registry: notifications by name, with duplicates refused rather than shadowed. */
export interface Notifications {
  readonly names: readonly string[];
  get(name: string): NotificationDefinition<unknown>;
  has(name: string): boolean;
  all(): readonly NotificationDefinition<unknown>[];
  /** Which notifications declare a channel — what `notify:channels` shows. */
  usingChannel(channel: ChannelName): readonly string[];
}

export function createNotifications(
  notifications: readonly NotificationDefinition<unknown>[],
): Notifications {
  const byName = new Map<string, NotificationDefinition<unknown>>();
  for (const notification of notifications) {
    if (byName.has(notification.name)) throw duplicateNotification(notification.name);
    byName.set(notification.name, notification);
  }

  const names = [...byName.keys()].sort((a, b) => a.localeCompare(b));

  return {
    names,
    has(name) {
      return byName.has(name);
    },
    get(name) {
      const notification = byName.get(name);
      if (notification === undefined) throw unknownNotification(name, names);
      return notification;
    },
    all() {
      return notifications.slice();
    },
    usingChannel(channel) {
      return names.filter((name) => byName.get(name)?.channels.includes(channel) === true);
    },
  };
}
