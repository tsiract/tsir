// The budget fixture: one unit, one handler, and a size budget nobody could meet.
//
// It exists to test `DPL-011` — the build must *fail* on an over-budget artifact, and
// `--allow-size-regression` must be the only way past it. A tiny budget makes the failure
// deterministic instead of depending on how large the framework happens to be today.
export default {
  app: {
    name: 'budget-app',
    entry: './src/app.ts',
  },
  deploy: {
    targets: {
      cloudflare: { sizeBudget: 1024 },
    },
    units: [
      {
        name: 'http',
        kind: 'http',
        triggers: [{ kind: 'http', detail: ['GET /'] }],
        // A declared secret is a *name*: `deploy:validate` looks for `APP_KEY = <value>` and
        // leaves `wrangler secret put APP_KEY` alone.
        bindings: [{ kind: 'secret', name: 'APP_KEY' }],
      },
    ],
  },
};
