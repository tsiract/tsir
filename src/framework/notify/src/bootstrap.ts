/**
 * One-call notify bootstrap for apps that use `@tsir/notify`.
 *
 * Replaces the hand-written `modules/system/services/notify.ts` every app
 * previously needed: it builds the channels from `config/notify.ts`, creates
 * the notifier with the app's notification definitions, and exposes the DI
 * token + value provider the rest of the app wires into its modules.
 *
 * Notification definitions are app-specific, so the app passes them in.
 */

import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { channelsFromConfig, type BuildChannelsOptions } from './config.ts';
import { createNotifier, type CreateNotifierOptions, type Notifier } from './notifier.ts';
import type { NotificationDefinition } from './notification.ts';

/** Options for `createNotifyBootstrap`. */
export interface NotifyBootstrapOptions {
  /** The app's notify configuration (the `notify` field of `BuildChannelsOptions`). */
  readonly notify: BuildChannelsOptions['notify'];
  /** The app's notification definitions. */
  readonly notifications: readonly NotificationDefinition<unknown>[];
  /** Optional queue for queued notifications. */
  readonly queue?: CreateNotifierOptions['queue'];
  /** Where delivery-time logs go. Defaults to discarding them. */
  readonly log?: (message: string) => void;
  /** The `mail` driver's source: the project's mailer registry. */
  readonly mailers?: BuildChannelsOptions['mailers'];
  /** The `database` driver's source: an `InboxSql`. */
  readonly database?: BuildChannelsOptions['database'];
  /** Where `{ fromEnv }` references are read from. */
  readonly env?: BuildChannelsOptions['env'];
  readonly fetch?: BuildChannelsOptions['fetch'];
  readonly now?: BuildChannelsOptions['now'];
  /** Refuse channels that do not deliver in production. */
  readonly production?: boolean;
}

/** Everything an app needs to wire its notify layer. */
export interface NotifyBootstrap {
  /** The built channels (exported for the `mail` channel's mailer dependency). */
  readonly channels: ReturnType<typeof channelsFromConfig>;
  /** The notifier. */
  readonly notifier: Notifier;
  /** DI token for `notifier`. */
  readonly notifierToken: Token<Notifier>;
  /** Value provider for `notifier`. */
  readonly notifierProvider: Provider<Notifier>;
}

/**
 * Build the notify layer from `config/notify.ts`.
 *
 * ```ts
 * import { createNotifyBootstrap, defineNotification } from '@tsir/notify';
 * import config from '../../config/notify.ts';
 *
 * const userRegistered = defineNotification<{ id: string }>({
 *   name: 'user.registered',
 *   channels: ['memory'],
 *   memory(data) { return { subject: `Welcome ${data.id}` }; },
 * });
 *
 * export const { notifier, notifierToken, notifierProvider } = createNotifyBootstrap({
 *   notify: config,
 *   notifications: [userRegistered],
 * });
 * ```
 */
export function createNotifyBootstrap(options: NotifyBootstrapOptions): NotifyBootstrap {
  const channels = channelsFromConfig({
    notify: options.notify,
    mailers: options.mailers,
    database: options.database,
    env: options.env,
    fetch: options.fetch,
    now: options.now,
    production: options.production,
  });

  const notifier = createNotifier({
    channels,
    notifications: options.notifications,
    queue: options.queue,
    production: options.production,
    now: options.now,
    log: options.log,
  });

  const notifierToken = token<Notifier>('notifier');
  const notifierProvider = valueProvider(notifierToken, notifier);

  return { channels, notifier, notifierToken, notifierProvider };
}
