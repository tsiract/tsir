/**
 * The media module's route registry.
 *
 * Note the `unit`: uploads deploy separately from the users API, and the module
 * says so once instead of every controller repeating it.
 */

import { RouteRegistry, routeModule } from '@tsir/router';

export const registry = new RouteRegistry();

export const media = routeModule({
  name: 'media',
  registry,
  unit: 'media',
});
