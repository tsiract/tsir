/**
 * `mail.mailers` in `tsir.js` (`MAIL-9`, `§ 2.2`).
 *
 * The registry knows how to check a mailer; this module knows how to **build** one from
 * configuration, which is three things the runtime registry does not:
 *
 *   · **A driver is named by string**, so an unknown name gets `MAIL_DRIVER_MISSING` listing what
 *     this build ships — not a `TypeError` from a lookup.
 *   · **A secret is an environment reference** (`{ fromEnv: 'RESEND_API_KEY' }`) resolved here, so
 *     the "no secrets in the config file" rule is enforced by the resolver and
 *     not by a review habit.
 *   · **A binding is an object, not a string.** `cloudflare`'s transport is the `env.EMAIL` binding
 *     a Worker was handed, so it is looked up in a `bindings` map rather than read from `env` as
 *     text — a distinction that is otherwise discovered when someone puts a string in the config
 *     and the transport fails at `send`.
 */

import { configInvalid, driverMissing } from './errors.ts';
import { createMailer } from './mailer.ts';
import { createMailers, type MailerDefinition, type Mailers } from './mailers.ts';
import type { MailTemplate } from './template.ts';
import { cloudflareTransport, type CloudflareEmailBinding } from './transports/cloudflare.ts';
import { logTransport, type LogTransportOptions } from './transports/log.ts';
import { memoryTransport } from './transports/memory.ts';
import { postmarkTransport } from './transports/postmark.ts';
import { resendTransport } from './transports/resend.ts';
import { sendgridTransport } from './transports/sendgrid.ts';
import { sesTransport } from './transports/ses.ts';
import { smtpTransport, type SmtpConnector } from './transports/smtp.ts';
import type { AddressInput, MailTransport } from './port.ts';

/** The drivers this build knows, by the name a `tsir.js` writes. */
export const MAIL_DRIVERS = [
  'log',
  'memory',
  'cloudflare',
  'resend',
  'postmark',
  'sendgrid',
  'ses',
  'smtp',
] as const;

export type MailDriverName = (typeof MAIL_DRIVERS)[number];

/** A string, or a reference to one in the environment. */
export type EnvRef = string | { readonly fromEnv: string };

export interface ConfiguredMailer {
  /** The driver name as written in `tsir.js`. Typed `string` for the reason above. */
  readonly driver: string;
  /** The sender. Required for anything that delivers; `log`/`memory` default to a local address. */
  readonly from?:
    string | { readonly email: string; readonly name?: string | undefined } | undefined;
  readonly replyTo?: string | undefined;
  /** `resend`, `sendgrid`, `postmark`: `{ fromEnv: 'RESEND_API_KEY' }`. */
  readonly apiKey?: EnvRef | undefined;
  /** `postmark`: the server token, and the message stream to send on. */
  readonly serverToken?: EnvRef | undefined;
  readonly messageStream?: string | undefined;
  /** `cloudflare`: which binding in `env` is the Email Sending binding. Defaults to `EMAIL`. */
  readonly binding?: string | undefined;
  /** `ses`: the region, and the credentials to sign with. */
  readonly region?: string | undefined;
  readonly credentials?:
    | {
        readonly accessKeyId?: EnvRef | undefined;
        readonly secretAccessKey?: EnvRef | undefined;
        readonly sessionToken?: EnvRef | undefined;
      }
    | undefined;
  /** `smtp`: the server. `secure` means implicit TLS (`465`), not STARTTLS. */
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly secure?: boolean | undefined;
  readonly user?: string | undefined;
  readonly password?: EnvRef | undefined;
  /** `resend`/`postmark`/`ses`: an endpoint override, for a proxy or a test. */
  readonly endpoint?: string | undefined;
  readonly required?: boolean | undefined;
}

