// The notify fixture's entry. It exports `notifications` — the half `tsir.js` cannot describe, since
// a builder is code — and leaves `channels` to `notify.channels` in the config, which is the path a
// project with no custom channel takes.
import { defineConfig } from '@tsir/config';
import { defineApp } from '@tsir/core';
import { defineNotification } from '@tsir/notify';

export const spec = defineConfig({});

export default defineApp({
  name: 'notify-app',
  config: spec,
  modules: [],
});

interface Shipped {
  readonly id: string;
  readonly tracking: string;
}

export const orderShipped = defineNotification<Shipped>({
  name: 'order.shipped',
  channels: ['memory', 'webhook', 'alerts'],
  sample: { id: 'ord_1', tracking: 'TRK-1' },
  memory: (data) => ({ subject: data.id, text: `Track: ${data.tracking}` }),
  // The typed builder: the channel is named after its driver, so the payload type is known.
  webhook: (data) => ({
    url: 'http://hooks.tsir.local/events',
    event: 'order.shipped',
    body: { id: data.id, tracking: data.tracking },
  }),
  // A renamed channel: same driver, project-chosen name, so the payload is `unknown` here and the
  // channel validates it — which it has to do for a payload that came back through a queue anyway.
  builders: {
    alerts: (data) => ({
      url: 'http://alerts.tsir.local/events',
      event: 'order.shipped',
      body: { id: data.id },
    }),
  },
});

export const digest = defineNotification<{ readonly count: number }>({
  name: 'digest.weekly',
  channels: ['memory'],
  queued: false,
  sample: { count: 12 },
  memory: (data) => ({ title: `${String(data.count)} things happened` }),
});

export const notifications = [orderShipped, digest];
