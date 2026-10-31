/**
 * Declarations (`§ 4.5`).
 *
 * The validation here is cheap and the mistakes it prevents are not: an event name is a job
 * name, a log field and an outbox row, and a listener name is the second half of a job name. Both
 * are refused at declaration time, where the error names the line you just wrote.
 */

import { describe, expect, test } from 'bun:test';

import { createEvents } from './bus.ts';
import { defineEvent, defineListener, deliveryJobName, modeOf } from './event.ts';

describe('defineEvent', () => {
  test('a dotted lowercase name is accepted, and `queued` is the default mode', () => {
    const event = defineEvent<{ readonly id: string }>({ name: 'order.placed' });

    expect(event.name).toBe('order.placed');
    // Default `queued`: a listener that runs inline is the exception, because inline is the
    // choice that can hold a transaction open on a network call.
    expect(event.mode).toBe('queued');
  });

  test('a name that is not dotted lowercase is refused at declaration', () => {
    expect(() => defineEvent({ name: 'OrderPlaced' })).toThrow(/dotted lowercase/u);
    expect(() => defineEvent({ name: 'order placed' })).toThrow(/dotted lowercase/u);
    expect(() => defineEvent({ name: 'order_placed' })).toThrow(/dotted lowercase/u);
    expect(() => defineEvent({ name: '' })).toThrow(/dotted lowercase/u);
  });

  test('the mode can be declared once, on the event', () => {
    expect(defineEvent({ name: 'order.cancelled', mode: 'sync' }).mode).toBe('sync');
  });
});

describe('defineListener', () => {
  test('a listener inherits the event mode until it declares its own', () => {
    const event = defineEvent({ name: 'order.placed', mode: 'sync' });
    const inherit = defineListener(event, { name: 'audit', handle: () => undefined });
    const override = defineListener(event, {
      name: 'receipt',
      mode: 'queued',
      handle: () => undefined,
    });

    expect(modeOf(inherit)).toBe('sync');
    expect(modeOf(override)).toBe('queued');
  });

  test('a listener name with whitespace or a colon is refused', () => {
    const event = defineEvent({ name: 'order.placed' });

    // Both characters break the derived job name, and a job name is how a retry finds its way
    // back to a handler.
    const handle = (): void => undefined;
    expect(() => defineListener(event, { name: 'send receipt', handle })).toThrow(
      /no whitespace or ":"/u,
    );
    expect(() => defineListener(event, { name: 'send:receipt', handle })).toThrow(
      /no whitespace or ":"/u,
    );
    expect(() => defineListener(event, { name: '', handle })).toThrow(/no whitespace or ":"/u);
  });

  test('two listeners with one name on one event are refused when the bus is built', () => {
    const event = defineEvent({ name: 'order.placed' });

    expect(() =>
      createEvents({
        listeners: [
          defineListener(event, { name: 'receipt', mode: 'queued', handle: () => undefined }),
          defineListener(event, { name: 'receipt', mode: 'sync', handle: () => undefined }),
        ],
      }),
    ).toThrow(/both named "receipt"/u);
  });

  test('the same listener name on two different events is fine', () => {
    const placed = defineEvent({ name: 'order.placed' });
    const cancelled = defineEvent({ name: 'order.cancelled' });

    const events = createEvents({
      listeners: [
        defineListener(placed, { name: 'audit', mode: 'sync', handle: () => undefined }),
        defineListener(cancelled, { name: 'audit', mode: 'sync', handle: () => undefined }),
      ],
    });

    expect(events.names).toEqual(['order.cancelled', 'order.placed']);
  });

  test('the job name is derived from both halves, so a rename is a new job', () => {
    const event = defineEvent({ name: 'order.placed' });

    expect(deliveryJobName(event, 'send-receipt')).toBe('event:order.placed:send-receipt');
  });
});
