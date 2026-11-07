import { RouteRegistry, routeModule } from '@tsir/router';

export const registry = new RouteRegistry();

export const users = routeModule({
  name: 'users',
  registry,
  unit: 'http',
});
