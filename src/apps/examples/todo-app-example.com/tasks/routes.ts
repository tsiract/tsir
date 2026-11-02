import { RouteRegistry, routeModule } from '@tsir/router';

export const registry = new RouteRegistry();

export const tasks = routeModule({
  name: 'tasks',
  registry,
  unit: 'http',
});
