/**
 * The `webhook` channel (`§ 4.4`) — the only channel whose destination comes from **data**.
 *
 * That single fact makes this the channel with the security work in it:
 *
 *   · **An allowlist is mandatory.** `WebhookPayload.url` is produced by a notification builder,
 *     which is fed by business data, which is fed by a customer. Without an allowlist the endpoint
 *     is an SSRF primitive aimed at whatever the runtime can reach — on Cloudflare that includes
 *     the metadata service of the network the Worker runs in.
 *   · **`https:` is required** unless the project says otherwise, and a URL with credentials in it
 *     is refused outright (they would end up in a log line and in a proxy's cache key).
 *   · **The body is signed when a secret is configured**, with the timestamp inside the signed
 *     string, so a receiver can tell a replay from a delivery.
 *
 * The body a receiver sees is always the same shape — `{ event, notification, deliveryId, data }` —
 * because a webhook endpoint dispatches on `event`, and a payload that sometimes *is* the data and
 * sometimes wraps it is a receiver with a `if` statement in it.
 */

import { deliveryFailed, invalidPayload, webhookBlocked } from '../errors.ts';
import { signBody } from '../signing.ts';
import { PostFailed, post } from './post.ts';
import type { Channel, ChannelDelivery, ChannelResult } from '../channel.ts';
import type { WebhookPayload } from '../payloads.ts';

export interface WebhookChannelOptions {
  /** Default `webhook`. */
  readonly name?: string | undefined;
  /** Hosts a URL may point at. `*.example.com` matches one label and deeper. Required. */
  readonly allowHosts: readonly string[];
  /** When set, every request carries `x-tsir-signature`. */
  readonly secret?: string | undefined;
  /** Static headers — an `authorization` for an endpoint that wants one. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Permit `http:` (a local receiver in development). Default `false`. */
  readonly allowHttp?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetcher?: typeof fetch | undefined;
}

/** The exact JSON a receiver is handed. Exported so a receiver's test can assert it. */
export function webhookBody(
  delivery: Pick<ChannelDelivery, 'notification' | 'deliveryId' | 'payload'>,
  parsed: WebhookPayload,
): string {
  return JSON.stringify({
    event: parsed.event ?? delivery.notification,
    notification: delivery.notification,
    deliveryId: delivery.deliveryId,
    data: parsed.body,
  });
}

export function webhookChannel(options: WebhookChannelOptions): Channel {
  const name = options.name ?? 'webhook';
  if (options.allowHosts.length === 0) {
    throw new TypeError(
      `the "${name}" channel needs at least one allowlisted host — a webhook URL that comes from ` +
        'data and is not checked is an SSRF primitive',
    );
  }
  const allowHttp = options.allowHttp === true;

  return {
    name,
    driver: 'webhook',
    capabilities: { delivers: true, html: false, attachments: false },
    check(payload) {
      parse(payload, name);
    },
    async send(delivery) {
      const parsed = parse(delivery.payload, name);
      const url = parsed.url ?? delivery.to.webhookUrl;
      if (url === undefined || url === '') {
        throw invalidPayload(name, 'no `url` in the payload and no `webhookUrl` on the notifiable');
      }

      const target = checkUrl(url, options.allowHosts, allowHttp, name);
      const body = webhookBody(delivery, parsed);
      const headers: Record<string, string> = {
        'user-agent': 'tsir-notify',
        'x-tsir-notification': delivery.notification,
        'x-tsir-delivery': delivery.deliveryId,
        ...options.headers,
        ...parsed.headers,
      };
      if (options.secret !== undefined) {
        headers['x-tsir-signature'] = await signBody({
          secret: options.secret,
          body,
          timestamp: delivery.at,
        });
      }

      try {
        const response = await post({
          url: target,
          body,
          headers,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        });
        const result: ChannelResult = {
          accepted: true,
          id: `http-${String(response.status)}`,
          detail: `POST ${new URL(target).host} → ${String(response.status)}`,
        };
        return result;
      } catch (error: unknown) {
        const detail =
          error instanceof PostFailed
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        throw deliveryFailed(delivery.notification, name, detail);
      }
    },
  };
}

/**
 * The URL rules, in one place, because `chat` reuses none of them: a chat room's URL is configured
 * by the project rather than produced by business data, and the difference is the whole allowlist.
 */
export function checkUrl(
  raw: string,
  allowHosts: readonly string[],
  allowHttp: boolean,
  channel: string,
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw webhookBlocked(raw, 'it is not an absolute URL');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw webhookBlocked(raw, `its protocol is ${url.protocol} — https is required`);
  }
  if (url.username !== '' || url.password !== '') {
    throw webhookBlocked(
      raw,
      'it carries credentials — put the token in `headers`, where it is not a URL',
    );
  }
  if (!hostAllowed(url.hostname, allowHosts)) {
    throw webhookBlocked(
      raw,
      `its host "${url.hostname}" is not on the ${channel} channel's allowlist (${allowHosts.join(', ')})`,
    );
  }
  return url.toString();
}

/** Exact match, or `*.example.com` for subdomains. A bare `*` is refused at the URL, not here. */
export function hostAllowed(host: string, allowHosts: readonly string[]): boolean {
  const target = host.toLowerCase();
  for (const entry of allowHosts) {
    const allowed = entry.toLowerCase().trim();
    if (allowed === '') continue;
    if (allowed === target) return true;
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1); // `.example.com`
      if (target.endsWith(suffix) && target.length > suffix.length) return true;
    }
  }
  return false;
}

function parse(payload: unknown, channel: string): WebhookPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw invalidPayload(channel, 'the payload is not an object');
  }
  const record = payload as Partial<WebhookPayload>;
  if (typeof record.body !== 'object' || record.body === null || Array.isArray(record.body)) {
    throw invalidPayload(channel, '`body` must be a JSON object');
  }
  if (record.url !== undefined && typeof record.url !== 'string') {
    throw invalidPayload(channel, '`url` must be a string');
  }
  if (record.event !== undefined && typeof record.event !== 'string') {
    throw invalidPayload(channel, '`event` must be a string');
  }
  return record as WebhookPayload;
}
