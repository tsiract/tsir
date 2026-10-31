// The exposure fixture (`DPL-022`): one public unit, one admin unit.
//
// `admin` is private because of its *kind*, not because of a flag — that is the default the
// documented contract promises — so this fixture proves the emitters honour it: `workers_dev = false` on
// Cloudflare, no `HttpApi` event on Lambda.
export default {
  app: {
    name: 'admin-app',
    entry: './src/app.ts',
  },
  deploy: {
    targets: {
      cloudflare: { bindings: {} },
      lambda: { vars: { APP_ENV: 'production' } },
    },
    units: [
      {
        name: 'http',
        kind: 'http',
        triggers: [{ kind: 'http', detail: ['GET /api/things'] }],
      },
      {
        name: 'admin',
        kind: 'admin',
        triggers: [{ kind: 'http', detail: ['GET /health'] }],
      },
    ],
  },
};
