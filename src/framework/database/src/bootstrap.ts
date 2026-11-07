/**
 * One-call database bootstrap for apps that use `@tsir/database`.
 *
 * This replaces the hand-written `database.ts` every app previously needed:
 * it parses the config through the framework schema, builds the connections
 * registry with a deferred D1 driver, creates the Drizzle instance, and
 * exposes the DI tokens + value providers the rest of the app wires into its
 * modules.
 *
 * The only app-specific inputs are the raw config (from `config/database.ts`)
 * and the path to the migrations folder. An optional `sqlitePath` enables the
 * local D1-over-SQLite fallback so CLI commands (`tsir migrate`, `tsir db:seed`)
 * work without a Cloudflare account.
 */

import { Database as Sqlite } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { createConnectionsFromConfig } from './from-config.ts';
import { createDrizzle } from './drizzle.ts';
import { databaseConfigSchema } from './config.ts';
import type { RuntimeBindings } from './from-config.ts';
import type { Database } from './database.ts';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { createSqliteBinding } from './sqlite-binding.ts';

/** Options for `createDatabaseBootstrap`. */
export interface DatabaseBootstrapOptions {
  /** Absolute path to the app's `migrations/` directory. */
  readonly migrationsDir: string;
  /**
   * Path to a local SQLite file used as a D1 fallback binding for CLI/dev.
   * When omitted, the fallback is disabled and a missing runtime binding
   * throws on first query (correct for Cloudflare-only deployments).
   */
  readonly sqlitePath?: string;
}

/** Everything an app needs to wire its database layer. */
export interface DatabaseBootstrap {
  /** Connections registry — exported for CLI commands (`tsir migrate`, &c.). */
  readonly databases: ReturnType<typeof createConnectionsFromConfig>;
  /** The default connection's `Database` — services query against this. */
  readonly db: Database;
  /** Drizzle bound to the default connection. */
  readonly drizzle: SqliteRemoteDatabase<Record<string, unknown>>;
  /** DI token for `db`. */
  readonly dbToken: Token<Database>;
  /** DI token for `drizzle`. */
  readonly drizzleToken: Token<SqliteRemoteDatabase<Record<string, unknown>>>;
  /** Value provider for `db`. */
  readonly dbProvider: Provider<Database>;
  /** Value provider for `drizzle`. */
  readonly drizzleProvider: Provider<SqliteRemoteDatabase<Record<string, unknown>>>;
  /**
   * Mutable bindings record. The handler copies `env` into it per request; the
   * deferred D1 driver reads from the accessor below on first query.
   */
  readonly runtimeBindings: RuntimeBindings;
  /** Path to the migrations directory — exported for `tsir migrate`. */
  readonly MIGRATIONS_DIR: string;
}

/**
 * Build the full database layer from `config/database.ts`.
 *
 * ```ts
 * // database.ts
 * import { createDatabaseBootstrap } from '@tsir/database';
 * import config from './config/database.ts';
 * import { join } from 'node:path';
 *
 * export const {
 *   databases, db, drizzle, dbToken, drizzleToken,
 *   dbProvider, drizzleProvider, runtimeBindings, MIGRATIONS_DIR,
 * } = createDatabaseBootstrap(config, {
 *   migrationsDir: join(import.meta.dir, 'migrations'),
 *   sqlitePath: join(import.meta.dir, '..', '..', '..', '.tsir', 'admin.db'),
 * });
 * export type DrizzleDb = typeof drizzle;
 * ```
 */
export function createDatabaseBootstrap(
  rawConfig: unknown,
  options: DatabaseBootstrapOptions,
): DatabaseBootstrap {
  // Parse through the framework schema so defaults and validation run at import.
  const config = databaseConfigSchema.parse(rawConfig);

  const runtimeBindings: RuntimeBindings = {};

  const bindings = (): RuntimeBindings => {
    // 1. Runtime bindings set by the handler from `env`.
    if (Object.keys(runtimeBindings).length > 0) return runtimeBindings;
    // 2. Test / CLI fixture binding.
    const globalBinding = (globalThis as { __binding?: unknown }).__binding;
    if (globalBinding !== undefined) return { DB: globalBinding };
    // 3. Local SQLite fallback so CLI commands work without Cloudflare.
    if (options.sqlitePath !== undefined) {
      try {
        const dbDir = dirname(options.sqlitePath);
        if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
        const sqlite = new Sqlite(options.sqlitePath);
        return { DB: createSqliteBinding(sqlite) };
      } catch {
        return runtimeBindings;
      }
    }
    return runtimeBindings;
  };

  const databases = createConnectionsFromConfig(config, bindings);
  const db = databases.defaultDatabase;
  const drizzle = createDrizzle(db);

  const dbToken = token<Database>('db');
  const drizzleToken = token<typeof drizzle>('drizzle');
  const dbProvider = valueProvider(dbToken, db);
  const drizzleProvider = valueProvider(drizzleToken, drizzle);

  return {
    databases,
    db,
    drizzle,
    dbToken,
    drizzleToken,
    dbProvider,
    drizzleProvider,
    runtimeBindings,
    MIGRATIONS_DIR: options.migrationsDir,
  };
}
