/**
 * One-call bootstrap for `@tsir/pennant`.
 */
import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { createFeatureManager, type FeatureManager } from './pennant.ts';
import { memoryStore } from './stores.ts';
import type { FeatureStore } from './pennant.ts';

export interface PennantBootstrapOptions {
  /** The feature store. Defaults to an in-memory store. */
  readonly store?: FeatureStore;
}

export interface PennantBootstrap {
  readonly manager: FeatureManager;
  readonly pennantToken: Token<FeatureManager>;
  readonly pennantProvider: Provider<FeatureManager>;
}

export function createPennantBootstrap(options: PennantBootstrapOptions = {}): PennantBootstrap {
  const store = options.store ?? memoryStore();
  const manager = createFeatureManager(store);
  const pennantToken = token<FeatureManager>('pennant');
  const pennantProvider = valueProvider(pennantToken, manager);
  return { manager, pennantToken, pennantProvider };
}
