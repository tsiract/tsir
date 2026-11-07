import { routeModule as _routeModule } from '@tsir/router';
import { registry } from './registry.ts';
import { classProvider, token, valueProvider } from '@tsir/container';
import type { LoadedConfig } from '@tsir/config';

import { drizzleToken } from '../../database.ts';
import {
  MailService,
  mailersToken,
  mailersProvider,
  mailServiceToken,
} from './services/mail.service.ts';
import { MailController, mailControllerToken } from './http/mail.controller.ts';
import { auditServiceToken } from '../shared/audit.ts';

export const appUrlToken = token<string>('appUrl');

/** Config fields the mail module reads from the loaded app config. */
type MailConfig = { APP_URL: string };

/**
 * Build the mail module. Config provides `APP_URL` for reset-password links.
 */
export function createMailModule(
  config: LoadedConfig<MailConfig>,
): ReturnType<typeof _routeModule> {
  const providers = [
    mailersProvider,
    valueProvider(appUrlToken, config.values.APP_URL),
    classProvider(mailServiceToken, MailService, [mailersToken, appUrlToken]),
    classProvider(mailControllerToken, MailController, [drizzleToken, auditServiceToken], {
      lifetime: 'scoped',
    }),
  ];

  return _routeModule({
    name: 'mail',
    registry,
    unit: 'http',
    providers,
  });
}
