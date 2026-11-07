import { routeModule as _routeModule } from '@tsir/router';
import { registry } from './registry.ts';
import { classProvider } from '@tsir/container';

import { drizzleToken } from '../../database.ts';
import { UsersController, usersControllerToken } from './http/users.controller.ts';
import { authServiceToken } from '../auth/services/auth.service.ts';
import { auditServiceToken } from '../shared/audit.ts';
import { rbacServiceToken } from '../rbac/services/rbac.service.ts';

export const providers = [
  classProvider(
    usersControllerToken,
    UsersController,
    [drizzleToken, authServiceToken, auditServiceToken, rbacServiceToken],
    { lifetime: 'scoped' },
  ),
];

export const users = _routeModule({
  name: 'users',
  registry,
  unit: 'http',
  providers,
});
