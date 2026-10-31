// The events fixture: one broker connection whose outbox needs a writer.
//
// `cloudflare-queues` cannot enqueue inside the caller's write, so `outbox: true` is mandatory —
// and the outbox is only real when the app exports the registry that writes it. Both refusals
// live in the deploy graph (`DPL_QUEUE_OUTBOX_MISSING`, `DPL_EVENTS_OUTBOX_MISSING`); this
// fixture is the case that passes, and `deploy.test.ts` deletes the export to check the other.
export default {
  app: {
    name: 'events-fixture',
    entry: './src/app.ts',
  },
  queue: {
    default: 'default',
    connections: {
      default: { driver: 'cloudflare-queues', outbox: true },
    },
  },
  deploy: {
    topology: 'separate',
    targets: {
      cloudflare: {},
    },
  },
};
