/**
 * Type-level tests (`CAP-NOTIFY`, `TST-009`).
 *
 * These lines are compiled, not executed. A `@ts-expect-error` that stops failing is itself a
 * compile error, so the guarantees below cannot silently rot when the implementation changes.
 *
 * The three the package promises:
 *
 *   1. the data a notification is sent with is the data its builders receive;
 *   2. a builder's return type is that channel's payload, so an inbox row cannot be spelled like an
 *      email;
 *   3. a registry of unknown notifications still accepts a typed one — otherwise nothing could be
 *      collected into a list at all.
 */

import { createChannels, createNotifier, defineNotification, type Channel } from '../src/index.ts';
import type { Notifier } from '../src/notifier.ts';

interface Shipped {
  readonly id: string;
  readonly tracking: string;
}

const shipped = defineNotification<Shipped>({
  name: 'order.shipped',
  channels: ['mail', 'database'],
  mail: (data) => ({ subject: `Order ${data.id} shipped`, text: data.tracking }),
  database: (data) => ({ title: `Order ${data.id} shipped` }),
});

// ── 1. the data is typed at the send site ──────────────────────────────────

declare const notifier: Notifier;
declare const to: { readonly id: string; readonly email: string };

// @ts-expect-error — `tracking` is required by `Shipped`
void notifier.send(shipped, { id: 'ord_1' }, { to });

// @ts-expect-error — `data` is not a `Shipped`
void notifier.send(shipped, 'ord_1', { to });

void notifier.send(shipped, { id: 'ord_1', tracking: 'TRK' }, { to, immediately: true });

// ── 2. a builder returns that channel's payload ────────────────────────────

defineNotification<Shipped>({
  name: 'order.shipped',
  channels: ['mail'],
  // @ts-expect-error — a mail payload needs a `subject`
  mail: (data) => ({ text: data.id }),
});

defineNotification<Shipped>({
  name: 'order.shipped',
  channels: ['database'],
  // @ts-expect-error — an inbox row has a `title`, not a `subject`
  database: () => ({ subject: 'shipped' }),
});

// ── 3. a typed notification fits a registry of unknown ones ────────────────

declare const channels: readonly Channel[];
createNotifier({ channels, notifications: [shipped] });

// @ts-expect-error — a channel needs capabilities; `delivers` is not optional
createChannels([{ name: 'x', driver: 'x', send: async () => ({ accepted: true }) }]);
