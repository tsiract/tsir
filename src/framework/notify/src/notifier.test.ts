import { describe, expect, test } from 'bun:test';

import { createNotifier, type NotifyQueue } from './notifier.ts';
import { defineNotification } from './notification.ts';
import { memoryChannel, type MemoryChannel } from './channels/memory.ts';
import { mailChannel, type MailPort } from './channels/mail.ts';
import type { Channel, ChannelDelivery, ChannelResult, Notifiable } from './channel.ts';

interface Shipped {
  readonly id: string;
  readonly tracking: string;
}

const ana: Notifiable = { id: 'u1', email: 'ana@example.com', phone: '+639171234567' };

/** A queue that records what it was handed, which is what the notifier promises to do. */
function fakeQueue(): NotifyQueue & {
  readonly dispatched: readonly { job: string; payload: unknown; key: string | undefined }[];
} {
  const dispatched: { job: string; payload: unknown; key: string | undefined }[] = [];
  return {
    connection: 'default',
    dispatched,
    dispatch: async (job, payload, options) => {
      dispatched.push({ job: job.name, payload, key: options?.idempotencyKey });
      return {
        id: `job-${String(dispatched.length)}`,
        connection: 'default',
        name: job.name,
        accepted: true,
      };
    },
  };
}

const shipped = defineNotification<Shipped>({
  name: 'order.shipped',
  channels: ['mail', 'database'],
  sample: { id: 'ord_1', tracking: 'TRK1' },
  mail: (data) => ({ subject: `Order ${data.id} shipped`, text: `Track: ${data.tracking}` }),
  database: (data) => ({ title: `Order ${data.id} shipped` }),
});

/** A mailer that records instead of sending — the channel's own checks still run. */
function fakeMailer(): MailPort & { readonly sent: unknown[] } {
  const sent: unknown[] = [];
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
      sent.push(input);
      return { id: 'msg-1', accepted: ['ana@example.com'] };
    },
    sendTemplate: async () => ({ id: 'msg-2', accepted: ['ana@example.com'] }),
  };
}

function channels(): { mail: MemoryChannel; database: MemoryChannel } {
  return { mail: memoryChannel({ name: 'mail' }), database: memoryChannel({ name: 'database' }) };
}

/** One channel, so a test about *that* channel is not also about the other one. */
const oneChannel = defineNotification<Shipped>({
  name: 'order.mailonly',
  channels: ['mail'],
  mail: (data) => ({ subject: data.id, text: 'only mail' }),
});

