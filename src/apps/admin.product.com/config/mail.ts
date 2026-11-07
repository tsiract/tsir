// config/mail.ts — the mailer registry.
//
// `log` is the default driver so the app boots without a provider key; swap to
// `resend`, `postmark`, `ses`, or `smtp` in production and set `required: true`
// on the mailer that delivers password-reset links.
export default {
  default: 'log',
  mailers: {
    log: { driver: 'log', from: 'Tsir Admin <no-reply@tsir.local>' },
    notifications: {
      driver: 'log',
      from: 'Tsir Admin <no-reply@tsir.local>',
      replyTo: 'support@tsir.local',
    },
  },
};