export interface BuildMailersOptions {
  readonly mail?:
    | {
        readonly default?: string | undefined;
        readonly mailers?: Readonly<Record<string, ConfiguredMailer>> | undefined;
      }
    | undefined;
  /** Shared by every mailer built here, so `sendTemplate` works without wiring per mailer. */
  readonly templates?: Readonly<Record<string, MailTemplate<never>>> | undefined;
  /** Where `{ fromEnv }` references are read from. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Worker bindings, by name — `{ EMAIL: env.EMAIL }`. */
  readonly bindings?: Readonly<Record<string, unknown>> | undefined;
  readonly fetch?: typeof fetch | undefined;
  /** The SMTP connector, so a probe can be driven by a scripted connection. */
  readonly smtpConnect?: SmtpConnector | undefined;
  /** Where `log` writes. Left out, `console.log`. */
  readonly log?: LogTransportOptions | undefined;
  readonly now?: (() => number) | undefined;
  readonly production?: boolean | undefined;
}

const LOCAL_SENDER = 'no-reply@tsir.local';

function resolveRef(
  value: EnvRef | undefined,
  env: Readonly<Record<string, string | undefined>>,
  mailer: string,
  setting: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;

  const found = env[value.fromEnv];
  if (found === undefined || found === '') {
    throw configInvalid(
      mailer,
      `${setting} reads \`${value.fromEnv}\`, which is not set`,
      'add it to `.env` (or the environment) — a key in `tsir.js` is refused on purpose, and an unset one must fail at boot, not at the first send',
    );
  }
  return found;
}

function isBinding(value: unknown): value is CloudflareEmailBinding {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CloudflareEmailBinding).send === 'function'
  );
}