describe('sending', () => {
  test('queued by default: one job per channel, keyed by the delivery id', async () => {
    const queue = fakeQueue();
    const built = channels();
    const notifier = createNotifier({
      channels: [built.mail, built.database],
      notifications: [shipped],
      queue,
      newId: () => 'dispatch-1',
      now: () => 1_700_000_000_000,
    });

    const report = await notifier.send(shipped, { id: 'ord_1', tracking: 'TRK' }, { to: ana });

    expect(report.id).toBe('dispatch-1');
    expect(report.channels).toEqual(['mail', 'database']);
    expect(report.delivered).toEqual([]);
    expect(report.queued.map((record) => record.job)).toEqual([
      'notify:deliver:mail',
      'notify:deliver:database',
    ]);
    expect(queue.dispatched.map((entry) => entry.key)).toEqual([
      'dispatch-1:mail',
      'dispatch-1:database',
    ]);

    const envelope = queue.dispatched[0]?.payload as { payload: unknown; to: unknown };
    expect(envelope.payload).toEqual({ subject: 'Order ord_1 shipped', text: 'Track: TRK' });
    expect(envelope.to).toEqual(ana);
    // Nothing was sent: queued means queued.
    expect(built.mail.sent()).toHaveLength(0);
  });

  test('`immediately` delivers inside the call and reports per channel', async () => {
    const built = channels();
    const notifier = createNotifier({
      channels: [built.mail, built.database],
      notifications: [shipped],
    });

    const report = await notifier.send(
      shipped,
      { id: 'ord_2', tracking: 'TRK' },
      { to: ana, immediately: true },
    );

    expect(report.queued).toEqual([]);
    expect(report.delivered.map((record) => record.channel)).toEqual(['mail', 'database']);
    expect(report.delivered.every((record) => record.accepted)).toBe(true);
    expect(built.database.last()?.notification).toBe('order.shipped');
  });

  test('a notifier with no queue refuses a queued notification instead of sending it inline', async () => {
    const built = channels();
    const notifier = createNotifier({
      channels: [built.mail, built.database],
      notifications: [shipped],
    });

    expect(notifier.send(shipped, { id: 'ord_3', tracking: 'T' }, { to: ana })).rejects.toThrow(
      /is queued but this notifier has no queue/u,
    );
    expect(built.mail.sent()).toHaveLength(0);
  });

  test('`queued: false` sends inline with no queue at all', async () => {
    const built = channels();
    const inline = defineNotification<Shipped>({
      name: 'order.delivered',
      channels: ['mail'],
      queued: false,
      mail: (data) => ({ subject: data.id, text: 'delivered' }),
    });
    const notifier = createNotifier({ channels: [built.mail], notifications: [inline] });

    const report = await notifier.send(inline, { id: 'ord_4', tracking: 'T' }, { to: ana });
    expect(report.delivered).toHaveLength(1);
    expect(built.mail.last()?.payload).toEqual({ subject: 'ord_4', text: 'delivered' });
  });

  test('`only` narrows the send and can never widen it', async () => {
    const built = channels();
    const notifier = createNotifier({
      channels: [built.mail, built.database],
      notifications: [shipped],
    });

    const report = await notifier.send(
      shipped,
      { id: 'ord_5', tracking: 'T' },
      { to: ana, only: ['database'], immediately: true },
    );
    expect(report.channels).toEqual(['database']);
    expect(built.mail.sent()).toHaveLength(0);

    expect(
      notifier.send(
        shipped,
        { id: 'ord_6', tracking: 'T' },
        { to: ana, only: ['sms'], immediately: true },
      ),
    ).rejects.toThrow(/does not declare the channel "sms"/u);

    expect(
      notifier.send(
        shipped,
        { id: 'ord_7', tracking: 'T' },
        { to: ana, only: [], immediately: true },
      ),
    ).rejects.toThrow(/narrowed to no channels at all/u);
  });

  test('an undeclared channel is refused, listing the declared ones', async () => {
    const built = channels();
    const typo = defineNotification<Shipped>({
      name: 'order.shipped',
      channels: ['maill'],
      build: () => ({ subject: 's', text: 't' }),
    });
    const notifier = createNotifier({ channels: [built.mail], notifications: [typo] });

    expect(
      notifier.send(typo, { id: 'ord_8', tracking: 'T' }, { to: ana, immediately: true }),
    ).rejects.toThrow(/unknown notification channel "maill"/u);
  });

  test('production refuses a channel that does not deliver', async () => {
    const notifier = createNotifier({
      channels: [memoryChannel({ name: 'mail' })],
      notifications: [shipped],
      production: true,
    });

    expect(
      notifier.send(shipped, { id: 'ord_9', tracking: 'T' }, { to: ana, immediately: true }),
    ).rejects.toThrow(/does not deliver and is refused in production/u);
  });
});

describe('previewing', () => {
  test('every declared channel renders, and nothing is sent', () => {
    const built = channels();
    const notifier = createNotifier({
      channels: [built.mail, built.database],
      notifications: [shipped],
    });

    const preview = notifier.preview(shipped, { id: 'ord_1', tracking: 'TRK' }, ana);
    expect(preview.map((record) => record.channel)).toEqual(['mail', 'database']);
    expect(preview[0]?.payload).toEqual({ subject: 'Order ord_1 shipped', text: 'Track: TRK' });
    expect(preview[0]?.driver).toBe('memory');
    expect(built.mail.sent()).toHaveLength(0);
  });

  test('a capability the channel does not have is refused before a preview is returned', () => {
    const plain = memoryChannel({ name: 'mail', permissive: false });
    const withHtml = defineNotification({
      name: 'receipt',
      channels: ['mail'],
      mail: () => ({ subject: 's', html: '<p>hi</p>' }),
    });
    const notifier = createNotifier({ channels: [plain], notifications: [withHtml] });

    expect(() => notifier.preview(withHtml, {}, ana)).toThrow(/cannot carry an HTML body/u);
  });
});

