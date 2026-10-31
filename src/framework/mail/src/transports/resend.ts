/**
 * `resend` (`MAIL-7`, ADR-0012 review: `fetch` only, no SDK, edge-safe).
 *
 * The shape of every one of these: compose → one `POST` → the provider's id. What is worth
 * noticing is what is *not* here — no SDK, no retry, no queue — because each of those is a policy
 * the caller owns:
 *
 *   · an SDK is a dependency with its own release cadence bundled into every Worker;
 *   · a retry multiplies the attempts a queue already gave the job, and a duplicated receipt is a
 *     worse outcome than a failed one;
 *   · a queue inside a mail package is the invisible dependency `§ 4.3` refuses.
 */

import { encodeBase64Lines } from '../base64.ts';
import { transportFailed } from '../errors.ts';
import {
  formatAddress,
  formatAddresses,
  type DeliveryResult,
  type MailMessage,
  type MailTransport,
} from '../port.ts';
import { postJson, requireString } from './http.ts';

export interface ResendTransportOptions {
  readonly apiKey: string;
  /** Defaults to `https://api.resend.com`. An EU project uses `https://api.resend.com` too. */
  readonly baseUrl?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly name?: string | undefined;
}

export function resendTransport(options: ResendTransportOptions): MailTransport {
  const base = (options.baseUrl ?? 'https://api.resend.com').replace(/\/+$/u, '');

  return {
    name: options.name ?? 'resend',
    capabilities: {
      delivers: true,
      html: true,
      attachments: true,
      customHeaders: true,
      tags: true,
    },

    async send(message: MailMessage): Promise<DeliveryResult> {
      const body = {
        from: formatAddress(message.from),
        to: formatAddresses(message.to),
        ...(message.cc === undefined ? {} : { cc: formatAddresses(message.cc) }),
        ...(message.bcc === undefined ? {} : { bcc: formatAddresses(message.bcc) }),
        ...(message.replyTo === undefined ? {} : { reply_to: formatAddresses(message.replyTo) }),
        subject: message.subject,
        ...(message.text === undefined ? {} : { text: message.text }),
        ...(message.html === undefined ? {} : { html: message.html }),
        ...(message.headers === undefined ? {} : { headers: message.headers }),
        ...(message.attachments === undefined
          ? {}
          : {
              attachments: message.attachments.map((attachment) => ({
                filename: attachment.filename,
                // Resend takes base64 and infers nothing: an unnamed file is `text/plain` there,
                // which is why the type travels separately when a caller declares one.
                content: encodeBase64Lines(attachment.content, 0),
                ...(attachment.contentType === undefined
                  ? {}
                  : { content_type: attachment.contentType }),
              })),
            }),
        ...(message.tags === undefined
          ? {}
          : {
              tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })),
            }),
      };

      const response = await postJson({
        transport: this.name,
        operation: 'POST /emails',
        url: `${base}/emails`,
        headers: { authorization: `Bearer ${options.apiKey}` },
        body,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });

      const id = requireString(response.body, ['id'], {
        transport: 'resend',
        operation: 'POST /emails',
      });
      if (id === '') throw transportFailed({ transport: 'resend', operation: 'POST /emails' });

      return {
        id,
        accepted: [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].map(
          (address) => address.email,
        ),
      };
    },
  };
}
