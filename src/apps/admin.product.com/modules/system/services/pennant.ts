/**
 * Feature flags for the admin app.
 *
 * `CAP-006`: this used to be `createPennantBootstrap({ store: memoryStore(defaults) })` — a `Map`
 * in one process. In production that meant every rollout reset on the next deploy and two
 * instances disagreed about who was in an experiment. Nothing threw; the flags simply were not
 * what the dashboard said they were.
 *
 * The store now comes from `config/featureFlags.ts`, which resolves the `database` store against
 * the app's own connection — the same table the rest of the app's state lives in. `flags` is the
 * set of flags this app knows about, seeded as a fallback for `tsir dev`; the database is the
 * source of truth once a store has one.
 */
import {
  configMissing,
  createPennantBootstrap,
  featureFlagsFromConfig,
  type FeatureDefinition,
} from '@tsir/pennant';
import { isProduction } from '@tsir/core';

import { databases } from '../../../database.ts';
import featureFlagConfig from '../../../config/featureFlags.ts';

/** The flags this app ships with, so a fresh database has something to show. */
export const flags: FeatureDefinition[] = [
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

const database = databases.defaultDatabase;

const resolved = featureFlagsFromConfig({
  featureFlags: featureFlagConfig,
  query: async (sql, params) => {
    const result = await database.query({ sql, params });
    return result.rows as readonly Record<string, unknown>[];
  },
  engine: database.capabilities.engine,
  // `CAP-007`: the guard this package implements is only real if the app asks it.
  production: isProduction(),
});

if (resolved === undefined) throw configMissing();

export const pennant = createPennantBootstrap({ store: resolved.store });
export const featureManagerToken = pennant.pennantToken;
export const featureManagerProvider = pennant.pennantProvider;
