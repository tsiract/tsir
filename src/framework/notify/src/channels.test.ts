import { describe, expect, test } from 'bun:test';

import { chatBody, chatChannel } from './channels/chat.ts';
import {
  createInboxStore,
  databaseChannel,
  inboxTableDdl,
  parseInboxPayload,
  type InboxSql,
} from './channels/database.ts';
import { mailChannel, parseMailPayload, type MailPort } from './channels/mail.ts';
import { memoryChannel } from './channels/memory.ts';
import { parseSms, smsChannel, twilioProvider } from './channels/sms.ts';
import { checkUrl, hostAllowed, webhookBody, webhookChannel } from './channels/webhook.ts';
import { verifySignature } from './signing.ts';
import type { ChannelDelivery } from './channel.ts';

const to = {
  id: 'u1',
  email: 'ana@example.com',
  phone: '+639171234567',
  webhookUrl: 'https://hooks.example.com/in',
};

function delivery(payload: unknown, at = 1_700_000_000_000): ChannelDelivery {
  return { deliveryId: 'd1:chan', notification: 'order.shipped', to, payload, at };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch that records the request and answers what the test says. */
function recordingFetch(answer: () => Response): {
  readonly fetch: typeof fetch;
  readonly requests: readonly { url: string; body: string; headers: Record<string, string> }[];
} {
  const requests: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
        headers[key] = value;
      }
    }
    const body = init?.body;
    requests.push({ url, body: typeof body === 'string' ? body : '', headers });
    return answer();
  }) as unknown as typeof fetch;
  return { fetch: fake, requests };
}

// ─── mail ──────────────────────────────────────────────────────────────────

function fakeMailer(): MailPort & {
  readonly sent: { kind: string; payload: unknown }[];
} {
  const sent: { kind: string; payload: unknown }[] = [];
  return {
    name: 'fake',
    capabilities: {
      delivers: true,
      html: true,
      attachments: true,
      customHeaders: true,
      tags: true,
    },
    sent,
    send: async (input) => {
      sent.push({ kind: 'send', payload: input });
      return { id: 'msg-1', accepted: ['ana@example.com'] };
    },
    sendTemplate: async (name, data, input) => {
      sent.push({ kind: 'template', payload: { name, data, input } });
      return { id: 'msg-2', accepted: ['ana@example.com'] };
    },
  };
}

describe('the mail channel', () => {
  test('an ordinary payload becomes one message with the notifiable as its recipient', async () => {
    const mailer = fakeMailer();
    const channel = mailChannel({ mailer });

    const result = await channel.send(delivery({ subject: 'Shipped', text: 'On its way' }));

    expect(result.accepted).toBe(true);
    expect(result.id).toBe('msg-1');
    expect(mailer.sent[0]?.payload).toMatchObject({
      to: ['ana@example.com'],
      subject: 'Shipped',
      text: 'On its way',
    });
  });

  test('a template payload renders at send time, in the mailer', async () => {
    const mailer = fakeMailer();
    const channel = mailChannel({ mailer });

    await channel.send(
      delivery({
        subject: 'ignored',
        template: 'welcome',
        data: { name: 'Ana' },
        replyTo: 'hi@example.com',
      }),
    );

    expect(mailer.sent[0]?.kind).toBe('template');
    expect(mailer.sent[0]?.payload).toMatchObject({
      name: 'welcome',
      data: { name: 'Ana' },
      input: { to: ['ana@example.com'], replyTo: ['hi@example.com'] },
    });
  });

  test('a recipient with no email is a refusal naming the field', async () => {
    const channel = mailChannel({ mailer: fakeMailer() });
    const anonymous: ChannelDelivery = {
      deliveryId: 'd',
      notification: 'order.shipped',
      to: { id: 'u2' },
      payload: { subject: 's', text: 't' },
      at: 1,
    };
    expect(channel.send(anonymous)).rejects.toThrow(/needs a recipient with `email`/u);
  });

  test('the payload is checked before it is queued, and the three body forms are exclusive', () => {
    expect(parseMailPayload({ subject: 's', text: 't' })).toEqual({ subject: 's', text: 't' });
    expect(() => parseMailPayload({ subject: 's' })).toThrow(/a body is required/u);
    expect(() => parseMailPayload({ subject: 's', text: 't', html: '<p/>' })).toThrow(
      /are alternatives — pick one/u,
    );
    expect(() => parseMailPayload({ text: 't' })).toThrow(/`subject` must be a non-empty string/u);
    expect(() => parseMailPayload('nope')).toThrow(/the payload is not an object/u);
  });

  test('the mailer’s own failure is reported with the channel and the notification', async () => {
    const broken: MailPort = {
      ...fakeMailer(),
      send: async () => {
        throw new Error('the provider rejected the domain');
      },
    };
    const channel = mailChannel({ mailer: broken });
    try {
      await channel.send(delivery({ subject: 's', text: 't' }));
    } catch (error: unknown) {
      const typed = error as { code: string; message: string };
      expect(typed.code).toBe('NOTIFY_DELIVERY_FAILED');
      expect(typed.message).toContain('the provider rejected the domain');
    }
  });
});

