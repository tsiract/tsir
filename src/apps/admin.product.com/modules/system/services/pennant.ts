/**
 * Pennant (feature flags) bootstrap for the admin app.
 *
 * Uses a memory store with the default feature set. For production, swap in
 * `databaseStore` backed by the `features` table.
 */
import { createPennantBootstrap, memoryStore, type FeatureDefinition } from '@tsir/pennant';

const defaults: FeatureDefinition[] = [
  {
    name: 'new-dashboard',
    description: 'Show the redesigned dashboard',
    rule: { type: 'boolean', value: true },
  },
  {
    name: 'beta-search',
    description: 'Enable experimental search',
    rule: { type: 'percentage', value: 0 },
  },
  {
    name: 'maintenance-mode',
    description: 'Put the app in maintenance mode',
    rule: { type: 'boolean', value: false },
  },
];

export const pennant = createPennantBootstrap({ store: memoryStore(defaults) });
export const featureManagerToken = pennant.pennantToken;
export const featureManagerProvider = pennant.pennantProvider;
