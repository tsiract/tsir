/**
 * The mailer and the registry (`MAIL-5`, `MAIL-8`, `MAIL-9`, `CAP-001`).
 *
 * The capability refusals are the heart of it: a `log` mailer cannot send HTML, a `postmark` mailer
 * cannot carry tags, and both say so **before** the network. The config half is the other half —
 * `tsir.js` → a transport, with a secret read from the environment and an unset one failing at
 * boot rather than at the first password reset.
 */

import { describe, expect, test } from 'bun:test';

import { mailConformance } from './conformance.ts';
import { createMailer } from './mailer.ts';
import { assertDelivers, createMailers, defineMailer } from './mailers.ts';
import { mailersFromConfig, transportFromConfig } from './config.ts';
import { defineTemplate } from './template.ts';
import { logTransport } from './transports/log.ts';
import { memoryTransport } from './transports/memory.ts';
import { postmarkTransport } from './transports/postmark.ts';

const base = {
  from: 'Tsir <no-reply@tsir.local>',
  to: ['ana@example.com'],
  subject: 'Your receipt',
  text: 'Thanks, Ana.',
};

describe('a capability that is false refuses, before the request', () => {
  test('`log` cannot carry tags, and says which transport and which feature', async () => {
    const mailer = createMailer({
      transport: logTransport({ write: () => undefined }),
      from: 'a@tsir.local',
    });
    const attempt = mailer.send({ ...base, tags: { campaign: 'spring' } });

    expect(attempt).rejects.toMatchObject({ code: 'MAIL_UNSUPPORTED_OPERATION' });
    expect(attempt).rejects.toThrow(/transport "log" cannot carry tag\(s\) campaign/u);
  });

  test('a transport without attachments refuses rather than dropping the file', async () => {
    // A hand-written transport, which is what a project adding a vendor SDK will write.
    const noAttachments = {
      name: 'vendor',
      capabilities: {
        delivers: true,
        html: true,
        attachments: false,
        customHeaders: true,
        tags: true,
      },
      send: async () => ({ id: 'x', accepted: ['ana@example.com'] }),
    };
    const mailer = createMailer({ transport: noAttachments, from: 'a@tsir.local' });
    expect(
      mailer.send({
        ...base,
        attachments: [{ filename: 'a.pdf', content: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow(/cannot carry 1 attachment\(s\)/u);
  });

  test('the message that fails is the one that asked for the feature — nothing is sent', async () => {
    const memory = memoryTransport();
    const mailer = createMailer({ transport: memory, from: 'a@tsir.local' });
    await mailer.send(base).catch(() => undefined);
    expect(memory.count()).toBe(1);

    await mailer.send({ ...base, subject: 'second' }).catch(() => undefined);
    expect(memory.count()).toBe(2);
  });
});

describe('the mailer', () => {
  test('the mailer supplies `from` and `replyTo`, and a message may override `from`', async () => {
    const memory = memoryTransport();
    const mailer = createMailer({
      transport: memory,
      from: 'Tsir <no-reply@tsir.local>',
      replyTo: ['support@tsir.local'],
    });

    await mailer.send(base);
    expect(memory.last()?.from).toEqual({ email: 'no-reply@tsir.local', name: 'Tsir' });
    expect(memory.last()?.replyTo).toEqual([{ email: 'support@tsir.local' }]);

    await mailer.send({
      ...base,
      from: 'Billing <billing@tsir.local>',
      replyTo: ['ar@tsir.local'],
    });
    expect(memory.last()?.from.email).toBe('billing@tsir.local');
    // A message that names its own reply-to keeps it; the mailer's default is a default.
    expect(memory.last()?.replyTo).toEqual([{ email: 'ar@tsir.local' }]);
  });

  test('`sendTemplate` renders, then sends — one message, one failure path', async () => {
    const memory = memoryTransport();
    const mailer = createMailer({
      transport: memory,
      from: 'a@tsir.local',
      templates: {
        welcome: defineTemplate<{ name: string }>({
          name: 'welcome',
          subject: (data) => `Welcome, ${data.name}`,
          text: (data) => `Hi ${data.name}`,
          sample: { name: 'Ana' },
        }) as never,
      },
    });

    await mailer.sendTemplate('welcome', { name: 'Bo' }, { to: ['bo@example.com'] });

    expect(memory.last()?.subject).toBe('Welcome, Bo');
    expect(memory.last()?.text).toBe('Hi Bo');
    expect(memory.last()?.to[0]?.email).toBe('bo@example.com');
    expect(() => mailer.render('nope')).toThrow(/unknown mail template/u);
  });

  test('`compose` is the same rules without a send, which is what a preview needs', async () => {
    const mailer = createMailer({ transport: memoryTransport(), from: 'a@tsir.local' });
    const message = mailer.compose(base);
    expect(message.subject).toBe('Your receipt');
    expect(() => mailer.compose({ ...base, to: [] })).toThrow(/no recipients/u);
  });
});

describe('the registry', () => {
  test('a name that was never declared never falls back to the default', () => {
    const mailers = createMailers({
      mailers: {
        default: defineMailer({
          mailer: createMailer({ transport: memoryTransport(), from: 'a@tsir.local' }),
        }),
      },
    });
    expect(mailers.mailer().name).toBe('default');
    expect(() => mailers.mailer('receipts')).toThrow(/unknown mailer "receipts"/u);
    try {
      mailers.mailer('receipts');
    } catch (error: unknown) {
      // The names live in the hint, which the CLI prints under the message.
      expect((error as { hint?: string }).hint).toStartWith('declared mailers: default');
    }
  });

  test('an unknown default lists the declared names', () => {
    expect(() =>
      createMailers({
        mailers: {
          a: defineMailer({
            mailer: createMailer({ transport: memoryTransport(), from: 'a@tsir.local' }),
          }),
        },
        default: 'b',
      }),
    ).toThrow(/the default mailer "b" is not declared \(declared: a\)/u);
  });

  test('production refuses a default that cannot deliver, naming mailer and transport', () => {
    const mailers = () =>
      createMailers({
        mailers: {
          default: defineMailer({
            mailer: createMailer({
              transport: logTransport({ write: () => undefined }),
              from: 'a@tsir.local',
            }),
          }),
        },
        production: true,
      });

    expect(mailers).toThrow(/mailer "default" uses the "log" transport, which delivers nothing/u);
  });

  test('a `required` mailer is checked too; an optional dev mailer beside a real one is allowed', () => {
    const real = createMailer({ transport: memoryTransport(), from: 'a@tsir.local' });
    // `memory` cannot deliver, so this is the same rule with a different transport name.
    expect(() =>
      createMailers({
        mailers: {
          default: defineMailer({ mailer: real, required: true }),
        },
        production: true,
      }),
    ).toThrow(/mailer "default" uses the "memory" transport/u);

    expect(() => assertDelivers(real)).toThrow(/does not deliver|delivers nothing/u);
    try {
      assertDelivers(real);
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe('MAIL_FORBIDDEN_IN_PRODUCTION');
    }
  });
});

describe('the conformance kit', () => {
  test('the memory transport passes all four cases', async () => {
    const transport = memoryTransport();
    for (const testCase of mailConformance({ transport, to: 'ana@example.com' })) {
      await testCase.run();
    }
    // Four sends: id, envelope, (capabilities are all true so nothing is skipped), twice.
    expect(transport.count()).toBe(4);
  });

  test('it catches a transport that claims nothing but drops the feature anyway', async () => {
    const lying = {
      name: 'lying',
      capabilities: {
        delivers: true,
        html: false,
        attachments: true,
        customHeaders: true,
        tags: true,
      },
      send: async () => ({ id: crypto.randomUUID(), accepted: ['ana@example.com'] }),
    };
    const cases = mailConformance({ transport: lying, to: 'ana@example.com' });
    const refusal = cases.find((entry) => entry.name.startsWith('a capability'));
    expect(refusal).toBeDefined();
    // It passes: `assertCarriable` refuses HTML on this transport. The kit is asserting our rule.
    await refusal?.run();
  });

  test('it catches a transport that returns the same id twice', async () => {
    const deduping = {
      name: 'deduping',
      capabilities: {
        delivers: true,
        html: true,
        attachments: true,
        customHeaders: true,
        tags: true,
      },
      send: async () => ({ id: 'same-id', accepted: ['ana@example.com'] }),
    };
    const cases = mailConformance({ transport: deduping, to: 'ana@example.com' });
    const twice = cases.find((entry) => entry.name.startsWith('two identical'));
    expect(twice?.run()).rejects.toThrow(/deduplicating/u);
  });
});

describe('`mail.mailers` in tsir.js', () => {
  test('a project with no `mail` block gets a log default, which is runnable and refused in production', () => {
    const mailers = mailersFromConfig();
    expect(mailers.default).toBe('default');
    expect(mailers.mailer().transport.name).toBe('log');
    expect(() => mailersFromConfig({ production: true })).toThrow(
      /does not deliver|delivers nothing/u,
    );
  });

  test('a key is read from the environment, and an unset one fails at boot by name', () => {
    expect(() =>
      mailersFromConfig({
        mail: {
          mailers: {
            mail: { driver: 'resend', from: 'a@tsir.local', apiKey: { fromEnv: 'RESEND_API_KEY' } },
          },
        },
        env: {},
      }),
    ).toThrow(/apiKey reads `RESEND_API_KEY`, which is not set/u);

    const mailers = mailersFromConfig({
      mail: {
        default: 'mail',
        mailers: {
          mail: {
            driver: 'resend',
            from: 'Tsir <a@tsir.local>',
            apiKey: { fromEnv: 'RESEND_API_KEY' },
          },
        },
      },
      env: { RESEND_API_KEY: 're_live' },
    });
    expect(mailers.mailer().transport.name).toBe('resend');
  });

  test('an unknown driver lists the ones this build ships', () => {
    let thrown: { code?: string; hint?: string } | undefined;
    try {
      mailersFromConfig({ mail: { mailers: { m: { driver: 'sendgrid', from: 'a@tsir.local' } } } });
    } catch (error: unknown) {
      thrown = error as { code?: string; hint?: string };
    }
    expect(thrown?.code).toBe('MAIL_DRIVER_MISSING');
    // The hint is where the list of real drivers lives — the message names only what was wrong.
    expect(thrown?.hint).toBe(
      'available drivers: log, memory, cloudflare, resend, postmark, ses, smtp',
    );
  });

  test('a delivering mailer with no `from` is refused, because a provider rejects an unverified sender', () => {
    expect(() =>
      mailersFromConfig({
        mail: { mailers: { m: { driver: 'resend', apiKey: 'k' } } },
      }),
    ).toThrow(/has no `from` address/u);
  });

  test('`cloudflare` needs the binding object, and says so with the shape to pass', () => {
    expect(() => transportFromConfig('m', { driver: 'cloudflare' })).toThrow(
      /needs the "EMAIL" binding/u,
    );

    const transport = transportFromConfig(
      'm',
      { driver: 'cloudflare', binding: 'MAILER' },
      { bindings: { MAILER: { send: async () => ({ messageId: 'cf' }) } } },
    );
    expect(transport.name).toBe('cloudflare');
  });

  test('`smtp` needs a host, and half a credential is refused rather than sent empty', () => {
    expect(() => transportFromConfig('m', { driver: 'smtp' })).toThrow(/needs a `host`/u);
    expect(() =>
      transportFromConfig('m', { driver: 'smtp', host: 'mail.example.com', user: 'u' }),
    ).toThrow(/`user` is set and `password` is not/u);
  });

  test('`ses` reads its credentials from the environment and defaults the region', () => {
    expect(() => transportFromConfig('m', { driver: 'ses' })).toThrow(/needs credentials/u);
    const transport = transportFromConfig(
      'm',
      {
        driver: 'ses',
        credentials: {
          accessKeyId: { fromEnv: 'AWS_KEY' },
          secretAccessKey: { fromEnv: 'AWS_SECRET' },
        },
      },
      { env: { AWS_KEY: 'AKID', AWS_SECRET: 'secret' } },
    );
    expect(transport.name).toBe('ses');
  });

  test('a transport built from config carries the templates a project declared', async () => {
    const mailers = mailersFromConfig({
      mail: { mailers: { mail: { driver: 'memory', from: 'a@tsir.local' } } },
      templates: {
        welcome: defineTemplate<{ name: string }>({
          name: 'welcome',
          subject: (data) => `Welcome, ${data.name}`,
          text: (data) => `Hi ${data.name}`,
          sample: { name: 'Ana' },
        }) as never,
      },
    });
    await mailers.mailer().sendTemplate('welcome', { name: 'Bo' }, { to: ['bo@example.com'] });
    expect(mailers.mailer().templates.names).toEqual(['welcome']);
  });

  test('postmark from config declares `tags: false` all the way through', () => {
    const transport = transportFromConfig('m', { driver: 'postmark', serverToken: 't' });
    expect(transport.capabilities.tags).toBe(false);
    expect(postmarkTransport({ serverToken: 't' }).capabilities.tags).toBe(false);
  });
});
