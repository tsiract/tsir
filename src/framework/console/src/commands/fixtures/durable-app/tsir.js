// The Durable Object fixture (`DPL-010`): one `ws` unit bound to a class.
//
// The binding names `Room`; `deploy:build` therefore has to export `Room` from the bundle,
// because `wrangler deploy` looks for that export at deploy time and fails without it.
export default {
  app: {
    name: 'durable-app',
    entry: './src/app.ts',
  },
  deploy: {
    targets: {
      cloudflare: {
        bindings: {
          ROOMS: { kind: 'durable-object', resource: 'Room' },
        },
      },
    },
    units: [
      {
        name: 'ws',
        kind: 'ws',
        triggers: [{ kind: 'websocket', detail: ['/ws/rooms'] }],
        bindings: [{ kind: 'durable-object', name: 'ROOMS', resource: 'Room' }],
      },
    ],
  },
};
