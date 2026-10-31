/**
 * `notify.channels` in `tsir.js` (`§ 4.4`, `§ 2.2`).
 *
 * The registry knows how to check a channel; this module knows how to **build** one from
 * configuration, which is four things the registry does not:
 *
 *   · **A driver is named by string**, so an unknown name lists the ones this build ships instead
 *     of throwing from a lookup.
 *   · **A secret is an environment reference** (`{ fromEnv: 'SLACK_WEBHOOK_URL' }`), resolved here,
 *     so "no secrets in the config file" is enforced by the resolver rather than by review.
 *   · **A channel that needs another capability's object gets it by argument**, not by reaching
 *     for a global: the `mail` driver takes the project's `Mailers`, the `database` driver takes an
 *     `InboxSql` (`@tsir/database`'s `Database` satisfies it structurally). A channel that silently
 *     found one would be a channel that works in one app and not in another.
 *   · **Nothing expensive is enabled by a default.** Only `mail` and `database` have any claim to
 *     being free; `sms` costs money per message, so it is never implied and always written down.
 */

import { configInvalid, unknownDriver } from './errors.ts';
import { chatChannel, CHAT_DRIVERS, type ChatDriver } from './channels/chat.ts';
import { createInboxStore, databaseChannel, type InboxSql } from './channels/database.ts';
import { mailChannel } from './channels/mail.ts';
import { memoryChannel } from './channels/memory.ts';
import { smsChannel, twilioProvider } from './channels/sms.ts';
import { webhookChannel } from './channels/webhook.ts';
import type { Channel } from './channel.ts';
import type { Mailers } from '@tsir/mail';

/** The drivers this build knows, by the name a `tsir.js` writes. */
export const CHANNEL_DRIVERS = ['mail', 'database', 'webhook', 'chat', 'sms', 'memory'] as const;

export type ChannelDriverName = (typeof CHANNEL_DRIVERS)[number];

/** A string, or a reference to one in the environment. */
export type EnvRef = string | { readonly fromEnv: string };

export interface ConfiguredChannel {
  /** The driver name as written in `tsir.js`. Typed `string` for the reason above. */
  readonly driver: string;
  /** `mail`: which mailer from `mail.mailers`. Default: the default mailer. */
  readonly mailer?: string | undefined;
  /** `database`: the inbox table name. Default `notification_inbox`. */
  readonly table?: string | undefined;
  /** `webhook`: hosts a URL may point at. Required — an unfiltered webhook is an SSRF primitive. */
  readonly allowHosts?: readonly string[] | undefined;
  /** `webhook`: signs every request when set. */
  readonly secret?: EnvRef | undefined;
  readonly allowHttp?: boolean | undefined;
  /** `webhook`: static headers, e.g. an `authorization`. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** `chat`: `slack` or `discord`. */
  readonly provider?: string | undefined;
  /** `chat`: the room's incoming-webhook URL. */
  readonly url?: EnvRef | undefined;
  /** `sms`: the account id (Twilio). */
  readonly accountSid?: EnvRef | undefined;
  /** `sms`: the secret (Twilio auth token). */
  readonly authToken?: EnvRef | undefined;
  /** `sms`: the sender number or Messaging Service SID. */
  readonly from?: string | undefined;
  /** `webhook`/`chat`/`sms`: a provider endpoint override, for a proxy or a test. */
  readonly endpoint?: string | undefined;
  /** `webhook`/`chat`: request timeout. Default 10 000 ms. */
  readonly timeoutMs?: number | undefined;
}

