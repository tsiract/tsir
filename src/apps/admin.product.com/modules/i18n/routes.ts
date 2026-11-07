import { routeModule as _routeModule } from '@tsir/router';
import { registry } from './registry.ts';
import { classProvider } from '@tsir/container';

import { drizzleToken } from '../../database.ts';
import { I18nService, i18nServiceToken } from './services/i18n.service.ts';
import { I18nController, i18nControllerToken } from './http/i18n.controller.ts';
import { auditServiceToken } from '../shared/audit.ts';

export const providers = [
  classProvider(i18nServiceToken, I18nService, [drizzleToken]),
  classProvider(
    i18nControllerToken,
    I18nController,
    [drizzleToken, i18nServiceToken, auditServiceToken],
    { lifetime: 'scoped' },
  ),
];

export const i18n = _routeModule({
  name: 'i18n',
  registry,
  unit: 'http',
  providers,
});