// ─── database ──────────────────────────────────────────────────────────────

function fakeSql(engine: 'd1' | 'postgres'): InboxSql & {
  readonly statements: { sql: string; params: readonly unknown[] }[];
  readonly rows: unknown[];
} {
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const rows: unknown[] = [];
  return {
    capabilities: {
      engine,
      placeholder: engine === 'postgres' ? 'dollar' : 'question',
    },
    statements,
    rows,
    query: async (statement) => {
      statements.push(statement);
      return { rows: rows, changes: 1 };
    },
  };
}

describe('the database channel and its inbox store', () => {
  test('a delivery is one row whose id is the delivery id, so a retry cannot duplicate it', async () => {
    const sql = fakeSql('d1');
    const channel = databaseChannel({ store: createInboxStore(sql), now: () => 42 });

    const result = await channel.send(
      delivery({
        title: 'Shipped',
        body: 'Track it',
        url: '/orders/1',
        level: 'success',
        data: { id: 'ord_1' },
      }),
    );

    expect(result.id).toBe('d1:chan');
    const statement = sql.statements[0];
    expect(statement?.sql).toContain('INSERT OR IGNORE INTO notification_inbox');
    expect(statement?.sql).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    expect(statement?.params).toEqual([
      'd1:chan',
      'order.shipped',
      'u1',
      'Shipped',
      'Track it',
      '/orders/1',
      'success',
      '{"id":"ord_1"}',
      null,
      42,
    ]);
  });

  test('on Postgres the same insert is ON CONFLICT DO NOTHING with numbered placeholders', async () => {
    const sql = fakeSql('postgres');
    const store = createInboxStore(sql);
    await store.insert({
      id: 'row-1',
      notification: 'order.shipped',
      notifiableId: 'u1',
      title: 't',
      body: null,
      url: null,
      level: 'info',
      data: null,
      createdAt: 1,
    });
    expect(sql.statements[0]?.sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(sql.statements[0]?.sql).toContain('VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)');
  });

  test('list maps a row back, and unread counts whatever the driver gave it', async () => {
    const sql = fakeSql('postgres');
    sql.rows.push({
      id: 'row-1',
      notification: 'order.shipped',
      notifiable_id: 'u1',
      title: 'Shipped',
      body: null,
      url: '/orders/1',
      level: 'nonsense',
      data: '{"a":1}',
      created_at: '7',
    });
    const store = createInboxStore(sql);

    const rows = await store.list('u1', 5);
    expect(rows[0]).toEqual({
      id: 'row-1',
      notification: 'order.shipped',
      notifiableId: 'u1',
      title: 'Shipped',
      body: null,
      url: '/orders/1',
      level: 'info',
      data: '{"a":1}',
      createdAt: 7,
    });
    expect(sql.statements[0]?.sql).toContain('ORDER BY created_at DESC LIMIT 5');

    sql.rows.length = 0;
    sql.rows.push({ unread: 3 });
    expect(await store.unread('u1')).toBe(3);
    sql.rows.length = 0;
    sql.rows.push({ unread: '4' });
    expect(await store.unread('u1')).toBe(4);
    sql.rows.length = 0;
    sql.rows.push({ unread: 5n });
    expect(await store.unread('u1')).toBe(5);
    sql.rows.length = 0;
    expect(await store.unread('u1')).toBe(0);
  });

  test('the DDL says what it creates, for each engine', () => {
    const d1 = inboxTableDdl({ engine: 'd1' }).join('\n');
    const pg = inboxTableDdl({ engine: 'postgres', table: 'inbox' }).join('\n');
    expect(d1).toContain('CREATE TABLE IF NOT EXISTS notification_inbox');
    expect(d1).toContain('created_at INTEGER NOT NULL');
    expect(d1).toContain('CREATE INDEX IF NOT EXISTS notification_inbox_inbox');
    expect(pg).toContain('CREATE TABLE IF NOT EXISTS inbox');
    expect(pg).toContain('created_at BIGINT NOT NULL');
  });

  test('a row needs a notifiable id, and the payload needs a title', async () => {
    const channel = databaseChannel({ store: createInboxStore(fakeSql('d1')) });
    const noId: ChannelDelivery = {
      deliveryId: 'd',
      notification: 'order.shipped',
      to: { email: 'ana@example.com' },
      payload: { title: 't' },
      at: 1,
    };
    expect(channel.send(noId)).rejects.toThrow(/needs a recipient with `id`/u);
    expect(() => parseInboxPayload({ title: '' })).toThrow(/`title` must be a non-empty string/u);
    expect(() => parseInboxPayload({ title: 't', level: 'loud' })).toThrow(
      /`level` must be one of/u,
    );
    expect(() => parseInboxPayload({ title: 't', data: 'x' })).toThrow(
      /`data` must be a JSON object/u,
    );
  });

  test('a store failure is a coded delivery failure', async () => {
    const failing: InboxSql = {
      capabilities: { engine: 'd1', placeholder: 'question' },
      query: async () => {
        throw new Error('D1_ERROR: no such table');
      },
    };
    const channel = databaseChannel({ store: createInboxStore(failing) });
    expect(channel.send(delivery({ title: 't' }))).rejects.toThrow(/no such table/u);
  });
});

// ─── memory ────────────────────────────────────────────────────────────────

describe('the memory channel', () => {
  test('records everything, finds by notification, and reaches nobody', async () => {
    const channel = memoryChannel();
    expect(channel.capabilities.delivers).toBe(false);

    await channel.send(delivery({ any: 'thing' }));
    await channel.send({ ...delivery({ other: 1 }), notification: 'auth.reset' });

    expect(channel.sent()).toHaveLength(2);
    expect(channel.last()?.notification).toBe('auth.reset');
    expect(channel.find('order.shipped')).toHaveLength(1);
    channel.clear();
    expect(channel.sent()).toEqual([]);
    expect(channel.last()).toBeUndefined();
  });

  test('a strict memory channel refuses what a real inbox would', () => {
    const strict = memoryChannel({ permissive: false });
    expect(strict.capabilities).toEqual({ delivers: false, html: false, attachments: false });
  });
});

// ─── webhook ───────────────────────────────────────────────────────────────

describe('the webhook channel', () => {
  test('a signed POST carries the event, the delivery id and the payload', async () => {
    const recorder = recordingFetch(() => jsonResponse({ ok: true }, 202));
    const channel = webhookChannel({
      allowHosts: ['hooks.example.com'],
      secret: 'shh',
      fetcher: recorder.fetch,
    });

    const result = await channel.send(
      delivery({ body: { orderId: 'ord_1' }, event: 'order.shipped' }),
    );

    expect(result.accepted).toBe(true);
    expect(result.id).toBe('http-202');

    const request = recorder.requests[0];
    expect(request?.url).toBe('https://hooks.example.com/in');
    expect(JSON.parse(request?.body ?? '{}')).toEqual({
      event: 'order.shipped',
      notification: 'order.shipped',
      deliveryId: 'd1:chan',
      data: { orderId: 'ord_1' },
    });
    expect(request?.headers['x-tsir-delivery']).toBe('d1:chan');

    const signature = request?.headers['x-tsir-signature'] ?? '';
    expect(
      await verifySignature({
        header: signature,
        body: request?.body ?? '',
        secret: 'shh',
        now: 1_700_000_000_000,
      }),
    ).toBe(true);
  });

  test('the URL is checked: protocol, credentials, and the allowlist', () => {
    const allow = ['hooks.example.com', '*.example.org'];
    expect(checkUrl('https://hooks.example.com/x', allow, false, 'webhook')).toBe(
      'https://hooks.example.com/x',
    );
    expect(() => checkUrl('http://hooks.example.com/x', allow, false, 'webhook')).toThrow(
      /https is required/u,
    );
    expect(() =>
      checkUrl('https://user:pass@hooks.example.com/x', allow, false, 'webhook'),
    ).toThrow(/carries credentials/u);
    expect(() => checkUrl('https://169.254.169.254/latest', allow, false, 'webhook')).toThrow(
      /is not on the webhook channel's allowlist/u,
    );
    expect(() => checkUrl('not a url', allow, false, 'webhook')).toThrow(/not an absolute URL/u);
    // `http:` is allowed only when the project says so — a local receiver in development.
    expect(checkUrl('http://localhost:3000/x', ['localhost'], true, 'webhook')).toBe(
      'http://localhost:3000/x',
    );
  });

  test('the allowlist understands one wildcard level, and nothing else', () => {
    expect(hostAllowed('api.example.org', ['*.example.org'])).toBe(true);
    expect(hostAllowed('a.b.example.org', ['*.example.org'])).toBe(true);
    expect(hostAllowed('example.org', ['*.example.org'])).toBe(false);
    expect(hostAllowed('evilexample.org', ['*.example.org'])).toBe(false);
    expect(hostAllowed('example.org', ['EXAMPLE.org'])).toBe(true);
    expect(hostAllowed('example.org', [''])).toBe(false);
  });

  test('a channel with no allowlist cannot be built at all', () => {
    expect(() => webhookChannel({ allowHosts: [] })).toThrow(
      /needs at least one allowlisted host/u,
    );
  });

  test('a recipient URL is used when the payload has none, and neither is a refusal', async () => {
    const recorder = recordingFetch(() => jsonResponse({}, 200));
    const channel = webhookChannel({ allowHosts: ['hooks.example.com'], fetcher: recorder.fetch });

    await channel.send(delivery({ body: { a: 1 } }));
    expect(recorder.requests[0]?.url).toBe('https://hooks.example.com/in');

    const noUrl: ChannelDelivery = {
      deliveryId: 'd',
      notification: 'order.shipped',
      to: { id: 'u1' },
      payload: { body: { a: 1 } },
      at: 1,
    };
    expect(channel.send(noUrl)).rejects.toThrow(/no `url` in the payload and no `webhookUrl`/u);
  });

  test('a non-2xx answer is a delivery failure carrying the status', async () => {
    const recorder = recordingFetch(() => new Response('nope', { status: 500 }));
    const channel = webhookChannel({ allowHosts: ['hooks.example.com'], fetcher: recorder.fetch });

    try {
      await channel.send(delivery({ body: { a: 1 } }));
    } catch (error: unknown) {
      const typed = error as { code: string; message: string };
      expect(typed.code).toBe('NOTIFY_DELIVERY_FAILED');
      expect(typed.message).toContain('HTTP 500');
    }
  });

  test('a request that never answers is a timeout, not a hung worker', async () => {
    const hanging = (async (_input: string | URL | Request, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
      throw new Error('unreachable');
    }) as unknown as typeof fetch;

    const channel = webhookChannel({
      allowHosts: ['hooks.example.com'],
      fetcher: hanging,
      timeoutMs: 5,
    });
    expect(channel.send(delivery({ body: { a: 1 } }))).rejects.toThrow(/timed out after 5 ms/u);
  });

  test('the body a receiver gets is documented, and a non-object body is refused first', () => {
    expect(
      webhookBody(
        { notification: 'order.shipped', deliveryId: 'd', payload: {} },
        { body: { a: 1 } },
      ),
    ).toBe(
      '{"event":"order.shipped","notification":"order.shipped","deliveryId":"d","data":{"a":1}}',
    );

    const channel = webhookChannel({ allowHosts: ['hooks.example.com'] });
    expect(() => channel.check?.({ body: 'nope' })).toThrow(/`body` must be a JSON object/u);
    expect(() => channel.check?.({ body: {}, url: 7 })).toThrow(/`url` must be a string/u);
    expect(() => channel.check?.({ body: {}, event: 7 })).toThrow(/`event` must be a string/u);
  });
});

// ─── chat ──────────────────────────────────────────────────────────────────

describe('the chat channel', () => {
  test('slack reads `text` and discord reads `content`, from the same payload', async () => {
    expect(chatBody('slack', { text: 'hi' })).toEqual({ text: 'hi' });
    expect(chatBody('discord', { text: 'hi' })).toEqual({ content: 'hi' });
    expect(chatBody('slack', { text: 'hi', url: 'https://x.test' })).toEqual({
      text: 'hi\nhttps://x.test',
    });

    const recorder = recordingFetch(() => jsonResponse({ ok: true }, 204));
    const channel = chatChannel({
      driver: 'discord',
      url: 'https://discord.test/hook',
      fetcher: recorder.fetch,
    });
    const result = await channel.send(delivery({ text: 'deployed' }));

    expect(result.accepted).toBe(true);
    expect(JSON.parse(recorder.requests[0]?.body ?? '{}')).toEqual({ content: 'deployed' });
    expect(channel.driver).toBe('discord');
  });

  test('an empty message is refused, and a room with no URL cannot be built', () => {
    const channel = chatChannel({ driver: 'slack', url: 'https://slack.test/hook' });
    expect(() => channel.check?.({ text: '   ' })).toThrow(/`text` must be a non-empty string/u);
    expect(() => channel.check?.('nope')).toThrow(/the payload is not an object/u);
    expect(() => chatChannel({ driver: 'slack', url: '' })).toThrow(
      /needs the room's incoming-webhook/u,
    );
  });

  test('a room that answers 404 is a delivery failure', async () => {
    const recorder = recordingFetch(() => new Response('unknown_hook', { status: 404 }));
    const channel = chatChannel({
      driver: 'slack',
      url: 'https://slack.test/hook',
      fetcher: recorder.fetch,
    });
    expect(channel.send(delivery({ text: 'x' }))).rejects.toThrow(/HTTP 404/u);
  });
});

// ─── sms ───────────────────────────────────────────────────────────────────

describe('the sms channel', () => {
  test('the notifiable’s phone is used when the payload names none, and E.164 is enforced', async () => {
    const sent: { to: string; body: string }[] = [];
    const channel = smsChannel({
      provider: {
        name: 'fake',
        send: async (message) => {
          sent.push(message);
          return { id: 'SM1' };
        },
      },
    });

    const result = await channel.send(delivery({ body: 'Your code is 123456' }));
    expect(result.id).toBe('SM1');
    expect(sent[0]).toEqual({ to: '+639171234567', body: 'Your code is 123456' });

    expect(() => parseSms({ body: 'x', to: '0917 123 4567' }, 'sms')).toThrow(
      /is not an E.164 number/u,
    );
    expect(() => parseSms({ body: 'x' }, 'sms')).toThrow(/no `to` in the payload and no `phone`/u);
    expect(() => parseSms({ body: '' }, 'sms', '+639171234567')).toThrow(
      /`body` must be a non-empty/u,
    );
  });

  test('a provider that throws is a coded failure naming the notification', async () => {
    const channel = smsChannel({
      provider: {
        name: 'fake',
        send: async () => {
          throw new Error('insufficient funds');
        },
      },
    });
    try {
      await channel.send(delivery({ body: 'x' }));
    } catch (error: unknown) {
      const typed = error as { code: string; message: string };
      expect(typed.code).toBe('NOTIFY_DELIVERY_FAILED');
      expect(typed.message).toContain('insufficient funds');
    }
  });

  test('twilio is a form POST with the id read back, and never the token', async () => {
    const recorder = recordingFetch(() => jsonResponse({ sid: 'SM123', status: 'queued' }, 201));
    const provider = twilioProvider({
      accountSid: 'AC123',
      authToken: 'secret-token',
      from: '+15550000001',
      fetcher: recorder.fetch,
    });

    const result = await provider.send({ to: '+639171234567', body: 'hi' });
    expect(result.id).toBe('SM123');

    const request = recorder.requests[0];
    expect(request?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request?.headers['authorization']).toBe(`Basic ${btoa('AC123:secret-token')}`);
    expect(request?.body).toContain('To=%2B639171234567');
    expect(request?.body).toContain('From=%2B15550000001');
  });

  test('twilio’s refusal is reported without the credential in it', async () => {
    const recorder = recordingFetch(() =>
      jsonResponse({ code: 21211, message: 'Invalid To' }, 400),
    );
    const provider = twilioProvider({
      accountSid: 'AC123',
      authToken: 'super-secret',
      from: '+15550000001',
      fetcher: recorder.fetch,
    });

    try {
      await provider.send({ to: '+639171234567', body: 'hi' });
      throw new Error('expected a failure');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('twilio refused the message');
      expect(message).toContain('HTTP 400');
      expect(message).not.toContain('super-secret');
    }
  });
});