export interface BuildChannelsOptions {
  readonly notify?:
    { readonly channels?: Readonly<Record<string, ConfiguredChannel>> | undefined } | undefined;
  /** The `mail` driver's source: the project's mailer registry. */
  readonly mailers?: Pick<Mailers, 'mailer'> | undefined;
  /** The `database` driver's source: an `InboxSql`. `Database` satisfies it structurally. */
  readonly database?: InboxSql | undefined;
  /** Where `{ fromEnv }` references are read from. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly production?: boolean | undefined;
}

function resolveRef(
  value: EnvRef | undefined,
  env: Readonly<Record<string, string | undefined>>,
  channel: string,
  setting: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;

  const found = env[value.fromEnv];
  if (found === undefined || found === '') {
    throw configInvalid(
      channel,
      `${setting} reads \`${value.fromEnv}\`, which is not set`,
      'add it to `.env` (or the environment) — a secret in `tsir.js` is refused on purpose, and an unset one must fail at boot, not at the first send',
    );
  }
  return found;
}

/** Turn one configured channel into the driver it names. */
export function channelFromConfig(
  name: string,
  config: ConfiguredChannel,
  options: Pick<BuildChannelsOptions, 'mailers' | 'database' | 'env' | 'fetch' | 'now'> = {},
): Channel {
  const env = options.env ?? {};
  const fetchOption = options.fetch === undefined ? {} : { fetch: options.fetch };

  switch (config.driver) {
    case 'memory':
      return memoryChannel({ name });

    case 'mail': {
      if (options.mailers === undefined) {
        throw configInvalid(
          name,
          "the `mail` driver needs the project's mailers",
          'pass `mailers: mailersFromConfig({…})` to `channelsFromConfig` — a notification sends through a mailer, and this package does not build one',
        );
      }
      const mailer = options.mailers.mailer(config.mailer);
      return mailChannel({ name, mailer });
    }

    case 'database': {
      if (options.database === undefined) {
        throw configInvalid(
          name,
          'the `database` driver needs a SQL port',
          "pass `database: db` to `channelsFromConfig` — `@tsir/database`'s `Database` satisfies the `InboxSql` shape structurally, and `tsir notify:schema` prints the DDL",
        );
      }
      const store = createInboxStore(
        options.database,
        config.table === undefined ? {} : { table: config.table },
      );
      return databaseChannel({
        name,
        store,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    }

    case 'webhook': {
      if (config.allowHosts === undefined || config.allowHosts.length === 0) {
        throw configInvalid(
          name,
          'the `webhook` driver needs `allowHosts`',
          'list the hosts a webhook may point at (`*.example.com` matches subdomains); the URL comes from data, so an allowlist is the SSRF guard',
        );
      }
      const secret = resolveRef(config.secret, env, name, 'secret');
      return webhookChannel({
        name,
        allowHosts: config.allowHosts,
        ...(secret === undefined ? {} : { secret }),
        ...(config.allowHttp === undefined ? {} : { allowHttp: config.allowHttp }),
        ...(config.headers === undefined ? {} : { headers: config.headers }),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...fetchOption,
      });
    }

    case 'chat': {
      const driver = (config.provider ?? 'slack') as ChatDriver;
      if (!CHAT_DRIVERS.includes(driver)) {
        throw configInvalid(
          name,
          `unknown chat provider "${String(config.provider)}"`,
          `use one of ${CHAT_DRIVERS.join(', ')}`,
        );
      }
      const url = resolveRef(config.url, env, name, 'url');
      if (url === undefined) {
        throw configInvalid(
          name,
          "the `chat` driver needs the room's `url`",
          "set `url: { fromEnv: 'SLACK_WEBHOOK_URL' }` — it belongs in the environment, not in `tsir.js`",
        );
      }
      return chatChannel({
        name,
        driver,
        url,
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...fetchOption,
      });
    }

    case 'sms': {
      const accountSid = resolveRef(config.accountSid, env, name, 'accountSid');
      const authToken = resolveRef(config.authToken, env, name, 'authToken');
      if (accountSid === undefined || authToken === undefined || config.from === undefined) {
        throw configInvalid(
          name,
          'the `sms` driver needs `accountSid`, `authToken` and `from`',
          'a paid channel is never implied: write all three down, with the two secrets as `{ fromEnv }` references',
        );
      }
      const provider = twilioProvider({
        accountSid,
        authToken,
        from: config.from,
        ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
        ...fetchOption,
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      });
      return smsChannel({ name, provider });
    }

    default:
      throw unknownDriver(config.driver, CHANNEL_DRIVERS);
  }
}

/** Every channel `notify.channels` declares, in declaration order. */
export function channelsFromConfig(options: BuildChannelsOptions): readonly Channel[] {
  const configured = options.notify?.channels;
  if (configured === undefined || Object.keys(configured).length === 0) {
    throw configInvalid(
      'notify.channels',
      'no channels are declared',
      'declare at least one (`mail`, `database`, `webhook`, `chat`, `sms`, `memory`) — a notification with nowhere to go fails at its first send',
    );
  }

  return Object.entries(configured).map(([name, config]) =>
    channelFromConfig(name, config, {
      ...(options.mailers === undefined ? {} : { mailers: options.mailers }),
      ...(options.database === undefined ? {} : { database: options.database }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );
}
