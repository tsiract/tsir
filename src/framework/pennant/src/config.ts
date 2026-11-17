/**
 * `featureFlags.stores` in `tsir.js` — the registry half of `@tsir/pennant` (`CAP-006`).
 *
 * The package shipped three stores and no way to name one from a file. Every app therefore built
 * the store in its entry module — and the admin app built `memoryStore`, in production, because
 * that was the shortest thing that compiled. Feature flags are the one capability where a wrong
 * default is invisible: nothing throws, nothing 500s, the rollout simply resets on the next deploy
 * and two instances disagree about who is in the experiment.
 *
 * ## Why `memory` is refused in production and not merely discouraged
 *
 * `nullStore` is the deliberate "flags are off" choice and stays legal everywhere. `memoryStore`
 * is a `Map` in one process. On a long-lived server it is a legitimate cache-aside store; on a
 * Worker or a Lambda there is no process to hold it, and on any target the next deploy hands every
 * user the control group again. So `production: true` refuses `memory` and accepts `database` —
 * the same shape `mail` uses for `log` and `media` for `sharp`.
 *
 * ## The engine is part of the question
 *
 * A `database` store speaks `ON CONFLICT (name) DO UPDATE`: D1, SQLite and Postgres. MySQL has
 * `ON DUPLICATE KEY UPDATE`, which is not the same statement for a multi-row write, and a
 * half-written flag decides a rollout. `createFeatureStore` refuses `mysql` here rather than
 * leaving `databaseStore` to throw later, so the refusal arrives while the config is still the
 * thing being read.
 */

import { TsirError } from '@tsir/container';

import { defaultMissing, driverMissing, forbiddenInProduction, noStore } from './errors.ts';
import type { FeatureDefinition, FeatureStore } from './pennant.ts';
import { databaseStore, memoryStore, nullStore } from './stores.ts';

/** Every store this build ships, in the order an error message lists them. */
export const PENNANT_DRIVERS = ['database', 'memory', 'null'] as const;

export type PennantDriverName = (typeof PENNANT_DRIVERS)[number];

/** The stores that survive a deploy. `null` is durable in the sense that matters: nothing is lost. */
export const PERSISTENT_PENNANT_DRIVERS: readonly string[] = ['database', 'null'];

/** One `featureFlags.stores.<name>` entry, as configuration sees it. */
export interface ConfiguredFeatureStore {
  /**
   * As written in `tsir.js`. Typed `string`, not `PennantDriverName`: an unknown name must fail with
   * a message that lists the real ones, and narrowing the type here would only move the failure to
   * a place with less to say.
   */
  readonly driver: string;
  /** The table a `database` store reads. Default `features`. */
  readonly table?: string | undefined;
  /** The connection name an app resolves for a `database` store. Informational here. */
  readonly connection?: string | undefined;
  /** The seeded flags a `memory` store starts with, for `tsir dev` and tests. */
  readonly defaults?: readonly FeatureDefinition[] | undefined;
}

export function createFeatureStore(
  name: string,
  config: ConfiguredFeatureStore,
  query?: (sql: string, params: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>,
  engine?: 'd1' | 'postgres' | 'mysql' | 'sqlite',
): FeatureStore {
  switch (config.driver) {
    case 'null':
      return nullStore();
    case 'memory':
      return memoryStore(config.defaults ?? []);
    case 'database': {
      if (query === undefined) {
        // The store is a query function and a table. Absent the function there is nothing to read,
        // and a store that returned `false` for every flag would silently disable every rollout.
        throw new TsirError(
          'PENNANT_NO_STORE',
          `feature store "${name}" uses the \`database\` driver but no connection query was supplied`,
          {
            kind: 'capability',
            hint: "pass the app's query function, e.g. `query: (sql, params) => db.query(sql, params)`",
            context: { store: name, driver: config.driver },
          },
        );
      }
      return databaseStore(query, {
        placeholder: engine === 'postgres' ? 'dollar' : 'question',
        ...(engine === undefined ? {} : { engine }),
        ...(config.table === undefined ? {} : { table: config.table }),
      });
    }
    default:
      throw driverMissing(config.driver, PENNANT_DRIVERS);
  }
}

/** One `featureFlags` block, as `tsir.js` writes it. */
export interface ConfiguredFeatureFlags {
  readonly default?: string | undefined;
  readonly stores: Readonly<Record<string, ConfiguredFeatureStore>>;
}

export interface FeatureStoreBuildOptions {
  readonly featureFlags: ConfiguredFeatureFlags | undefined;
  /** The connection query a `database` store reads through. */
  readonly query?: (
    sql: string,
    params: readonly unknown[],
  ) => Promise<readonly Record<string, unknown>[]>;
  /** The connection's engine, which decides the placeholder and refuses MySQL. */
  readonly engine?: 'd1' | 'postgres' | 'mysql' | 'sqlite' | undefined;
  /** `isProduction()` from `@tsir/core`. Opt-in, so a test can build the stores it wants. */
  readonly production?: boolean | undefined;
}

/**
 * The feature store the project names, or `undefined` when it declares no `featureFlags` block.
 *
 * `undefined` rather than a memory store: an app that never asked for feature flags should not get
 * a registry that quietly works in dev and resets in production. Absence stays absence, and the
 * app's own bootstrap decides what to do.
 */
export function featureFlagsFromConfig(
  options: FeatureStoreBuildOptions,
): { readonly store: FeatureStore; readonly name: string } | undefined {
  const flags = options.featureFlags;
  if (flags === undefined) return undefined;

  const entries = Object.entries(flags.stores);
  if (entries.length === 0) throw noStore();
  if (flags.default !== undefined && !Object.hasOwn(flags.stores, flags.default)) {
    throw defaultMissing(
      flags.default,
      entries.map(([name]) => name),
    );
  }

  const chosen = flags.default ?? entries[0]?.[0];
  const entry = chosen === undefined ? undefined : flags.stores[chosen];
  if (chosen === undefined || entry === undefined) throw noStore();

  if (options.production === true && !PERSISTENT_PENNANT_DRIVERS.includes(entry.driver)) {
    throw forbiddenInProduction(entry.driver);
  }

  return {
    name: chosen,
    store: createFeatureStore(chosen, entry, options.query, options.engine),
  };
}