describe('delivering a queued envelope', () => {
  test('the job body resolves the notification, checks the payload and records the delivery', async () => {
    const built = channels();
    const notifier = createNotifier({
      channels: [built.mail, built.database],
      notifications: [shipped],
      log: () => undefined,
    });

    const record = await notifier.deliver({
      notification: 'order.shipped',
      channel: 'mail',
      payload: { subject: 'Order ord_1 shipped', text: 'Track: TRK' },
      to: ana,
      dispatchId: 'dispatch-1',
      at: 1,
    });

    expect(record.accepted).toBe(true);
    expect(record.channel).toBe('mail');
    expect(record.deliveryId).toBe('dispatch-1:mail');
    expect(built.mail.sent()).toHaveLength(1);
  });

  test('an envelope that is not one is refused with a code, not a crash', async () => {
    const built = channels();
    const notifier = createNotifier({ channels: [built.mail], notifications: [shipped] });

    expect(notifier.deliver({ channel: 'mail' } as never)).rejects.toThrow(
      /is not a delivery envelope|not a delivery envelope/u,
    );
  });

  test('a payload that came back wrong from the queue is refused by the channel', async () => {
    const notifier = createNotifier({
      channels: [mailChannel({ mailer: fakeMailer() })],
      notifications: [oneChannel],
    });

    expect(
      notifier.deliver({
        notification: 'order.mailonly',
        channel: 'mail',
        payload: { subject: '' },
        to: ana,
        dispatchId: 'd',
        at: 1,
      }),
    ).rejects.toThrow(/`subject` must be a non-empty string/u);
  });

  test('a channel that throws becomes NOTIFY_DELIVERY_FAILED, naming the channel', async () => {
    const broken: Channel = {
      name: 'mail',
      driver: 'broken',
      capabilities: { delivers: true, html: true, attachments: true },
      send: async (): Promise<ChannelResult> => {
        throw new Error('the provider is down');
      },
    };
    const notifier = createNotifier({ channels: [broken], notifications: [shipped] });

    try {
      await notifier.deliver({
        notification: 'order.shipped',
        channel: 'mail',
        payload: { subject: 's', text: 't' },
        to: ana,
        dispatchId: 'd',
        at: 1,
      });
      throw new Error('expected the delivery to fail');
    } catch (error: unknown) {
      const typed = error as { code: string; message: string };
      expect(typed.code).toBe('NOTIFY_DELIVERY_FAILED');
      expect(typed.message).toContain('the provider is down');
    }
  });
});

