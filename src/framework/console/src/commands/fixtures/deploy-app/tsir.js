// The deploy fixture: the smallest project that produces a non-trivial unit graph.
//
// It has no routes on purpose. Every unit here comes from `deploy.units` and from a
// journaled connection, which is exactly the shape a project has *before* it grows HTTP
// handlers — and it proves the graph does not need a route table to exist.
export default {
  app: {
    name: 'deploy-fixture',
    entry: './src/app.ts',
  },
  deploy: {
    topology: 'separate',
    targets: {
      cloudflare: {
        bindings: {
          HYPERDRIVE: { kind: 'hyperdrive', resource: 'primary-postgres' },
          ROOMS: { kind: 'durable-object', resource: 'Room' },
        },
        sizeBudget: 1048576,
      },
      lambda: {
        bindings: {
          HYPERDRIVE: { kind: 'hyperdrive', resource: 'primary-postgres' },
        },
      },
    },
    units: [
      {
        name: 'ws',
        kind: 'ws',
        triggers: [{ kind: 'websocket', detail: ['/ws/orders'] }],
      },
      {
        name: 'drain',
        kind: 'schedule',
        triggers: [{ kind: 'cron', detail: ['*/5 * * * *'] }],
        requires: ['background-tasks'],
        // A secret is a binding a target does not declare (`DPL_SECRET_LEAK`'s subject):
        // its absence from `targets.*.bindings` is normal, its *value* must never be here.
        bindings: [{ kind: 'secret', name: 'APP_KEY' }],
      },
    ],
  },
};
