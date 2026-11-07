import { routeModule as _routeModule } from '@tsir/router';
import { registry } from './registry.ts';
import { classProvider } from '@tsir/container';

import { drizzleToken } from '../../database.ts';
import { RbacService, rbacServiceToken } from './services/rbac.service.ts';
import { RolesController, rolesControllerToken } from './http/roles.controller.ts';
import { PermissionsController, permissionsControllerToken } from './http/roles.controller.ts';
import { GroupsController, groupsControllerToken } from './http/groups.controller.ts';
import { auditServiceToken } from '../shared/audit.ts';

export const providers = [
  classProvider(rbacServiceToken, RbacService, [drizzleToken]),
  classProvider(rolesControllerToken, RolesController, [drizzleToken, auditServiceToken], {
    lifetime: 'scoped',
  }),
  classProvider(
    permissionsControllerToken,
    PermissionsController,
    [drizzleToken, auditServiceToken],
    { lifetime: 'scoped' },
  ),
  classProvider(groupsControllerToken, GroupsController, [drizzleToken, auditServiceToken], {
    lifetime: 'scoped',
  }),
];

export const rbac = _routeModule({
  name: 'rbac',
  registry,
  unit: 'http',
  providers,
});
