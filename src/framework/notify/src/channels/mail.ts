/**
 * The `mail` channel (`§ 4.4`) — a `@tsir/mail` mailer, seen through the smallest possible port.
 *
 * The port is four members of a `Mailer`, which means a real mailer satisfies it without an
 * adapter and a test satisfies it with an object literal. What the channel adds to a mailer is
 * exactly two things, and both are notification-shaped rather than mail-shaped:
 *
 *   · **The recipient comes from the notifiable**, not from the notification's data. A builder that
 *     returned an email address would be a builder that could return the wrong one.
 *   · **`template` renders at send time** through `mailer.sendTemplate`, so the template lives in
 *     `@tsir/mail` where the escaping boundary is, and this package never concatenates HTML.
 *
 * Everything else — capabilities, refusals, the provider's own errors — is the mailer's, and is
 * reported here with the notification's name attached.
 */

import { deliveryFailed, invalidPayload, notifiableMissing } from '../errors.ts';
import type { Channel } from '../channel.ts';
import type { Attachment, DeliveryResult, Mailer, TemplateMessageInput } from '@tsir/mail';
import type { MailPayload } from '../payloads.ts';

/** The four members of `Mailer` a notification needs. `Mailer` satisfies it structurally. */
export type MailPort = Pick<Mailer, 'name' | 'send' | 'sendTemplate' | 'capabilities'>;

export interface MailChannelOptions {
  /** Default `mail`. */
  readonly name?: string | undefined;
  readonly mailer: MailPort;
}

export function mailChannel(options: MailChannelOptions): Channel {
  const name = options.name ?? 'mail';
  const mailer = options.mailer;

  return {
    name,
    driver: `mail:${mailer.name}`,
    capabilities: {
      delivers: mailer.capabilities.delivers,
      html: mailer.capabilities.html,
      attachments: mailer.capabilities.attachments,
    },
    check(payload) {
      parse(payload, name);
    },
    async send(delivery) {
      const payload = parse(delivery.payload, name);
      const email = delivery.to.email;
      if (email === undefined || email === '') throw notifiableMissing(name, 'email');

      const attachments: readonly Attachment[] | undefined = payload.attachments;
      const shared = {
        to: [email],
        ...(attachments === undefined ? {} : { attachments }),
        ...(payload.replyTo === undefined ? {} : { replyTo: [payload.replyTo] }),
        ...(payload.headers === undefined ? {} : { headers: payload.headers }),
        ...(payload.tags === undefined ? {} : { tags: payload.tags }),
      } satisfies TemplateMessageInput;

      try {
        const result: DeliveryResult =
          payload.template === undefined
            ? await mailer.send({
                ...shared,
                subject: payload.subject,
                ...(payload.text === undefined ? {} : { text: payload.text }),
                ...(payload.html === undefined ? {} : { html: payload.html }),
              })
            : await mailer.sendTemplate(payload.template, payload.data ?? {}, shared);
        return {
          accepted: true,
          id: result.id,
          detail: `accepted by ${mailer.name} for ${String(result.accepted.length)} recipient(s)`,
        };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw deliveryFailed(delivery.notification, name, detail);
      }
    },
  };
}

/**
 * What a `mail` payload must have.
 *
 * Exported because the check is the contract: `subject` always, and exactly one of `text`, `html`
 * or `template` — a payload with none is an email with a subject line and nothing under it.
 */
export function parseMailPayload(payload: unknown, channel = 'mail'): MailPayload {
  return parse(payload, channel);
}

function parse(payload: unknown, channel: string): MailPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw invalidPayload(channel, 'the payload is not an object');
  }
  const record = payload as Partial<MailPayload>;
  if (typeof record.subject !== 'string' || record.subject.trim() === '') {
    throw invalidPayload(channel, '`subject` must be a non-empty string');
  }
  const bodies = [record.text, record.html, record.template].filter(
    (value) => typeof value === 'string' && value !== '',
  ).length;
  if (bodies === 0) {
    throw invalidPayload(channel, 'a body is required: `text`, `html` or `template`');
  }
  if (bodies > 1) {
    throw invalidPayload(
      channel,
      '`text`, `html` and `template` are alternatives — pick one; a template renders its own body',
    );
  }
  // A template with no `data` is legal — plenty need none. Whether the data *fits* the template is
  // the mailer's decision, made at render time with the template's own declared types.
  return record as MailPayload;
}
