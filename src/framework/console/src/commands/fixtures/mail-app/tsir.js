// The mail fixture.
//
// Two mailers on purpose: `memory` (which collects, and cannot deliver) and `log` (which prints,
// and cannot deliver either). No `resend`/`postmark`/`ses` entry: a test that needs a provider key
// to pass is a test that fails on a laptop — the transports themselves are covered by a recording
// `fetch` in the package's own suite.
export default {
  app: {
    name: 'mail-app',
    entry: './src/app.ts',
  },
  mail: {
    default: 'log',
    mailers: {
      log: { driver: 'log', from: 'Tsir <no-reply@tsir.local>' },
      collected: {
        driver: 'memory',
        from: 'Tsir <no-reply@tsir.local>',
        replyTo: 'support@tsir.local',
      },
      broken: { driver: 'smtp', from: 'Tsir <no-reply@tsir.local>', host: '127.0.0.1', port: 2525 },
    },
  },
};
