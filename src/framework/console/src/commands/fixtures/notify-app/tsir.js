// The notify fixture.
//
// Three channels on purpose: `memory` (records, cannot deliver), `webhook` (typed builders, and a
// host nothing is listening on, so `notify:test` can fail without a network) and `alerts` — the
// same driver under a project-chosen name, which is what `builders` is for. The `mail` and
// `database` drivers are exercised by the package's own suite, where a real mailer and a fake
// `InboxSql` can be handed in; a fixture cannot invent a `Database`.
export default {
  app: {
    name: 'notify-app',
    entry: './src/app.ts',
  },
  notify: {
    channels: {
      memory: { driver: 'memory' },
      webhook: {
        driver: 'webhook',
        allowHosts: ['hooks.tsir.local'],
        allowHttp: true,
      },
      alerts: {
        driver: 'webhook',
        allowHosts: ['alerts.tsir.local'],
        allowHttp: true,
      },
    },
  },
};
