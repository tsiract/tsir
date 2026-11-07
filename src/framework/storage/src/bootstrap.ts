/**
 * One-call storage bootstrap for apps that use `@tsir/storage`.
 *
 * Replaces the hand-written `modules/system/services/storage.ts` every app
 * previously needed: it builds the named disks from `config/storage.ts`,
 * exposes the `disks` registry, and creates the DI token + value provider
 * the rest of the app wires into its modules.
 */

import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { disksFromConfig, type BuildDisksOptions } from './config.ts';
import type { Disks } from './disks.ts';

/** Options for `createStorageBootstrap`. */
export interface StorageBootstrapOptions {
  /** The app's storage configuration (the `storage` field of `BuildDisksOptions`). */
  readonly storage: BuildDisksOptions['storage'];
  /** Where `{ fromEnv }` references are read from. Defaults to `process.env`. */
  readonly env?: BuildDisksOptions['env'];
  /** Injected into the `s3` driver, so a probe can be tested without a bucket. */
  readonly fetch?: BuildDisksOptions['fetch'];
  readonly now?: BuildDisksOptions['now'];
  /** Refuse ephemeral defaults in production. */
  readonly production?: boolean;
}

/** Everything an app needs to wire its storage layer. */
export interface StorageBootstrap {
  /** The named disks registry. */
  readonly disks: Disks;
  /** DI token for `disks`. */
  readonly disksToken: Token<Disks>;
  /** Value provider for `disks`. */
  readonly disksProvider: Provider<Disks>;
}

/**
 * Build the storage layer from `config/storage.ts`.
 *
 * ```ts
 * import { createStorageBootstrap } from '@tsir/storage';
 * import config from '../../config/storage.ts';
 *
 * export const { disks, disksToken, disksProvider } = createStorageBootstrap({
 *   storage: config,
 * });
 * ```
 */
export function createStorageBootstrap(options: StorageBootstrapOptions): StorageBootstrap {
  const disks = disksFromConfig({
    storage: options.storage,
    env: options.env,
    fetch: options.fetch,
    now: options.now,
    production: options.production,
  });

  const disksToken = token<Disks>('disks');
  const disksProvider = valueProvider(disksToken, disks);

  return { disks, disksToken, disksProvider };
}
