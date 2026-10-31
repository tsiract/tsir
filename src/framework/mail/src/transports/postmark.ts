/**
 * `postmark` (`MAIL-7`).
 *
 * The transport that makes `tags: false` a real distinction rather than a formality: Postmark has
 * **one `Tag`** per message, not a map. A package that claimed tag support here would silently
 * drop all but one, and the webhook the project built to read them would post `undefined` forever.
 * So the capability is `false`, and a caller that sets tags gets a refusal naming the transport.
 */

import { encodeBase64Lines } from '../base64.ts';
import {
  formatAddress,
  type DeliveryResult,
  type MailMessage,
  type MailTransport,
} from '../port.ts';
import { postJson, requireString } from './http.ts';

export interface PostmarkTransportOptions {
  readonly serverToken: string;
  /** A Postmark message stream. A transactional project always names one. */
  readonly messageStream?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly name?: string | undefined;
}

interface PostmarkAddress {
  readonly Email: string;
  readonly Name?: string;
}

function addressOf(address: {
  readonly email: string;
  readonly name?: string | undefined;
}): PostmarkAddress {
  return address.name === undefined
    ? { Email: address.email }
    : { Email: address.email, Name: address.name };
}

export function postmarkTransport(options: PostmarkTransportOptions): MailTransport {
  const base = (options.baseUrl ?? 'https://api.postmarkapp.com').replace(/\/+$/u, '');

  return {
    name: options.name ?? 'postmark',
    capabilities: {
      delivers: true,
      html: true,
      attachments: true,
      customHeaders: true,
      // One `Tag`, not a map: see the note at the top of this file.
      tags: false,
    },

    async send(message: MailMessage): Promise<DeliveryResult> {
      const body = {
        From: formatAddress(message.from),
        To: message.to.map(addressOf),
        ...(message.cc === undefined ? {} : { Cc: message.cc.map(addressOf) }),
        ...(message.bcc === undefined ? {} : { Bcc: message.bcc.map(addressOf) }),
        ...(message.replyTo === undefined
          ? {}
          : { ReplyTo: message.replyTo.map((address) => formatAddress(address)).join(', ') }),
        Subject: message.subject,
        ...(message.text === undefined ? {} : { TextBody: message.text }),
        ...(message.html === undefined ? {} : { HtmlBody: message.html }),
        ...(options.messageStream === undefined ? {} : { MessageStream: options.messageStream }),
        ...(message.headers === undefined
          ? {}
          : {
              Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })),
            }),
        ...(message.attachments === undefined
          ? {}
          : {
              Attachments: message.attachments.map((attachment) => ({
                Name: attachment.filename,
                Content: encodeBase64Lines(attachment.content, 0),
                ...(attachment.contentType === undefined
                  ? {}
                  : { ContentType: attachment.contentType }),
                ...(attachment.contentId === undefined
                  ? {}
                  : { ContentID: `cid:${attachment.contentId}` }),
              })),
            }),
      };

      const response = await postJson({
        transport: this.name,
        operation: 'POST /email',
        url: `${base}/email`,
        headers: {
          'x-postmark-server-token': options.serverToken,
          accept: 'application/json',
        },
        body,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });

      const id = requireString(response.body, ['MessageID'], {
        transport: 'postmark',
        operation: 'POST /email',
      });

      // Postmark reports a per-recipient rejection inside a 200 — the one provider that does — so
      // "sent" with an empty `To` list is a delivery that did not happen.
      const record = response.body as { To?: { Email?: string; MessageID?: string }[] };
      const rejected = (record.To ?? [])
        .filter((entry) => entry.MessageID === undefined || entry.MessageID === '')
        .map((entry) => ({ email: entry.Email ?? '', reason: 'postmark returned no message id' }));

      return {
        id,
        accepted: (record.To ?? [])
          .map((entry) => entry.Email ?? '')
          .filter((email) => email !== ''),
        ...(rejected.length === 0 ? {} : { rejected }),
      };
    },
  };
}
