import { describe, expect, test } from 'bun:test';

import { compileRoutes } from './compile.ts';
import { Controller, Get, Route } from './decorators.ts';
import {
  collectRouteEntries,
  removeRouteModule,
  type RouteModule,
  type RouteModuleOptions,
  routeModule,
  routeModules,
} from './module.ts';
import { RouteRegistry, routeRegistry } from './registry.ts';

/**
 * `routeModule` is process-global by design (the CLI discovers routes by
 * importing the entry, not by inspecting an app object), so every test in this
 * file has to leave the world the way it found it — but *only* the part it
 * touched: other test files in the same process declared real modules.
 */
function withCleanModules(
  run: (declare: (options: RouteModuleOptions) => RouteModule) => void,
): void {
  const declared: RouteModule[] = [];
  const declare = (options: RouteModuleOptions): RouteModule => {
    const created = routeModule(options);
    declared.push(created);
    return created;
  };
  try {
    run(declare);
  } finally {
    for (const created of declared) removeRouteModule(created);
    routeRegistry.clear();
  }
}

describe('routeModule', () => {
  test('two modules do not share a table', () =>
    withCleanModules((declare) => {
      const usersRegistry = new RouteRegistry();
      const billingRegistry = new RouteRegistry();

      const users = declare({ name: 'users', registry: usersRegistry, unit: 'http' });
      const billing = declare({ name: 'billing', registry: billingRegistry });

      @Controller(usersRegistry, '/users')
      class UsersController {
        @Get('/')
        list(): string {
          return 'users';
        }
      }
      @Controller(billingRegistry, '/invoices')
      class InvoicesController {
        @Get('/')
        list(): string {
          return 'invoices';
        }
      }

      expect(users.routes().routes).toHaveLength(1);
      expect(billing.routes().routes).toHaveLength(1);
      expect(users.routes().routes[0]?.path).toBe('/users');
      expect(billing.routes().routes[0]?.path).toBe('/invoices');
      // The controller classes are what prove the tables are disjoint, not the paths.
      expect(users.routes().routes[0]?.controller).toBe(UsersController);
      expect(billing.routes().routes[0]?.controller).toBe(InvoicesController);
    }));

  test('the global registry stays empty — modules own their own routes', () =>
    withCleanModules((declare) => {
      const registry = new RouteRegistry();
      const users = declare({ name: 'users', registry });

      @Controller(registry, '/users')
      class UsersController {
        @Get('/')
        list(): string {
          return 'users';
        }
      }
      void UsersController;

      expect(routeRegistry.entries()).toHaveLength(0);
      // …but the CLI still sees it, through the module.
      expect(users.routes().routes).toHaveLength(1);
    }));

  test('routes() is compiled once and memoised', () =>
    withCleanModules((declare) => {
      const registry = new RouteRegistry();
      const products = declare({ name: 'products', registry });

      @Controller(registry, '/products')
      class ProductsController {
        @Get('/')
        list(): string {
          return 'products';
        }
      }
      void ProductsController;

      const first = products.routes();
      expect(products.routes()).toBe(first);
      // A late registration cannot silently change a table that boot already read.
      @Controller(registry, '/legacy')
      class LegacyController {
        @Route({ method: 'GET', path: '/' })
        index(): string {
          return 'legacy';
        }
      }
      void LegacyController;
      expect(products.routes()).toBe(first);
    }));

  test('the module is a normal ModuleDefinition, name included', () =>
    withCleanModules((declare) => {
      const users = declare({ name: 'users', registry: new RouteRegistry() });
      expect(users.module.name).toBe('users');
      expect(users.unit).toBeUndefined();
    }));

  test('unit is carried on the module, not inferred per route', () =>
    withCleanModules((declare) => {
      const media = declare({ name: 'media', registry: new RouteRegistry(), unit: 'media' });
      expect(media.unit).toBe('media');
    }));
});

describe('collectRouteEntries', () => {
  test('unions the global registry and every declared module', () =>
    withCleanModules((declare) => {
      const moduleRegistry = new RouteRegistry();
      const media = declare({ name: 'media', registry: moduleRegistry });

      @Controller(routeRegistry, '/health')
      class HealthController {
        @Get('/')
        check(): string {
          return 'ok';
        }
      }
      @Controller(moduleRegistry, '/media')
      class MediaController {
        @Get('/')
        list(): string {
          return 'media';
        }
      }
      void MediaController;

      const controllers = collectRouteEntries().map((entry) => entry.controller);
      expect(controllers).toEqual([HealthController, MediaController]);
      expect(media.routes().routes).toHaveLength(1);
    }));

  test('de-duplicates by controller class across registries', () =>
    withCleanModules((declare) => {
      const registry = new RouteRegistry();
      declare({ name: 'media', registry });

      @Controller(registry, '/media')
      class MediaController {
        @Get('/')
        list(): string {
          return 'media';
        }
      }
      void MediaController;
      // The same class registered twice is a wiring mistake, not two route sets.
      routeRegistry.register(registry.entries()[0]!);

      expect(collectRouteEntries()).toHaveLength(1);
      expect(compileRoutes(collectRouteEntries()).routes).toHaveLength(1);
    }));

  test('order is deterministic: global first, then modules in declaration order', () =>
    withCleanModules((declare) => {
      const first = declare({ name: 'first', registry: new RouteRegistry() });
      const second = declare({ name: 'second', registry: new RouteRegistry() });

      @Controller(second.registry, '/second')
      class SecondController {
        @Get('/')
        list(): string {
          return 'second';
        }
      }
      void SecondController;
      @Controller(first.registry, '/first')
      class FirstController {
        @Get('/')
        list(): string {
          return 'first';
        }
      }
      void FirstController;

      expect(collectRouteEntries().map((entry) => entry.name)).toEqual([
        'FirstController',
        'SecondController',
      ]);
    }));
});

describe('removeRouteModule', () => {
  test('removes only the module it is given', () =>
    withCleanModules((declare) => {
      declare({ name: 'users', registry: new RouteRegistry() });
      @Controller(routeRegistry, '/health')
      class HealthController {
        @Get('/')
        check(): string {
          return 'ok';
        }
      }
      void HealthController;

      const before = routeModules().length;
      expect(collectRouteEntries()).toHaveLength(1);

      const [declared] = routeModules();
      expect(declared).toBeDefined();
      if (declared !== undefined) removeRouteModule(declared);

      expect(routeModules().length).toBe(before - 1);
      // The global registry is untouched: only the module was removed.
      expect(routeRegistry.entries()).toHaveLength(1);
    }));
});
