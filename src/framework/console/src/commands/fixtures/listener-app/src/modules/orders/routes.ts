import { RouteRegistry, routeModule } from '@tsir/router';

export const registry = new RouteRegistry();

export const orders = routeModule({
  name: 'orders',
  registry,
  unit: 'notify',
});
