/**
 * The `sms` channel (`§ 4.4`) — a short message through a provider, over a port.
 *
 * A paid message is the one thing in this package that must never be enabled by a default: `§ 4.4`
 * says so, and it is why there is no `sms` entry in the default channel list and no way to reach
 * this channel without naming it in config. The port is a shape, not a vendor: an application that
 * already has a Twilio client passes it, and the one provider this package ships is a `fetch` call
 * so a project without a client is not blocked on installing a fifteen-megabyte SDK.
 *
 * The phone number is checked as E.164 before the request, because `+63 917 …` reaching Twilio is a
 * 400 with a message nobody reads, and an empty `to` is a message billed to the wrong person.
 */

import { TsirError } from '@tsir/container';
import { deliveryFailed, invalidPayload } from '../errors.ts';
import { PostFailed, post } from './post.ts';
import type { Channel } from '../channel.ts';
import type { SmsPayload } from '../payloads.ts';

/** What a provider has to do. Twilio satisfies it; so does whatever the app already has. */
export interface SmsProvider {
  readonly name: string;
  send(message: { readonly to: string; readonly body: string }): Promise<{ readonly id: string }>;
}

export interface SmsChannelOptions {
  /** Default `sms`. */
  readonly name?: string | undefined;
  readonly provider: SmsProvider;
}

export function smsChannel(options: SmsChannelOptions): Channel {
  const name = options.name ?? 'sms';

  return {
    name,
    driver: options.provider.name,
    capabilities: { delivers: true, html: false, attachments: false },
    check(payload) {
      parse(payload, name, undefined);
    },
    async send(delivery) {
      const payload = parse(delivery.payload, name, delivery.to.phone);
      try {
        const result = await options.provider.send({ to: payload.to ?? '', body: payload.body });
        return { accepted: true, id: result.id, detail: `${options.provider.name} accepted it` };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw deliveryFailed(delivery.notification, name, detail);
      }
    },
  };
}

/** E.164, and nothing else: `+`, a non-zero country digit, then 6–14 more digits. */
const E164 = /^\+[1-9]\d{6,14}$/u;

export function parseSms(payload: unknown, channel: string, fallback?: string): SmsPayload {
  return parse(payload, channel, fallback);
}

function parse(payload: unknown, channel: string, fallback: string | undefined): SmsPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw invalidPayload(channel, 'the payload is not an object');
  }
  const record = payload as Partial<SmsPayload>;
  if (typeof record.body !== 'string' || record.body.trim() === '') {
    throw invalidPayload(channel, '`body` must be a non-empty string');
  }
  const to = record.to ?? fallback;
  if (to === undefined || to === '') {
    throw invalidPayload(channel, 'no `to` in the payload and no `phone` on the notifiable');
  }
  if (!E164.test(to)) {
    throw invalidPayload(
      channel,
      `"${to}" is not an E.164 number (use +639171234567, not 0917… or a spaced number)`,
    );
  }
  return { to, body: record.body };
}

export interface TwilioOptions {
  readonly accountSid: string;
  readonly authToken: string;
  /** The sender: a Twilio number or a Messaging Service SID (`MG…`). */
  readonly from: string;
  readonly endpoint?: string | undefined;
  readonly fetcher?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Twilio's Messages API, as a provider.
 *
 * Form-encoded rather than JSON (Twilio accepts both; this is the documented one) and Basic auth
 * from the two config values — neither of which ever reaches an error message.
 */
export function twilioProvider(options: TwilioOptions): SmsProvider {
  const endpoint =
    options.endpoint ??
    `https://api.twilio.com/2010-04-01/Accounts/${options.accountSid}/Messages.json`;
  const authorization = `Basic ${btoa(`${options.accountSid}:${options.authToken}`)}`;

  return {
    name: 'twilio',
    async send(message) {
      const form = new URLSearchParams({ To: message.to, From: options.from, Body: message.body });
      try {
        const response = await post({
          url: endpoint,
          body: form.toString(),
          headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        });
        // Twilio answers 201 with `sid`; the id is what an operator can look up.
        const sid = /"sid"\s*:\s*"([^"]+)"/u.exec(response.text)?.[1];
        return { id: sid ?? `http-${String(response.status)}` };
      } catch (error: unknown) {
        const detail =
          error instanceof PostFailed
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        throw new TsirError('NOTIFY_DELIVERY_FAILED', `twilio refused the message: ${detail}`, {
          kind: 'capability',
        });
      }
    },
  };
}
