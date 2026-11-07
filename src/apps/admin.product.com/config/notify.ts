// config/notify.ts — the notification channel registry.
//
// `memory` is the default channel so notifications work in tests and local dev
// without a provider. Swap to `database`, `mail`, `sms`, or `webhook` in
// production. Channels are named, so a notification can only go to a channel
// declared here.
export default {
  default: 'memory',
  channels: {
    memory: { driver: 'memory' },
    // Deliver notifications as email through the default mailer.
    // mail: { driver: 'mail', mailer: 'notifications' },
    // Persist notifications to the inbox table.
    // database: { driver: 'database', connection: 'primary', table: 'tsir_notifications' },
  },
};
