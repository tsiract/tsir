/**
 * @tsir/notify — notifications over channels.
 *
 * ```ts
 * import { defineNotification, createNotifier, channelsFromConfig } from '@tsir/notify';
 *
 * const OrderShipped = defineNotification<{ id: string; tracking: string }>({
 *   name: 'order.shipped',
 *   channels: ['mail', 'database'],
 *   sample: { id: 'ord_1', tracking: 'TRK1' },
 *   mail: (data, to) => ({ subject: `Order ${data.id} shipped`, text: `Track it: ${data.tracking}` }),
 *   database: (data) => ({ title: 'Your order shipped', url: `/orders/${data.id}` }),
 * });
 *
 * const notifier = createNotifier({
 *   channels: channelsFromConfig({ notify, mailers, database: db, env: process.env }),
 *   notifications: [OrderShipped],
 *   queue,
 * });
 *
 * await notifier.send(OrderShipped, { id: 'ord_1', tracking: 'TRK1' }, { to: user });
 * ```
 *
 * Notifications are **queued by default** — one job per channel, so a mail provider's bad afternoon
 * does not re-post the webhook that already arrived. `queued: false` (or `{ immediately: true }`)
 * sends inline, and then a channel's failure reaches the caller.
 *
 * The port is deliberately the shape of `@tsir/mail`'s transport port, because "send this
 * somewhere" should not have two spellings in one framework.
 */

/* ── the port ─────────────────────────────────────────────────────────────── */
export {
  assertCarriable,
  createChannels,
  defineChannel,
  runChannel,
  type Channel,
  type ChannelCapabilities,
  type ChannelDelivery,
  type ChannelResult,
  type Channels,
  type Notifiable,
} from './channel.ts';

/* ── what a channel carries ───────────────────────────────────────────────── */
export {
  BUILT_IN_CHANNELS,
  type BuiltInChannel,
  type ChannelName,
  type ChannelPayloads,
  type ChatPayload,
  type InboxLevel,
  type InboxPayload,
  type MailPayload,
  type SmsPayload,
  type WebhookPayload,
} from './payloads.ts';

/* ── declaring ────────────────────────────────────────────────────────────── */
export {
  createNotifications,
  defineNotification,
  type ChannelBuilder,
  type DefineNotificationInput,
  type NotificationDefinition,
  type Notifications,
} from './notification.ts';

export {
  deliveryId,
  deliveryJobName,
  isDeliveryEnvelope,
  type DeliveryEnvelope,
} from './delivery.ts';

/* ── the notifier ─────────────────────────────────────────────────────────── */
export {
  createNotifier,
  type ChannelRecord,
  type CreateNotifierOptions,
  type NotificationReport,
  type Notifier,
  type NotifyQueue,
  type PreviewRecord,
  type QueuedRecord,
  type SendOptions,
} from './notifier.ts';

/* ── channels ─────────────────────────────────────────────────────────────── */
export {
  mailChannel,
  parseMailPayload,
  type MailChannelOptions,
  type MailPort,
} from './channels/mail.ts';
export {
  createInboxStore,
  databaseChannel,
  inboxTableDdl,
  parseInboxPayload,
  type DatabaseChannelOptions,
  type InboxRow,
  type InboxSql,
  type InboxSqlResult,
  type InboxSqlStatement,
  type InboxStore,
  type InboxStoreOptions,
} from './channels/database.ts';
export {
  checkUrl,
  hostAllowed,
  webhookBody,
  webhookChannel,
  type WebhookChannelOptions,
} from './channels/webhook.ts';
export {
  CHAT_DRIVERS,
  chatBody,
  chatChannel,
  type ChatChannelOptions,
  type ChatDriver,
} from './channels/chat.ts';
export {
  parseSms,
  smsChannel,
  twilioProvider,
  type SmsChannelOptions,
  type SmsProvider,
  type TwilioOptions,
} from './channels/sms.ts';

/* ── signatures, for the receiver on the other end ────────────────────────── */
export { parseSignature, signBody, verifySignature } from './signing.ts';

/* ── configuration ────────────────────────────────────────────────────────── */
export {
  CHANNEL_DRIVERS,
  channelFromConfig,
  channelsFromConfig,
  type BuildChannelsOptions,
  type ChannelDriverName,
  type ConfiguredChannel,
  type EnvRef,
} from './config.ts';

export type { NotifyErrorCode } from './errors.ts';
