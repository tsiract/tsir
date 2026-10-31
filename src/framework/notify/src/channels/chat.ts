/**
 * The `chat` channel (`§ 4.4`) — Slack and Discord rooms, through the incoming webhook each of
 * them gives you.
 *
 * The difference from the `webhook` channel is the entire reason this is a separate channel and not
 * a preset: **the URL is configured, not produced by data**. A project that has a Slack room has one
 * URL in `tsir.js`; nothing a customer types can change where the message goes, so there is no
 * allowlist here and none is needed. Conflating the two would either weaken the webhook channel's
 * rule or make the chat channel's configuration absurd.
 *
 * The two providers differ in exactly two fields — Slack reads `text`, Discord reads `content` and
 * auto-embeds a bare URL — so the driver is a name and a body mapper, not a dependency.
 */

import { deliveryFailed, invalidPayload } from '../errors.ts';
import { PostFailed, post } from './post.ts';
import type { Channel, ChannelResult } from '../channel.ts';
import type { ChatPayload } from '../payloads.ts';

export type ChatDriver = 'slack' | 'discord';

export const CHAT_DRIVERS = ['slack', 'discord'] as const;

export interface ChatChannelOptions {
  /** Default `chat`. */
  readonly name?: string | undefined;
  readonly driver: ChatDriver;
  /** The room's incoming-webhook URL. Required, and it belongs in config, not in data. */
  readonly url: string;
  readonly timeoutMs?: number | undefined;
  readonly fetcher?: typeof fetch | undefined;
}

/** Slack's `{ text }` and Discord's `{ content }` — the whole of the difference. */
export function chatBody(driver: ChatDriver, payload: ChatPayload): Record<string, unknown> {
  const text = payload.url === undefined ? payload.text : `${payload.text}\n${payload.url}`;
  return driver === 'discord' ? { content: text } : { text };
}

export function chatChannel(options: ChatChannelOptions): Channel {
  const name = options.name ?? 'chat';
  if (options.url === '') {
    throw new TypeError(`the "${name}" channel needs the room's incoming-webhook \`url\``);
  }

  return {
    name,
    driver: options.driver,
    capabilities: { delivers: true, html: false, attachments: false },
    check(payload) {
      parse(payload, name);
    },
    async send(delivery) {
      const payload = parse(delivery.payload, name);
      const body = JSON.stringify(chatBody(options.driver, payload));

      try {
        const response = await post({
          url: options.url,
          body,
          headers: { 'user-agent': 'tsir-notify' },
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        });
        const result: ChannelResult = {
          accepted: true,
          id: `http-${String(response.status)}`,
          detail: `${options.driver} accepted the message`,
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

function parse(payload: unknown, channel: string): ChatPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw invalidPayload(channel, 'the payload is not an object');
  }
  const record = payload as Partial<ChatPayload>;
  if (typeof record.text !== 'string' || record.text.trim() === '') {
    throw invalidPayload(channel, '`text` must be a non-empty string');
  }
  if (record.url !== undefined && typeof record.url !== 'string') {
    throw invalidPayload(channel, '`url` must be a string');
  }
  return record as ChatPayload;
}
