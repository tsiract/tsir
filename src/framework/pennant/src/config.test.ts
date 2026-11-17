/**
 * `CAP-006` — the `featureFlags` registry.
 *
 * The failure this closes is the quiet one: `memoryStore` in production throws nothing, returns a
 * `false` that looks like a decision, and resets on the next deploy. So the assertions here are
 * mostly about refusals rather than about flag evaluation — the evaluation was already tested.
 */
import { describe, expect, test } from 'bun:test';

import { TsirError } from '@tsir/container';

import {
  createFeatureStore,
  featureFlagsFromConfig,
  PENNANT_DRIVERS,
  PERSISTENT_PENNANT_DRIVERS,
} from './config.ts';
import { createFeatureManager } from './pennant.ts';

/** The `hint` is where these errors put the actionable part — `String(error)` cannot see it. */
function rendered(error: unknown): string {
  return error instanceof TsirError ? error.format() : String(error);
}

const query = async (): Promise<readonly Record<string, unknown>[]> => [];

describe('feature flags from config (CAP-006)', () => {
  test('no section means no store, rather than a memory one', () => {
    // An app that never asked for flags should not silently get a registry that works in dev and
    // resets in production. Absence stays absence.
    expect(featureFlagsFromConfig({ featureFlags: undefined })).toBeUndefined();
  });

  test('the database store is built from the named entry', () => {
    const built = featureFlagsFromConfig({
      featureFlags: {
        default: 'main',
        stores: { main: { driver: 'database', table: 'features' } },
      },
      query,
    });
    expect(built?.name).toBe('main');
    expect(typeof built?.store.get).toBe('function');
  });

  test('a database store without a query refuses at construction', () => {
    // A store with no way to read would answer `false` for every flag — every rollout silently off.
    const error = (() => {
      try {
        createFeatureStore('main', { driver: 'database' });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(TsirError);
    expect((error as TsirError).code).toBe('PENNANT_NO_STORE');
    expect(rendered(error)).toContain('query');
  });

  test('memory is refused in production', () => {
    // The bug that motivated the task: the admin app built `memoryStore` unconditionally.
    const error = (() => {
      try {
        featureFlagsFromConfig({
          featureFlags: { default: 'main', stores: { main: { driver: 'memory' } } },
          production: true,
        });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(TsirError);
    expect((error as TsirError).code).toBe('PENNANT_FORBIDDEN_IN_PRODUCTION');
    expect(rendered(error)).toContain('deploy');
  });

  test('memory is allowed outside production', () => {
    // `tsir dev` and tests want a store with no migration. Refusing it there would make the guard
    // something people work around instead of with.
    const built = featureFlagsFromConfig({
      featureFlags: {
        default: 'main',
        stores: {
          main: {
            driver: 'memory',
            defaults: [{ name: 'x', rule: { type: 'boolean', value: true } }],
          },
        },
      },
      production: false,
    });
    expect(built?.store).toBeDefined();
  });

  test('null is durable everywhere — "flags are off" is not a lost write', () => {
    expect(PERSISTENT_PENNANT_DRIVERS).toContain('null');
    const built = featureFlagsFromConfig({
      featureFlags: { default: 'main', stores: { main: { driver: 'null' } } },
      production: true,
    });
    expect(built?.store).toBeDefined();
  });

  test('an unknown driver lists the ones this build ships', () => {
    const error = (() => {
      try {
        createFeatureStore('main', { driver: 'unleash' });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as TsirError).code).toBe('PENNANT_DRIVER_MISSING');
    const text = rendered(error);
    for (const driver of PENNANT_DRIVERS) expect(text).toContain(driver);
  });

  test('a default naming an undeclared store refuses, and says what is declared', () => {
    const error = (() => {
      try {
        featureFlagsFromConfig({
          featureFlags: { default: 'beta', stores: { main: { driver: 'null' } } },
          query,
        });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as TsirError).code).toBe('PENNANT_DEFAULT_MISSING');
    expect(rendered(error)).toContain('main');
  });

  test('an empty stores map refuses instead of resolving to nothing', () => {
    const error = (() => {
      try {
        featureFlagsFromConfig({ featureFlags: { stores: {} }, query });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as TsirError).code).toBe('PENNANT_NO_STORE');
  });

  test('mysql is refused, because the upsert is not the same statement', () => {
    // `ON CONFLICT (name) DO UPDATE` is SQLite's and Postgres's. MySQL's `ON DUPLICATE KEY UPDATE`
    // does something different with a multi-row write, and a half-written flag decides a rollout.
    const error = (() => {
      try {
        createFeatureStore('main', { driver: 'database' }, query, 'mysql');
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as TsirError).code).toBe('PENNANT_ENGINE_UNSUPPORTED');
  });

  test('the database store is what the manager then reads through', async () => {
    // The registry's output has to be a store the manager accepts, not merely an object with the
    // right methods: `createFeatureManager` is what every caller actually holds.
    const built = featureFlagsFromConfig({
      featureFlags: {
        default: 'main',
        stores: {
          main: {
            driver: 'memory',
            defaults: [{ name: 'on', rule: { type: 'boolean', value: true } }],
          },
        },
      },
      production: false,
    });
    const manager = createFeatureManager(built!.store);
    expect(await manager.active('on')).toBe(true);
    expect(await manager.active('missing')).toBe(false);
  });
});
