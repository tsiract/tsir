import { describe, expect, test } from 'bun:test';

import { defineApp, defineModule } from '@tsir/core';
import { defineConfig, env } from '@tsir/config';
import { token, valueProvider } from '@tsir/container';
import { Controller, Get, RouteRegistry, routeModule, routeRegistry } from '@tsir/router';

import { createTestApp, expectTsirError } from './index.ts';

const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
});

const USERS = token<{ source: string }>('users-repository');
const BILLING = token<{ source: string }>('billing-repository');

/**
 * A two-module app, built the way the plans say an app is built: each module owns
 * its routes, and the app only names the modules.
 */
function fixture(): ReturnType<typeof defineApp<typeof spec>> {
  const usersRegistry = new RouteRegistry();
  const billingRegistry = new RouteRegistry();

  const users = routeModule({
    name: 'users',
    registry: usersRegistry,
    providers: [valueProvider(USERS, { source: 'users' })],
  });
  const billing = routeModule({
    name: 'billing',
    registry: billingRegistry,
    providers: [valueProvider(BILLING, { source: 'billing' })],
  });

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
  void UsersController;
  void InvoicesController;

  return defineApp({
    name: 'harness-fixture',
    config: spec,
    modules: [users.module, billing.module],
  });
}

describe('createTestApp', () => {
  test('boots the whole app by default', async () => {
    const harness = await createTestApp(fixture(), { env: { APP_ENV: 'test' } });
    try {
      expect(harness.get(USERS).source).toBe('users');
      expect(harness.get(BILLING).source).toBe('billing');
      expect(harness.routes().routes).toHaveLength(2);
    } finally {
      await harness.dispose();
    }
  });

  test('only narrows the module set without inventing modules', async () => {
    const harness = await createTestApp(fixture(), {
      env: { APP_ENV: 'test' },
      only: ['users'],
    });
    try {
      expect(harness.get(USERS).source).toBe('users');
      // Billing's provider was never registered — proof the module did not boot.
      expect(() => harness.get(BILLING)).toThrow();
      // The process still knows about both modules; the narrowing is per app.
      expect(harness.routes('users').routes).toHaveLength(1);
      expect(harness.routes('billing').routes).toHaveLength(1);
      expect(harness.routes().routes).toHaveLength(2);
    } finally {
      await harness.dispose();
    }
  });

  test('a module table contains only that module', async () => {
    const harness = await createTestApp(fixture(), { env: { APP_ENV: 'test' } });
    try {
      expect(harness.routes('users').routes.map((route) => route.path)).toEqual(['/users']);
      expect(harness.routes('billing').routes.map((route) => route.path)).toEqual(['/invoices']);
    } finally {
      await harness.dispose();
    }
  });

  test('an unknown module name fails loudly', async () => {
    const harness = await createTestApp(fixture(), { env: { APP_ENV: 'test' } });
    try {
      expect(() => harness.routes('nope')).toThrow('no route module named "nope"');
    } finally {
      await harness.dispose();
    }

    await expectTsirError(
      () => createTestApp(fixture(), { env: { APP_ENV: 'test' }, only: ['nope'] }),
      'TEST_UNKNOWN_MODULE',
    );
  });

  test('a controller registered during boot is a leak, and dispose says so', async () => {
    const leaky = defineModule({
      name: 'leaky',
      onReady: () => {
        // Registration is declaration-time. This is exactly the mistake MOD-004 catches:
        // a controller appearing in the process-global registry while an app runs.
        @Controller(routeRegistry, '/late')
        class LateController {
          @Get('/')
          list(): string {
            return 'late';
          }
        }
        void LateController;
      },
    });

    const app = defineApp({
      name: 'leaky-app',
      config: spec,
      modules: [leaky],
    });

    const harness = await createTestApp(app, { env: { APP_ENV: 'test' } });
    try {
      await expectTsirError(() => harness.dispose(), 'TEST_ROUTE_LEAK');
    } finally {
      routeRegistry.clear();
    }
  });
});
