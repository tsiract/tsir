/**
 * What a channel carries (`§ 4.4`).
 *
 * One interface per built-in channel, and each one is deliberately **plain JSON**: a payload is
 * written by a notification builder, travels through a queue as JSON, and is validated again at
 * the channel because that round trip is a real boundary. A `SafeHtml` survives it as a string, a
 * `Uint8Array` does not survive it at all — which is why an attachment is described by
 * `@tsir/mail`'s own type and refused by every channel that cannot carry one.
 *
 * The four payload types are the four things a person can be told something through: an email, a
 * row in an inbox, an HTTP request to somebody's endpoint, and a short message on a phone or in a
 * chat room.
 */

import type { Attachment } from '@tsir/mail';

/** Every channel this package knows how to build; a project may declare more of its own. */
export const BUILT_IN_CHANNELS = ['mail', 'database', 'webhook', 'chat', 'sms', 'memory'] as const;

export type BuiltInChannel = (typeof BUILT_IN_CHANNELS)[number];

/** A channel name. Not a closed union: a project may register a channel of its own. */
export type ChannelName = string;

/** `mail` — one email, through a `@tsir/mail` mailer. */
export interface MailPayload {
  readonly subject: string;
  /** Plain text. One of `text`/`html`/`template` is required. */
  readonly text?: string | undefined;
  /** HTML, already produced by mail's `html` tag (which escaped every interpolation). */
  readonly html?: string | undefined;
  /** A registered mail template name, with `data` — the mailer renders it. */
  readonly template?: string | undefined;
  readonly data?: unknown;
  readonly attachments?: readonly Attachment[] | undefined;
  readonly replyTo?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly tags?: Readonly<Record<string, string>> | undefined;
}

/** `database` — one row in the in-app inbox (`notification_inbox`). */
export interface InboxPayload {
  /** The bold line in a list. */
  readonly title: string;
  /** The body. Plain text: an inbox that renders HTML is an XSS vector with a database in front. */
  readonly body?: string | undefined;
  /** Where "open" goes. Stored, never fetched. */
  readonly url?: string | undefined;
  /** What the UI colours it with. Default `info`. */
  readonly level?: InboxLevel | undefined;
  /** JSON that belongs to the app, echoed back on read. */
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}

export type InboxLevel = 'info' | 'success' | 'warning' | 'error';

/** `webhook` — one signed POST to a host on the allowlist. */
export interface WebhookPayload {
  /** Absolute `https:` URL. Falls back to the notifiable's `webhookUrl` when omitted. */
  readonly url?: string | undefined;
  /** What this is, for the receiver's router. Defaults to the notification name. */
  readonly event?: string | undefined;
  /** The JSON body. Required, because a webhook with no body is a ping. */
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** `chat` — one message in a Slack or Discord room, through an incoming webhook. */
export interface ChatPayload {
  /** The message. Markdown-ish; Slack's `mrkdwn` and Discord's `content` both read it. */
  readonly text: string;
  /** A link appended when the room supports it. */
  readonly url?: string | undefined;
}

/** `sms` — one short message through a provider. */
export interface SmsPayload {
  /** E.164. Falls back to the notifiable's `phone`. */
  readonly to?: string | undefined;
  readonly body: string;
}

/** Everything a built-in channel accepts, by name. Used to type a notification's builders. */
export interface ChannelPayloads {
  readonly mail: MailPayload;
  readonly database: InboxPayload;
  readonly webhook: WebhookPayload;
  readonly chat: ChatPayload;
  readonly sms: SmsPayload;
  readonly memory: unknown;
}
