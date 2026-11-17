/**
 * `sendgrid` (`MAIL-7`) — the high-volume workhorse, and the one with the widest free tier.
 *
 * Resend is the modern DX pick and Postmark the deliverability pick; SendGrid is the one that has
 * been in production longest and the one a team is most likely to already have an account with
 * (Twilio's Q4 2024 report: >100 billion emails a month). A framework that ships two of the three
 * and calls it coverage is asking a startup to change providers on day one.
 *
 * Two shapes worth noting, both of which are SendGrid's and not ours:
 *
 *   · **`personalizations`.** The address list lives in an array of personalisation objects, which
 *     is how one call sends a per-recipient variant. We send one personalisation containing every
 *     recipient: the same message to all of them, which is what a transactional send means.
 *   · **`content` is an array of typed parts.** `text/plain` before `text/html`, because that is
 *     the order a mail client falls back through. Getting it wrong is silent: the client picks
 *     whichever it finds first and the message arrives as the wrong one.
 *
 * `X-Message-Id` is a response *header*, not a body field — the only provider here whose id is not
 * JSON. Reading `response.body` for it would hand the caller an empty id and a delivery that looks
 * untracked.
 */

import { encodeBase64Lines } from '../base64.ts';
import { transportFailed } from '../errors.ts';
import { type DeliveryResult, type MailMessage, type MailTransport } from '../port.ts';
import { postJson } from './http.ts';

export interface SendGridTransportOptions {
  readonly apiKey: string;
  /** Defaults to `https://api.sendgrid.com`. EU regional accounts use `https://api.eu.sendgrid.com`. */
  readonly baseUrl?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly name?: string | undefined;
}

interface SendGridPart {
  readonly type: string;
  readonly value: string;
}

export function sendgridTransport(options: SendGridTransportOptions): MailTransport {
  const base = (options.baseUrl ?? 'https://api.sendgrid.com').replace(/\/+$/u, '');

  return {
    name: options.name ?? 'sendgrid',
    capabilities: {
      delivers: true,
      html: true,
      attachments: true,
      customHeaders: true,
      tags: true,
    },

    async send(message: MailMessage): Promise<DeliveryResult> {
      const content: SendGridPart[] = [];
      // Plain first: the array order is the client's fallback order, not our preference.
      if (message.text !== undefined) content.push({ type: 'text/plain', value: message.text });
      if (message.html !== undefined) content.push({ type: 'text/html', value: message.html });

      const body = {
        personalizations: [
          {
            to: message.to.map((address) => ({ email: address.email, ...nameOf(address) })),
            ...(message.cc === undefined
              ? {}
              : {
                  cc: message.cc.map((address) => ({ email: address.email, ...nameOf(address) })),
                }),
            ...(message.bcc === undefined
              ? {}
              : {
                  bcc: message.bcc.map((address) => ({
                    email: address.email,
                    ...nameOf(address),
                  })),
                }),
          },
        ],
        from: { email: message.from.email, ...nameOf(message.from) },
        ...(message.replyTo === undefined
          ? {}
          : {
              reply_to: {
                email: message.replyTo[0]?.email ?? message.from.email,
                ...nameOf(message.replyTo[0] ?? message.from),
              },
            }),
        subject: message.subject,
        content,
        ...(message.headers === undefined ? {} : { headers: message.headers }),
        ...(message.tags === undefined
          ? {}
          : {
              // SendGrid's category limits: 10 categories, 255 chars each, no leading `!`.
              categories: Object.keys(message.tags)
                .slice(0, 10)
                .map((key) => key.slice(0, 255)),
            }),
        ...(message.attachments === undefined
          ? {}
          : {
              attachments: message.attachments.map((attachment) => ({
                filename: attachment.filename,
                content: encodeBase64Lines(attachment.content, 0),
                ...(attachment.contentType === undefined ? {} : { type: attachment.contentType }),
                ...(attachment.contentId === undefined
                  ? {}
                  : { disposition: 'inline', content_id: attachment.contentId }),
              })),
            }),
      };

      const response = await postJson({
        transport: this.name,
        operation: 'POST /v3/mail/send',
        url: `${base}/v3/mail/send`,
        headers: { authorization: `Bearer ${options.apiKey}` },
        body,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });

      // 202 is the accepted status, and `postJson` already rejected anything else. SendGrid answers
      // 202 with an EMPTY body, so `response.body` is `{}` by construction here.
      const id = response.headers?.['x-message-id'];
      if (id === undefined || id === '') {
        throw transportFailed({
          transport: this.name,
          operation: 'POST /v3/mail/send',
          detail:
            'accepted with no X-Message-Id header — the message may have been sent, but it cannot be tracked or correlated with a webhook event',
        });
      }

      return {
        id,
        accepted: message.to.map((address) => address.email),
      };
    },
  };
}

function nameOf(address: { readonly name?: string | undefined }): { name?: string } {
  return address.name === undefined ? {} : { name: address.name };
}