/** Turn one configured mailer into the driver it names. */
export function transportFromConfig(
  name: string,
  config: ConfiguredMailer,
  options: Pick<
    BuildMailersOptions,
    'env' | 'bindings' | 'fetch' | 'smtpConnect' | 'log' | 'now'
  > = {},
): MailTransport {
  const env = options.env ?? {};

  switch (config.driver) {
    case 'log':
      return logTransport(options.log ?? {});

    case 'memory':
      return memoryTransport();

    case 'cloudflare': {
      const bindingName = config.binding ?? 'EMAIL';
      const binding = options.bindings?.[bindingName];
      if (!isBinding(binding)) {
        throw configInvalid(
          name,
          `the \`cloudflare\` driver needs the "${bindingName}" binding`,
          `pass it in \`bindings: { ${bindingName}: env.${bindingName} }\` — the Email Sending binding is an object, not a string, and a Worker has no other way to reach it`,
        );
      }
      return cloudflareTransport({ binding });
    }

    case 'resend': {
      const apiKey = resolveRef(config.apiKey, env, name, 'apiKey');
      if (apiKey === undefined) {
        throw configInvalid(
          name,
          'the `resend` driver needs an `apiKey`',
          "set `apiKey: { fromEnv: 'RESEND_API_KEY' }` — the key never belongs in `tsir.js`",
        );
      }
      return resendTransport({
        apiKey,
        ...(config.endpoint === undefined ? {} : { baseUrl: config.endpoint }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    }

    case 'postmark': {
      const serverToken = resolveRef(config.serverToken, env, name, 'serverToken');
      if (serverToken === undefined) {
        throw configInvalid(
          name,
          'the `postmark` driver needs a `serverToken`',
          "set `serverToken: { fromEnv: 'POSTMARK_SERVER_TOKEN' }`, and `messageStream` too if the account is split into streams",
        );
      }
      return postmarkTransport({
        serverToken,
        ...(config.messageStream === undefined ? {} : { messageStream: config.messageStream }),
        ...(config.endpoint === undefined ? {} : { baseUrl: config.endpoint }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    }

    case 'sendgrid': {
      const apiKey = resolveRef(config.apiKey, env, name, 'apiKey');
      if (apiKey === undefined) {
        throw configInvalid(
          name,
          'the `sendgrid` driver needs an `apiKey`',
          "set `apiKey: { fromEnv: 'SENDGRID_API_KEY' }` — the value never belongs in `tsir.js`",
        );
      }
      return sendgridTransport({
        apiKey,
        ...(config.endpoint === undefined ? {} : { baseUrl: config.endpoint }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    }

    case 'ses': {
      const region = config.region ?? 'us-east-1';
      const accessKeyId = resolveRef(
        config.credentials?.accessKeyId,
        env,
        name,
        'credentials.accessKeyId',
      );
      const secretAccessKey = resolveRef(
        config.credentials?.secretAccessKey,
        env,
        name,
        'credentials.secretAccessKey',
      );
      if (accessKeyId === undefined || secretAccessKey === undefined) {
        throw configInvalid(
          name,
          'the `ses` driver needs credentials',
          'set `credentials.accessKeyId` and `credentials.secretAccessKey` as `{ fromEnv: … }` references, and `region` to the SES region',
        );
      }
      const sessionToken = resolveRef(
        config.credentials?.sessionToken,
        env,
        name,
        'credentials.sessionToken',
      );
      return sesTransport({
        region,
        credentials: {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken === undefined ? {} : { sessionToken }),
        },
        ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    }

    case 'smtp': {
      if (config.host === undefined || config.host === '') {
        throw configInvalid(
          name,
          'the `smtp` driver needs a `host`',
          'set `host` (and usually `port: 587`) — `secure: true` is implicit TLS on 465, which is a different thing from STARTTLS',
        );
      }
      const password = resolveRef(config.password, env, name, 'password');
      if (config.user !== undefined && password === undefined) {
        throw configInvalid(
          name,
          '`user` is set and `password` is not',
          "set `password: { fromEnv: 'SMTP_PASSWORD' }` — half a credential is refused rather than sent as an empty one",
        );
      }
      return smtpTransport({
        host: config.host,
        ...(config.port === undefined ? {} : { port: config.port }),
        ...(config.secure === undefined ? {} : { secure: config.secure }),
        ...(config.user === undefined || password === undefined
          ? {}
          : { auth: { user: config.user, pass: password } }),
        ...(options.smtpConnect === undefined ? {} : { connect: options.smtpConnect }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    }

    default:
      throw driverMissing(name, config.driver, MAIL_DRIVERS);
  }
}

/**
 * Build the registry from `tsir.js`.
 *
 * A project with no `mail` block gets a `log` default, which is what makes `tsir mail:test` runnable
 * in a fresh project — and what `production: true` refuses, because a mailer whose messages go to a
 * terminal is a project whose password resets go nowhere.
 */
export function mailersFromConfig(options: BuildMailersOptions = {}): Mailers {
  const declared = options.mail?.mailers;
  const templates = options.templates ?? {};

  const mailers: Record<string, MailerDefinition> = {};

  if (declared === undefined || Object.keys(declared).length === 0) {
    mailers['default'] = {
      mailer: createMailer({
        name: 'default',
        transport: logTransport(options.log ?? {}),
        from: LOCAL_SENDER,
        templates,
      }),
    };
    return createMailers({
      mailers,
      default: 'default',
      ...(options.production === undefined ? {} : { production: options.production }),
    });
  }

  for (const [name, config] of Object.entries(declared)) {
    const transport = transportFromConfig(name, config, options);
    const from: AddressInput =
      config.from ??
      (transport.capabilities.delivers
        ? (() => {
            throw configInvalid(
              name,
              'the mailer has no `from` address',
              `set \`from: 'Your App <no-reply@your-domain>' \` — a provider rejects an unverified sender, and the message that fails is the one a customer was waiting for`,
            );
          })()
        : LOCAL_SENDER);

    mailers[name] = {
      mailer: createMailer({
        name,
        transport,
        from,
        ...(config.replyTo === undefined ? {} : { replyTo: [config.replyTo] }),
        templates,
      }),
      ...(config.required === undefined ? {} : { required: config.required }),
    };
  }

  // `mail.default` wins; otherwise a mailer named `default`; otherwise a project that declares
  // exactly one mailer gets it by default — which is the common case and the only one where
  // guessing cannot pick the wrong sender. Two mailers and no default is an error listing them.
  const declaredNames = Object.keys(declared);
  const defaultName =
    options.mail?.default ??
    (declaredNames.includes('default')
      ? 'default'
      : declaredNames.length === 1
        ? declaredNames[0]
        : 'default');

  return createMailers({
    mailers,
    default: defaultName,
    ...(options.production === undefined ? {} : { production: options.production }),
  });
}
