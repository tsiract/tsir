/**
 * Database bootstrap for the admin app.
 *
 * The framework's `createDatabaseBootstrap` does the heavy lifting: it parses
 * `config/database.ts` through the framework schema, builds the connections
 * registry with a deferred D1 driver, creates the Drizzle instance, and exposes
 * the DI tokens + value providers the app's modules wire in.
 *
 * `runtimeBindings` is the seam the handler fills from `env` on each request.
 * The optional `sqlitePath` lets CLI commands (`tsir migrate`, `tsir db:seed`)
 * fall back to a local SQLite file when no Cloudflare binding is available.
 */
import { createDatabaseBootstrap } from '@tsir/database';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import rawDatabaseConfig from './config/database.ts';

export const {
  databases,
  db,
  drizzle,
  dbToken,
  drizzleToken,
  dbProvider,
  drizzleProvider,
  runtimeBindings,
  MIGRATIONS_DIR,
} = createDatabaseBootstrap(rawDatabaseConfig, {
  migrationsDir: join(import.meta.dir, 'migrations'),
  sqlitePath: join(import.meta.dir, '..', '..', '..', '.tsir', 'admin.db'),
});

/** Type of the drizzle instance, for service constructor signatures. */
export type DrizzleDb = typeof drizzle;

/** Read the static `config.json` (captcha, support email, branding). */
export function readConfig(): Record<string, unknown> {
  const raw = readFileSync(join(import.meta.dir, 'config.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}
