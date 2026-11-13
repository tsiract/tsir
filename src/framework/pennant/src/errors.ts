/**
 * Feature-flag errors.
 *
 * The package had none: a store could only fail with whatever the database said. That is fine for
 * a broken query and wrong for a *configuration* mistake, which is what an unsupported engine is —
 * the answer is one line of config, and it should arrive before the first flag is read.
 */

import { TsirError } from '@tsir/container';

export type PennantErrorCode =
  | 'PENNANT_ENGINE_UNSUPPORTED'
  | 'PENNANT_DRIVER_MISSING'
  | 'PENNANT_FORBIDDEN_IN_PRODUCTION'
  | 'PENNANT_DEFAULT_MISSING'
  | 'PENNANT_NO_STORE'
  | 'PENNANT_CONFIG_MISSING';

const KIND = 'capability';

/**
 * The connection's engine cannot run this store's upsert (`CAP-009`).
 *
 * `ON CONFLICT (name) DO UPDATE` is SQLite's and Postgres's. MySQL's `ON DUPLICATE KEY UPDATE`
 * would silently do something different with a multi-row statement, and a feature flag that lands
 * half-written is worse than one that fails to save: the next read decides a rollout from it.
 */
export function engineUnsupported(table: string, engine: string): TsirError {
  return new TsirError(
    'PENNANT_ENGINE_UNSUPPORTED',
    `the feature store cannot use a "${engine}" connection: its upsert is \
\`ON CONFLICT (name) DO UPDATE\`, which that engine does not speak`,
    {
      kind: KIND,
      hint: `use a d1, sqlite or postgres connection for \`${table}\`, or a store this engine supports`,
      context: { table, engine },
    },
  );
}

/**
 * A driver name this build does not ship (`CAP-006`).
 *
 * Lists what it does ship, because the name is usually a near-miss (`database-store`,
 * `postgres`) and the person is one edit from the answer.
 */
export function driverMissing(driver: string, shipped: readonly string[]): TsirError {
  return new TsirError('PENNANT_DRIVER_MISSING', `pennant has no "${driver}" store`, {
    kind: KIND,
    hint: `this build ships: ${shipped.join(', ')}`,
    context: { driver, shipped: shipped.join(',') },
  });
}

/**
 * `memory` in production (`CAP-006`).
 *
 * A flag's whole job is to be the same on every instance and the same tomorrow. `memoryStore`
 * is a `Map` in one process: the next deploy resets every rollout, and a two-instance deployment
 * shows a different site to each visitor. It is the right store for a test and for `tsir dev`.
 */
export function forbiddenInProduction(store: string): TsirError {
  return new TsirError(
    'PENNANT_FORBIDDEN_IN_PRODUCTION',
    `the "${store}" feature store holds flags in one process, so production would reset every rollout on the next deploy`,
    {
      kind: KIND,
      hint: "use the `database` store — flags belong where the rest of the app's state is",
      context: { store },
    },
  );
}

/** `default` names a store that is not declared. */
export function defaultMissing(name: string, declared: readonly string[]): TsirError {
  return new TsirError(
    'PENNANT_DEFAULT_MISSING',
    `featureFlags.default names "${name}", which is not one of the declared stores`,
    {
      kind: KIND,
      hint: `declared: ${declared.join(', ')}`,
      context: { default: name, declared: declared.join(',') },
    },
  );
}

/** A `featureFlags` block with no stores, or one whose only store is not usable. */
export function noStore(): TsirError {
  return new TsirError('PENNANT_NO_STORE', 'feature flags are declared but `stores` is empty', {
    kind: KIND,
    hint: "declare one, e.g. `stores: { main: { driver: 'database', table: 'features' } }`",
    context: { stores: 0 },
  });
}

/**
 * The app's bootstrap requires a `featureFlags` section and the project has none.
 *
 * An app that reads flags has to have them somewhere. Reaching here means the section was deleted
 * or never copied from the starter — and the alternative, falling back to a memory store, is the
 * exact failure this registry exists to prevent.
 */
export function configMissing(): TsirError {
  return new TsirError(
    'PENNANT_CONFIG_MISSING',
    'this app requires a `featureFlags` section, and the project has none',
    {
      kind: KIND,
      hint: "add `config/featureFlags.ts` with `stores: { main: { driver: 'database' } }`",
      context: {},
    },
  );
}
