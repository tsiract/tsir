/**
 * @tsir/pennant — feature flags.
 *
 * ```ts
 * import { createPennantBootstrap, memoryStore } from '@tsir/pennant';
 *
 * const { manager } = createPennantBootstrap({
 *   store: memoryStore([
 *     { name: 'new-checkout', rule: { type: 'percentage', value: 10 } },
 *     { name: 'dark-mode', rule: { type: 'boolean', value: true } },
 *   ]),
 * });
 *
 * if (await manager.active('new-checkout', { userId: 'u_123' })) {
 *   // show new checkout
 * }
 * ```
 */

export {
  createFeatureManager,
  evaluate,
  type FeatureContext,
  type FeatureDefinition,
  type FeatureManager,
  type FeatureRule,
  type FeatureStore,
} from './pennant.ts';

export {
  configMissing,
  defaultMissing,
  driverMissing,
  forbiddenInProduction,
  noStore,
  type PennantErrorCode,
} from './errors.ts';

export { featureTableDdl, memoryStore, databaseStore, nullStore } from './stores.ts';

export {
  createFeatureStore,
  featureFlagsFromConfig,
  PENNANT_DRIVERS,
  PERSISTENT_PENNANT_DRIVERS,
  type ConfiguredFeatureFlags,
  type ConfiguredFeatureStore,
  type FeatureStoreBuildOptions,
  type PennantDriverName,
} from './config.ts';

export { createPennantBootstrap } from './bootstrap.ts';
export type { PennantBootstrap, PennantBootstrapOptions } from './bootstrap.ts';
