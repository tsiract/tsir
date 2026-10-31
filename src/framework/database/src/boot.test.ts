import { describe, expect, test } from 'bun:test';

import { defineConfig, env, loadConfig } from '@tsir/config';
import { bootstrap, defineModule } from '@tsir/core';

import { assertRequirements, createDatabase, declare, type Database } from './database.ts';
import { createD1Driver, type D1Like } from './d1.ts';
import { createPostgresDriver } from './postgres.ts';

function d1Driver(): ReturnType<typeof createD1Driver> {
  const binding: D1Like = {
    prepare: () => ({
      bind() {
        return this;
      },
      all: async <T = Record<string, unknown>>() => ({
        success: true,
        results: [{ ok: 1 }] as unknown as T[],
      }),
      run: async () => ({ success: true, meta: { changes: 0 } }),
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  };
  return createD1Driver({ binding });
}

const spec = defineConfig({ APP_ENV: env.enum(['development', 'test', 'production']) });
const config = loadConfig(spec, { env: { APP_ENV: 'test' }, appName: 'boot-check' });

/** A component that reads, decides, and writes — it needs a real transaction. */
const REQUIREMENTS = [
  { component: 'UsersService', interactiveTx: true },
  { component: 'HealthService' },
  { component: 'ReportExport', interactiveTx: true },
] as const;

describe('database · boot check (DB-007)', () => {
  test('a module that needs transactions fails at boot, naming every component', async () => {
    const database = createDatabase({ driver: d1Driver() });

    const module = defineModule({
      name: 'database',
      onStart: () => {
        assertRequirements(database, REQUIREMENTS);
      },
    });

    // The failure happens in `bootstrap`, before any request is served — which
    // is the whole point: production would otherwise find out on the one route
    // that needed the transaction.
    const error = await bootstrap({
      appName: 'boot-check',
      modules: [module],
      config,
      mode: 'test',
    }).then(
      () => undefined,
      (reason: unknown) => reason as { code?: string; message?: string; hint?: string },
    );

    // The lifecycle wrapper owns the code (`APP_HOOK_FAILED`) and keeps the real
    // error as its cause, so the boot log still says which database capability
    // was missing rather than only that a hook failed.
    expect(error?.code).toBe('APP_HOOK_FAILED');
    expect((error as { cause?: { code?: string } }).cause?.code).toBe('DB_REQUIRES_INTERACTIVE_TX');
    // Both offenders, in one message: fixing one per restart is not a plan.
    expect(error?.message).toContain('UsersService');
    expect(error?.message).toContain('ReportExport');
    expect(error?.message).not.toContain('HealthService');
    expect((error as { cause?: { hint?: string } }).cause?.hint).toContain('postgres');
  });

  test('a component that declares nothing boots fine on D1', async () => {
    const database = createDatabase({ driver: d1Driver() });
    const module = defineModule({
      name: 'database',
      onStart: () => {
        assertRequirements(database, [{ component: 'UsersService' }]);
        assertRequirements(database, []);
      },
    });

    const app = await bootstrap({
      appName: 'boot-check',
      modules: [module],
      config,
      mode: 'test',
    });

    expect(app.state.kind).toBe('ready');
    await app.shutdown('manual');
  });

  test('an engine with real transactions satisfies the same declaration', () => {
    // The genuine Postgres driver over a client that can begin: the declaration
    // that failed on D1 passes here with no special case in the check.
    const database = createDatabase({
      driver: createPostgresDriver({
        client: {
          unsafe: () => ({ then: () => Promise.resolve([]) }) as never,
          begin: async <T>(work: (scope: never) => Promise<T>) => work(undefined as never),
        },
      }),
    });

    expect(() => assertRequirements(database, REQUIREMENTS)).not.toThrow();
  });

  test('declare() is the single-component form of the same check', () => {
    const database: Database = createDatabase({ driver: d1Driver() });

    expect(() => declare(database, 'ReportExport', { interactiveTx: true })).toThrow(
      /DB_REQUIRES_INTERACTIVE_TX|requires interactive transactions/,
    );
    expect(database.capabilities.engine).toBe('d1');
  });
});