describe('inline delivery failure', () => {
  test('every channel still runs, then the first failure is thrown', async () => {
    const seen: string[] = [];
    const bad: Channel = {
      name: 'mail',
      driver: 'bad',
      capabilities: { delivers: true, html: true, attachments: true },
      send: async (): Promise<ChannelResult> => {
        seen.push('mail');
        throw new Error('nope');
      },
    };
    const good: Channel = {
      name: 'database',
      driver: 'good',
      capabilities: { delivers: true, html: false, attachments: false },
      send: async (): Promise<ChannelResult> => {
        seen.push('database');
        return { accepted: true, id: 'row-1' };
      },
    };
    const notifier = createNotifier({ channels: [bad, good], notifications: [shipped] });

    expect(
      notifier.send(shipped, { id: 'ord_1', tracking: 'T' }, { to: ana, immediately: true }),
    ).rejects.toThrow(/could not be delivered on "mail"/u);
    // The inbox row is written even though the email failed: skipping it would be worse.
    expect(seen.sort()).toEqual(['database', 'mail']);
  });

  test('a channel that throws something that is not an Error is still reported', async () => {
    const rude: Channel = {
      name: 'mail',
      driver: 'rude',
      capabilities: { delivers: true, html: true, attachments: true },
      // A channel whose `send` is a thenable that rejects with a plain value — an SDK written in a
      // hurry, and the case `describe()` exists for. Written as a thenable rather than
      // `Promise.reject` so this file does not need a lint exception for the very bug it tests.
      send: () =>
        ({
          then: (_resolve: unknown, reject: (value: unknown) => void) => reject({ status: 500 }),
        }) as unknown as Promise<ChannelResult>,
    };
    const notifier = createNotifier({ channels: [rude], notifications: [oneChannel] });

    expect(
      notifier.send(oneChannel, { id: 'ord_1', tracking: 'T' }, { to: ana, immediately: true }),
    ).rejects.toThrow(/could not be delivered on "mail"/u);
  });

  test('a channel that answers without `accepted` is a failure, not an acceptance', async () => {
    const vague: Channel = {
      name: 'mail',
      driver: 'vague',
      capabilities: { delivers: true, html: true, attachments: true },
      send: async (): Promise<ChannelResult> => ({}) as ChannelResult,
    };
    const notifier = createNotifier({ channels: [vague], notifications: [oneChannel] });

    expect(
      notifier.send(oneChannel, { id: 'ord_1', tracking: 'T' }, { to: ana, immediately: true }),
    ).rejects.toThrow(/answered without `accepted`/u);
  });

  test('`onError: collect` reports every channel instead of stopping at the first failure', async () => {
    const bad: Channel = {
      name: 'mail',
      driver: 'bad',
      capabilities: { delivers: true, html: true, attachments: true },
      send: async (): Promise<ChannelResult> => {
        throw new Error('the provider is down');
      },
    };
    const good: Channel = {
      name: 'database',
      driver: 'good',
      capabilities: { delivers: true, html: false, attachments: false },
      send: async (): Promise<ChannelResult> => ({ accepted: true, id: 'row-1' }),
    };
    const notifier = createNotifier({ channels: [bad, good], notifications: [shipped] });

    const report = await notifier.send(
      shipped,
      { id: 'ord_1', tracking: 'T' },
      { to: ana, immediately: true, onError: 'collect' },
    );

    expect(report.delivered).toHaveLength(2);
    const mail = report.delivered.find((record) => record.channel === 'mail');
    expect(mail?.accepted).toBe(false);
    expect(mail?.detail).toContain('the provider is down');
    expect(report.delivered.find((record) => record.channel === 'database')?.accepted).toBe(true);
  });

  test('a delivery that reports `accepted: false` is a floor, not a pass', async () => {
    const refusing: Channel = {
      name: 'mail',
      driver: 'refusing',
      capabilities: { delivers: true, html: true, attachments: true },
      send: async (): Promise<ChannelResult> => ({
        accepted: false,
        detail: 'number is not opted in',
      }),
    };
    const notifier = createNotifier({ channels: [refusing], notifications: [oneChannel] });

    const report = await notifier.send(
      oneChannel,
      { id: 'ord_1', tracking: 'T' },
      { to: ana, immediately: true },
    );
    expect(report.delivered[0]?.accepted).toBe(false);
    expect(report.delivered[0]?.detail).toBe('number is not opted in');
  });
});

describe('jobs', () => {
  test('one job per channel a notification uses, and each one delivers', async () => {
    const built = channels();
    const delivered: ChannelDelivery[] = [];
    const original = built.mail.send.bind(built.mail);
    const spy: Channel = {
      ...built.mail,
      name: 'mail',
      send: async (delivery) => {
        delivered.push(delivery);
        return original(delivery);
      },
    };
    const notifier = createNotifier({ channels: [spy, built.database], notifications: [shipped] });

    const jobs = notifier.jobs();
    expect(jobs.map((job) => job.name)).toEqual(['notify:deliver:database', 'notify:deliver:mail']);
    expect(jobs[1]?.retryable).toBe(true);

    await jobs[1]?.handle({
      payload: {
        notification: 'order.shipped',
        channel: 'mail',
        payload: { subject: 's', text: 't' },
        to: ana,
        dispatchId: 'd1',
        at: 1,
      },
      attempt: 1,
      maxAttempts: 5,
      id: 'job-1',
      connection: 'default',
      name: 'notify:deliver:mail',
      signal: new AbortController().signal,
      log: () => undefined,
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.deliveryId).toBe('d1:mail');
  });

  test('a channel nobody uses gets no job', () => {
    const built = channels();
    const notifier = createNotifier({
      channels: [built.mail, built.database],
      notifications: [shipped],
    });
    expect(notifier.jobs().map((job) => job.name)).not.toContain('notify:deliver:sms');
  });
});
