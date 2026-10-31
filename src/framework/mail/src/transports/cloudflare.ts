/**
 * `cloudflare` — the Workers Email Sending binding (`MAIL-7`, `§ 4.3`).
 *
 * A binding, not an HTTP call: there is no API key, no endpoint and no `fetch`. The transport takes
 * the binding the Worker was handed (`env.EMAIL`) and calls `send` on it, which means the console
 * and a test can drive it with an object that records what it was given.
 *
 * Three facts about the platform, repeated here because they are the reason this is not the default:
 * **public beta**, **Workers Paid**, and **3,000 messages/month, 5 MiB, 50 recipients per message**
 * The recipient limit is enforced here rather
 * than discovered as a provider error, because 51 recipients is a message someone should have
 * split into two.
 */

import { transportFailed } from '../errors.ts';
import type { DeliveryResult, MailMessage, MailTransport } from '../port.ts';

/** The slice of the binding's API this transport uses. `SendEmail` is the Workers type. */
export interface CloudflareEmailBinding {
  send(input: {
    readonly from: string | { readonly email: string; readonly name?: string };
    readonly to: string | readonly (string | { readonly email: string; readonly name?: string })[];
    readonly cc?: readonly (string | { readonly email: string; readonly name?: string })[];
    readonly bcc?: readonly (string | { readonly email: string; readonly name?: string })[];
    readonly replyTo?: string | { readonly email: string; readonly name?: string };
    readonly subject: string;
    readonly text?: string;
    readonly html?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly attachments?: readonly {
      readonly filename: string;
      readonly content: Uint8Array;
      readonly type?: string;
      readonly disposition?: 'attachment' | 'inline';
      readonly contentId?: string;
    }[];
  }): Promise<{ readonly messageId?: string } | undefined>;
}

export interface CloudflareTransportOptions {
  readonly binding: CloudflareEmailBinding;
  /** The platform ceiling: 50 envelope recipients per message. */
  readonly maxRecipients?: number | undefined;
  readonly name?: string | undefined;
}

export const CLOUDFLARE_MAX_RECIPIENTS = 50;

function addressOf(address: {
  readonly email: string;
  readonly name?: string | undefined;
}): string | { readonly email: string; readonly name?: string } {
  return address.name === undefined ? address.email : { email: address.email, name: address.name };
}

export function cloudflareTransport(options: CloudflareTransportOptions): MailTransport {
  const max = options.maxRecipients ?? CLOUDFLARE_MAX_RECIPIENTS;

  return {
    name: options.name ?? 'cloudflare',
    capabilities: {
      delivers: true,
      html: true,
      attachments: true,
      customHeaders: true,
      tags: false,
    },

    async send(message: MailMessage): Promise<DeliveryResult> {
      const everyone = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];
      if (everyone.length > max) {
        throw transportFailed({
          transport: 'cloudflare',
          operation: `sending to ${String(everyone.length)} recipients`,
          detail: `the Email Sending binding allows at most ${String(max)} per message — split the send, or use a provider without the ceiling`,
        });
      }

      let result: { readonly messageId?: string } | undefined;
      try {
        result = await options.binding.send({
          from: addressOf(message.from),
          to: message.to.map(addressOf),
          ...(message.cc === undefined ? {} : { cc: message.cc.map(addressOf) }),
          ...(message.bcc === undefined ? {} : { bcc: message.bcc.map(addressOf) }),
          ...(message.replyTo === undefined || message.replyTo.length === 0
            ? {}
            : { replyTo: addressOf(message.replyTo[0] ?? message.from) }),
          subject: message.subject,
          ...(message.text === undefined ? {} : { text: message.text }),
          ...(message.html === undefined ? {} : { html: message.html }),
          ...(message.headers === undefined ? {} : { headers: message.headers }),
          ...(message.attachments === undefined
            ? {}
            : {
                attachments: message.attachments.map((attachment) => ({
                  filename: attachment.filename,
                  content: attachment.content,
                  ...(attachment.contentType === undefined ? {} : { type: attachment.contentType }),
                  ...(attachment.disposition === undefined
                    ? {}
                    : { disposition: attachment.disposition }),
                  ...(attachment.contentId === undefined
                    ? {}
                    : { contentId: attachment.contentId }),
                })),
              }),
        });
      } catch (error: unknown) {
        throw transportFailed({
          transport: 'cloudflare',
          operation: 'binding.send',
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      return {
        // The binding's id is the only id there is; when it returns nothing (the documented
        // "accepted" shape) a local one keeps `DeliveryResult.id` non-optional.
        id: result?.messageId ?? `cloudflare-${crypto.randomUUID()}`,
        accepted: everyone.map((address) => address.email),
      };
    },
  };
}
