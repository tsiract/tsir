/**
 * `ses` — Amazon SES v2, raw MIME over SigV4 (`MAIL-7`).
 *
 * The transport that reuses `@tsir/storage`'s signing rather than growing a second copy of SigV4 or
 * pulling in the AWS SDK (which is ~2 MB and Node-shaped). Everything except the signature is a
 * `POST` of JSON; the signature is `signRequest` from `@tsir/storage`, which is already checked
 * against AWS's own published vectors.
 *
 * `Raw` rather than the structured `Simple` content: a structured send has no attachments and no
 * custom headers, and a transport that can only send part of a message is a transport whose
 * capabilities are a lie. `buildMime` produces the same bytes `smtp` would.
 *
 * **Not an edge transport.** The capability matrix is explicit: this is for Lambda and
 * Bun. It works on Workers when the credentials are there, but SES's endpoint is region-pinned and
 * a Worker calling it is a design decision, not a default.
 */

import { encodeBase64Lines } from '../base64.ts';
import { transportFailed } from '../errors.ts';
import { buildMime } from '../mime.ts';
import type { DeliveryResult, MailMessage, MailTransport } from '../port.ts';
import { signRequest, type AwsCredentials } from '@tsir/storage';

export interface SesTransportOptions {
  readonly region: string;
  readonly credentials: AwsCredentials;
  /** Overridden in a test so the request goes to a fake. */
  readonly endpoint?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly name?: string | undefined;
}

export function sesTransport(options: SesTransportOptions): MailTransport {
  const endpoint =
    options.endpoint ?? `https://email.${options.region}.amazonaws.com/v2/email/outbound-emails`;
  const now = options.now ?? Date.now;

  return {
    name: options.name ?? 'ses',
    capabilities: {
      delivers: true,
      html: true,
      attachments: true,
      customHeaders: true,
      // SES v2 calls them message tags, and they are a list of name/value pairs like Resend's.
      tags: true,
    },

    async send(message: MailMessage): Promise<DeliveryResult> {
      const mime = buildMime(message, { now: now() });
      const body = JSON.stringify({
        FromEmailAddress: message.from.email,
        Destination: {
          ToAddresses: message.to.map((address) => address.email),
          ...(message.cc === undefined
            ? {}
            : { CcAddresses: message.cc.map((address) => address.email) }),
          ...(message.bcc === undefined
            ? {}
            : { BccAddresses: message.bcc.map((address) => address.email) }),
        },
        ...(message.replyTo === undefined
          ? {}
          : { ReplyToAddresses: message.replyTo.map((address) => address.email) }),
        Content: {
          Raw: { Data: encodeBase64Lines(mime.message, 0) },
        },
        ...(message.tags === undefined
          ? {}
          : {
              EmailTags: Object.entries(message.tags).map(([Name, Value]) => ({ Name, Value })),
            }),
      });

      const headers = await signRequest({
        method: 'POST',
        url: endpoint,
        service: 'ses',
        region: options.region,
        credentials: options.credentials,
        date: now(),
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(body),
      });

      const doFetch = options.fetch ?? fetch;
      const controller = options.timeoutMs === undefined ? undefined : new AbortController();
      const timer =
        controller === undefined || options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => controller.abort(), options.timeoutMs);

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: { ...headers },
          body,
          ...(controller === undefined ? {} : { signal: controller.signal }),
        });
      } catch (error: unknown) {
        throw transportFailed({
          transport: 'ses',
          operation: 'SendEmail (the request itself failed)',
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      const text = await response.text();
      if (!response.ok) {
        throw transportFailed({
          transport: 'ses',
          operation: 'SendEmail',
          status: response.status,
          // SES answers with `{"message": "..."}` — and with `{"Message": "..."}` on some edges.
          detail: sesMessage(text),
        });
      }

      const parsed = parseSesBody(text);
      if (parsed.MessageId === undefined || parsed.MessageId === '') {
        throw transportFailed({
          transport: 'ses',
          operation: 'SendEmail (the answer has no MessageId)',
        });
      }

      return {
        id: parsed.MessageId,
        accepted: [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].map(
          (address) => address.email,
        ),
      };
    },
  };
}

/**
 * SES answers `{"MessageId": "..."}`, and a non-JSON answer is a proxy, not SES — so it becomes a
 * failure rather than an empty object that reads as "sent".
 */
function parseSesBody(text: string): { MessageId?: string } {
  if (text === '') return {};
  try {
    return JSON.parse(text) as { MessageId?: string };
  } catch {
    throw transportFailed({
      transport: 'ses',
      operation: 'SendEmail (the answer is not JSON — something between you and SES is)',
      detail: text.slice(0, 200),
    });
  }
}

/** SES's error body, without depending on `http.ts` (which speaks a different dialect). */
function sesMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: string; Message?: string };
    return parsed.message ?? parsed.Message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}
