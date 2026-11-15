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
import { openSqliteFiles } from '@tsir/database/bun';
import { createQueryMonitor } from '@tsir/telemetry';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import rawDatabaseConfig from './config/database.ts';

export const {
  databases,
  db,
  dbFor,
  connection,
  connectionFor,
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
  openSqlite: openSqliteFiles,
  // Every statement the connection reports reaches the monitor (`DX-014`). The default is
  // `logging: 'slow'`, so routine traffic costs one `shouldLog` test and nothing else; failures and
  // slow statements are always reported (`DX-015`).
  log: (event) => {
    if (event.event === 'db.query') void queryMonitor.record(event);
  },
});

/**
 * Query timings for the admin app's monitor page (`DX-014`).
 *
 * Constructed after the bootstrap because it writes through the same Drizzle instance — and it
 * excludes its own insert, or the first query would record itself forever.
 */
export const queryMonitor = createQueryMonitor({ drizzle: drizzle, engine: 'd1' });

/** Type of the drizzle instance, for service constructor signatures. */
export type DrizzleDb = typeof drizzle;

/** Read the static `config.json` (captcha, support email, branding). */
export function readConfig(): Record<string, unknown> {
  const raw = readFileSync(join(import.meta.dir, 'config.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}
