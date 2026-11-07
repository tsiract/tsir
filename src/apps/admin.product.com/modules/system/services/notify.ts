/**
 * Notification notifier.
 *
 * `@tsir/notify` delivers notifications through named channels. Channels are
 * built from `config/notify.ts`; the default is `memory` so notifications work
 * in tests and local dev without a provider.
 *
 * A notification is a named definition (`user.registered`) with payload
 * builders per channel. The notifier exposes `send(notification, { to, data })`.
 */
import { createNotifyBootstrap, defineNotification } from '@tsir/notify';
import { token, valueProvider } from '@tsir/container';
import appConfig from '../../../config/notify.ts';
import { logger } from './pulse.ts';

export const userRegisteredNotification = defineNotification<{ id: string; email: string }>({
  name: 'user.registered',
  channels: ['memory'],
  description: 'Welcome email sent when a user registers',
  sample: { id: 'u_123', email: 'user@example.com' },
  memory(data) {
    return { subject: `Welcome ${data.email}`, body: `User ${data.id} registered` };
  },
});

export const { notifier, notifierToken, notifierProvider } = createNotifyBootstrap({
  notify: appConfig,
  notifications: [userRegisteredNotification],
  log: (message) => logger.info(message),
});

export const userRegisteredNotificationToken = token<typeof userRegisteredNotification>(
  'userRegisteredNotification',
);
export const userRegisteredNotificationProvider = valueProvider(
  userRegisteredNotificationToken,
  userRegisteredNotification,
);
