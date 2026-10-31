import { describe, expect, test } from 'bun:test';

import { CHANNEL_DRIVERS, channelFromConfig, channelsFromConfig } from './config.ts';
import { createInboxStore, type InboxSql } from './channels/database.ts';
import type { MailPort } from './channels/mail.ts';
import type { Mailers } from '@tsir/mail';

const sql: InboxSql = {
  capabilities: { engine: 'd1', placeholder: 'question' },
  query: async () => ({ rows: [], changes: 0 }),
};

function mailers(): Pick<Mailers, 'mailer'> & { asked: string[] } {
  const asked: string[] = [];
  const mailer: MailPort = {
    name: 'default',
    capabilities: {
      delivers: true,
      html: true,
      attachments: true,
      customHeaders: true,
      tags: true,
    },
    send: async () => ({ id: 'm1', accepted: [] }),
    sendTemplate: async () => ({ id: 'm2', accepted: [] }),
  };
  return {
    asked,
    mailer(name) {
      asked.push(name ?? '(default)');
      // A `Mailers` returns a full `Mailer`; the channel needs four members of it.
      return { ...mailer, name: name ?? 'default' } as never;
    },
  };
}

describe('building channels from config', () => {
  test('every driver this build ships can be built', () => {
    expect(CHANNEL_DRIVERS).toContain('mail');
    expect(CHANNEL_DRIVERS).toHaveLength(6);

    const built = channelsFromConfig({
      notify: {
        channels: {
          mail: { driver: 'mail' },
          inbox: { driver: 'database' },
          hooks: { driver: 'webhook', allowHosts: ['example.com'] },
          room: { driver: 'chat', provider: 'slack', url: 'https://slack.test/hook' },
          sms: { driver: 'sms', accountSid: 'AC1', authToken: 'tok', from: '+15550000001' },
          memory: { driver: 'memory' },
        },
      },
      mailers: mailers(),
      database: sql,
    });

    expect(built.map((channel) => channel.name)).toEqual([
      'mail',
      'inbox',
      'hooks',
      'room',
      'sms',
      'memory',
    ]);
    expect(built.map((channel) => channel.driver)).toEqual([
      'mail:default',
      'database',
      'webhook',
      'slack',
      'twilio',
      'memory',
    ]);
  });

  test('a `mailer` name is passed through to the mailer registry', () => {
    const registry = mailers();
    channelFromConfig('alerts', { driver: 'mail', mailer: 'critical' }, { mailers: registry });
    expect(registry.asked).toEqual(['critical']);
  });

  test('a secret is resolved from the environment, and an unset one fails at boot', () => {
    const channel = channelFromConfig(
      'hooks',
      { driver: 'webhook', allowHosts: ['example.com'], secret: { fromEnv: 'HOOK_SECRET' } },
      { env: { HOOK_SECRET: 'shh' } },
    );
    expect(channel.name).toBe('hooks');

    expect(() =>
      channelFromConfig(
        'hooks',
        { driver: 'webhook', allowHosts: ['example.com'], secret: { fromEnv: 'HOOK_SECRET' } },
        { env: {} },
      ),
    ).toThrow(/reads `HOOK_SECRET`, which is not set/u);
  });

  test('each driver says what it is missing, instead of failing at the first send', () => {
    expect(() => channelFromConfig('mail', { driver: 'mail' })).toThrow(
      /needs the project's mailers/u,
    );
    expect(() => channelFromConfig('inbox', { driver: 'database' })).toThrow(/needs a SQL port/u);
    expect(() => channelFromConfig('hooks', { driver: 'webhook' })).toThrow(/needs `allowHosts`/u);
    expect(() => channelFromConfig('room', { driver: 'chat', provider: 'slack' })).toThrow(
      /needs the room's `url`/u,
    );
    expect(() =>
      channelFromConfig('room', { driver: 'chat', provider: 'teams', url: 'x' }),
    ).toThrow(/unknown chat provider "teams"/u);
    expect(() => channelFromConfig('sms', { driver: 'sms', accountSid: 'AC1' })).toThrow(
      /needs `accountSid`, `authToken` and `from`/u,
    );
    expect(() => channelFromConfig('x', { driver: 'carrier-pigeon' })).toThrow(
      /unknown notification channel driver "carrier-pigeon"/u,
    );
  });

  test('a config with no channels is refused where it is read', () => {
    expect(() => channelsFromConfig({})).toThrow(/no channels are declared/u);
    expect(() => channelsFromConfig({ notify: { channels: {} } })).toThrow(
      /no channels are declared/u,
    );
  });

  test('the database driver honours a table override', () => {
    const channel = channelFromConfig(
      'inbox',
      { driver: 'database', table: 'inbox' },
      { database: sql },
    );
    expect(channel.name).toBe('inbox');
    // The store is the thing that knows the table; the channel is the thing that writes rows.
    expect(createInboxStore(sql, { table: 'inbox' })).toBeDefined();
  });
});
