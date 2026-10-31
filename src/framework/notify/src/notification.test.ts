import { describe, expect, test } from 'bun:test';

import { createNotifications, defineNotification } from './notification.ts';
import type { Notifiable } from './channel.ts';

interface Shipped {
  readonly id: string;
  readonly tracking: string;
}

const ana: Notifiable = { id: 'u1', email: 'ana@example.com', phone: '+639171234567' };

const shipped = defineNotification<Shipped>({
  name: 'order.shipped',
  channels: ['mail', 'database'],
  sample: { id: 'ord_1', tracking: 'TRK1' },
  mail: (data) => ({ subject: `Order ${data.id} shipped`, text: `Track: ${data.tracking}` }),
  database: (data) => ({ title: `Order ${data.id} shipped`, url: `/orders/${data.id}` }),
});

describe('defining a notification', () => {
  test('the builders are indexed by channel and the sample is kept', () => {
    expect(shipped.name).toBe('order.shipped');
    expect(shipped.channels).toEqual(['mail', 'database']);
    expect(shipped.queued).toBe(true);
    expect(shipped.sample).toEqual({ id: 'ord_1', tracking: 'TRK1' });

    expect(shipped.build('mail', { id: 'ord_2', tracking: 'TRK2' }, ana)).toEqual({
      subject: 'Order ord_2 shipped',
      text: 'Track: TRK2',
    });
    expect(shipped.build('database', { id: 'ord_2', tracking: 'TRK2' }, ana)).toEqual({
      title: 'Order ord_2 shipped',
      url: '/orders/ord_2',
    });
  });

  test('a name that is not dotted and lowercase is refused where it is written', () => {
    expect(() =>
      defineNotification({
        name: 'OrderShipped',
        channels: ['mail'],
        mail: () => ({ subject: 's', text: 't' }),
      }),
    ).toThrow(/dotted lowercase name/u);
  });

  test('a notification with no channels is refused', () => {
    expect(() =>
      defineNotification({ name: 'order.shipped', channels: [], build: () => ({}) }),
    ).toThrow(/declares no channels/u);
  });

  test('the same channel twice is a duplicate, not two deliveries', () => {
    expect(() =>
      defineNotification({
        name: 'order.shipped',
        channels: ['mail', 'mail'],
        mail: () => ({ subject: 's', text: 't' }),
      }),
    ).toThrow(/same channel twice/u);
  });

  test('a declared channel with no builder is refused, and so is a builder nobody declares', () => {
    expect(() =>
      defineNotification<Shipped>({
        name: 'order.shipped',
        channels: ['mail', 'webhook'],
        mail: () => ({ subject: 's', text: 't' }),
      }),
    ).toThrow(/declares the channel "webhook" but has no builder/u);

    expect(() =>
      defineNotification<Shipped>({
        name: 'order.shipped',
        channels: ['mail'],
        mail: () => ({ subject: 's', text: 't' }),
        database: () => ({ title: 't' }),
      }),
    ).toThrow(/builds a "database" payload but does not declare that channel/u);
  });

  test('`build` serves a channel of your own, and an undeclared one is still a refusal', () => {
    const custom = defineNotification<Shipped>({
      name: 'order.shipped',
      channels: ['pager'],
      build: (channel, data) => ({ channel, text: data.id }),
    });
    expect(custom.build('pager', { id: 'ord_1', tracking: 'TRK' }, ana)).toEqual({
      channel: 'pager',
      text: 'ord_1',
    });
    expect(() => custom.build('mail', { id: 'ord_1', tracking: 'TRK' }, ana)).toThrow(
      /does not declare the channel "mail"/u,
    );
  });

  test('`queued: false` is honoured, and queued stays the default', () => {
    const inline = defineNotification({
      name: 'ping',
      channels: ['memory'],
      queued: false,
      memory: () => 'pong',
    });
    expect(inline.queued).toBe(false);
    expect(shipped.queued).toBe(true);
  });
});

describe('the notification registry', () => {
  test('names are sorted, and a channel knows which notifications use it', () => {
    const registry = createNotifications([
      shipped,
      defineNotification({
        name: 'auth.reset',
        channels: ['mail'],
        mail: () => ({ subject: 's', text: 't' }),
      }),
    ]);
    expect(registry.names).toEqual(['auth.reset', 'order.shipped']);
    expect(registry.usingChannel('mail')).toEqual(['auth.reset', 'order.shipped']);
    expect(registry.usingChannel('database')).toEqual(['order.shipped']);
    expect(registry.usingChannel('sms')).toEqual([]);
    expect(registry.has('order.shipped')).toBe(true);
    expect(registry.all()).toHaveLength(2);
  });

  test('two notifications with one name are refused, and an unknown one lists the rest', () => {
    expect(() => createNotifications([shipped, shipped])).toThrow(/both named "order.shipped"/u);

    const registry = createNotifications([shipped]);
    expect(() => registry.get('order.cancelled')).toThrow(
      /unknown notification "order.cancelled"/u,
    );
    expect(registry.has('order.cancelled')).toBe(false);
  });
});
