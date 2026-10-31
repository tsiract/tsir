// An app whose queue connection declares an outbox, and whose entry exports the registry that
// writes it. The export name matters: `deploymentOf` reads `exports.events`, so a project that
// keeps its bus in a module nobody re-exports has no outbox as far as the build can tell — which
// is the same as having none.
import { defineConfig } from '@tsir/config';
import { defineApp } from '@tsir/core';
import { createEvents, defineEvent, defineListener } from '@tsir/events';

export const spec = defineConfig({});

const OrderPlaced = defineEvent<{ readonly orderId: string }>({ name: 'order.placed' });

export const events = createEvents({
  listeners: [
    defineListener(OrderPlaced, {
      name: 'send-receipt',
      mode: 'queued',
      handle: () => undefined,
    }),
  ],
});

export default defineApp({
  name: 'events-fixture',
  config: spec,
  modules: [],
});
