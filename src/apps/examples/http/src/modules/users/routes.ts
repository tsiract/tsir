/**
 * The users module's route registry.
 *
 * The registry is created here, next to the module name, and the controller
 * imports *this* instance. That single line is what makes the module's routes
 * its own: nothing else in the process can add to the table, and
 * `users.routes()` (used by tests and by `route:compile`) returns exactly the
 * routes this directory declares.
 */

import { RouteRegistry, routeModule } from '@tsir/router';

export const registry = new RouteRegistry();

export const users = routeModule({
  name: 'users',
  registry,
  // Every route here deploys with the HTTP unit unless it says otherwise.
  unit: 'http',
});
