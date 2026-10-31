import { describe, expect, test } from 'bun:test';
import { TsirError } from '@tsir/container';

import { channelConformance } from './conformance.ts';
import { createInboxStore, databaseChannel, type InboxSql } from './channels/database.ts';
import { memoryChannel } from './channels/memory.ts';
import { webhookChannel } from './channels/webhook.ts';
import type { Channel, ChannelResult } from './channel.ts';

const sql: InboxSql = {
  capabilities: { engine: 'd1', placeholder: 'question' },
  query: async () => ({ rows: [], changes: 1 }),
};

/** Every case of a kit, run against a channel that should pass it. */
async function run(kit: readonly { name: string; run: () => Promise<void> }[]): Promise<string[]> {
  const names: string[] = [];
  for (const entry of kit) {
    await entry.run();
    names.push(entry.name);
  }
  return names;
}

describe('the channel conformance kit', () => {
  test('the database channel passes it, with the refusal case enabled', async () => {
    const kit = channelConformance({
      channel: databaseChannel({ store: createInboxStore(sql) }),
      payload: { title: 'Shipped', body: 'Track it' },
      badPayload: { title: '' },
    });
    expect(await run(kit)).toHaveLength(4);
  });

  test('the webhook channel passes it, over a receiver that answers 204', async () => {
    const fetcher = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const kit = channelConformance({
      channel: webhookChannel({ allowHosts: ['hooks.example.com'], fetcher }),
      payload: { body: { orderId: 'ord_1' } },
      // The kit's default recipient points at example.com; the channel's allowlist decides.
      to: { webhookUrl: 'https://hooks.example.com/conformance' },
      badPayload: { body: 'not a body' },
    });
    expect(await run(kit)).toHaveLength(4);
  });

  test('the memory channel passes it, and its `delivers: false` is checked by name', async () => {
    const kit = channelConformance({ channel: memoryChannel(), payload: { anything: true } });
    // No `badPayload`, so the refusal case is absent: memory refuses nothing by design.
    expect(await run(kit)).toHaveLength(3);
  });

  test('a channel that claims to deliver while named memory fails the kit', async () => {
    const lying = memoryChannel();
    const deceptive: Channel = {
      ...lying,
      capabilities: { ...lying.capabilities, delivers: true },
    };
    const kit = channelConformance({ channel: deceptive, payload: {} });
    expect(run(kit)).rejects.toThrow(/the memory driver claims to deliver/u);
  });

  test('a channel with no id and no detail fails the first case', async () => {
    const mute: Channel = {
      name: 'mute',
      driver: 'mute',
      capabilities: { delivers: true, html: false, attachments: false },
      send: async (): Promise<ChannelResult> => ({ accepted: true }),
    };
    const kit = channelConformance({ channel: mute, payload: {} });
    expect(run(kit)).rejects.toThrow(/neither an id nor a detail/u);
  });

  test('a channel that refuses with a bare Error fails the refusal case', async () => {
    const rude: Channel = {
      name: 'rude',
      driver: 'rude',
      capabilities: { delivers: true, html: false, attachments: false },
      check: () => {
        throw new Error('nope');
      },
      send: async (): Promise<ChannelResult> => ({ accepted: true, id: 'x' }),
    };
    const kit = channelConformance({ channel: rude, payload: {}, badPayload: {} });
    expect(run(kit)).rejects.toThrow(/not a NOTIFY_ code/u);
  });

  test('a channel that accepts a payload it should refuse fails too', async () => {
    const permissive: Channel = {
      name: 'permissive',
      driver: 'permissive',
      capabilities: { delivers: true, html: false, attachments: false },
      check: () => undefined,
      send: async (): Promise<ChannelResult> => ({ accepted: true, id: 'x' }),
    };
    const kit = channelConformance({ channel: permissive, payload: {}, badPayload: {} });
    expect(run(kit)).rejects.toThrow(/accepted a payload it cannot use/u);
  });

  test('a channel with no `check` may refuse by throwing a coded error', async () => {
    const lazy: Channel = {
      name: 'lazy',
      driver: 'lazy',
      capabilities: { delivers: true, html: false, attachments: false },
      send: async (delivery): Promise<ChannelResult> => {
        if (delivery.payload === 'bad') {
          throw new TsirError('NOTIFY_INVALID_PAYLOAD', 'refused: no body', { kind: 'capability' });
        }
        return { accepted: true, id: 'ok' };
      },
    };
    const kit = channelConformance({ channel: lazy, payload: {}, badPayload: 'bad' });
    expect(await run(kit)).toHaveLength(4);
  });

  test('a channel that refuses everything fails the first case', async () => {
    const broken: Channel = {
      name: 'broken',
      driver: 'broken',
      capabilities: { delivers: true, html: false, attachments: false },
      send: async (): Promise<ChannelResult> => ({ accepted: false, detail: 'no' }),
    };
    const kit = channelConformance({ channel: broken, payload: {} });
    expect(run(kit)).rejects.toThrow(/the delivery was not accepted/u);
  });

  test('a channel with no `check` may refuse by answering `accepted: false`', async () => {
    const lenient: Channel = {
      name: 'lenient',
      driver: 'lenient',
      capabilities: { delivers: true, html: false, attachments: false },
      send: async (delivery): Promise<ChannelResult> =>
        delivery.payload === 'bad'
          ? { accepted: false, detail: 'refused' }
          : { accepted: true, id: 'ok' },
    };
    const kit = channelConformance({ channel: lenient, payload: {}, badPayload: 'bad' });
    expect(await run(kit)).toHaveLength(4);
  });

  test('a channel with no `check` that accepts everything is caught', async () => {
    const accepting: Channel = {
      name: 'accepting',
      driver: 'accepting',
      capabilities: { delivers: true, html: false, attachments: false },
      send: async (): Promise<ChannelResult> => ({ accepted: true, id: 'ok' }),
    };
    const kit = channelConformance({ channel: accepting, payload: {}, badPayload: {} });
    expect(run(kit)).rejects.toThrow(/a refused payload was accepted/u);
  });
});
