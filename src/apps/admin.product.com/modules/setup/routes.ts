import { routeModule as _routeModule } from '@tsir/router';
import { registry } from './registry.ts';
import { classProvider } from '@tsir/container';

import { drizzleToken } from '../../database.ts';
import { SetupController, setupControllerToken } from './http/setup.controller.ts';
import { authServiceToken } from '../auth/index.ts';
import { auditServiceToken } from '../shared/audit.ts';
import { i18nServiceToken } from '../i18n/index.ts';

export const providers = [
  classProvider(
    setupControllerToken,
    SetupController,
    [drizzleToken, authServiceToken, auditServiceToken, i18nServiceToken],
    { lifetime: 'scoped' },
  ),
];

export const setup = _routeModule({
  name: 'setup',
  registry,
  unit: 'http',
  providers,
});
