import { RouteRegistry, routeModule } from '@tsir/router';

export const registry = new RouteRegistry();

export const media = routeModule({
  name: 'media',
  registry,
  unit: 'media',
});
