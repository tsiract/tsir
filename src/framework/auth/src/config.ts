/**
 * `sessions.store` and `apiKeys.store` in `tsir.js` — the registry half of `@tsir/auth` (`CAP-018`).
 *
 * The package shipped two stores per concern and no way to name one from a file, so every app
 * constructed them by hand. That is not a small inconvenience: the production guard had nowhere to
 * live, so `memorySessionStore` was a legal choice for a deployed app — and a session in one
 * process means the next request lands on an instance that has never heard of it. The user is
 * logged out, at random, and nothing in the logs says why.
 *
 * ## One port, two concerns
 *
 * Sessions and API keys are separate questions — an app may well keep sessions in Redis and keys in
 * Postgres — so each gets its own block. They share this module because they share the SQL port:
 * `@tsir/database`'s `Database` satisfies both structurally, and duplicating the placeholder logic
 * twice is how the two would drift apart.
 *
 * ## `memory` is refused in production
 *
 * Both stores are a `Map`. On a server with one long-lived process that is a legitimate choice; on
 * a Worker it is not a store at all, and on any target a restart logs everyone out. `database` is
 * the default everywhere, and `d1`/`sqlite`/`postgres`/`mysql` all speak the SQL these stores use.
 */

import { TsirError } from '@tsir/container';

import { databaseApiKeyStore } from './drivers/keys-database.ts';
import { memoryApiKeyStore } from './drivers/keys-memory.ts';
import { databaseSessionStore, type SessionSql } from './drivers/session-database.ts';
import { memorySessionStore } from './drivers/session-memory.ts';
import { driverMissing, forbiddenInProduction } from './errors.ts';
import type { ApiKeyStore } from './keys.ts';
import type { SessionStore } from './session.ts';

/** Every session store this build ships, in the order an error message lists them. */
export const SESSION_DRIVERS = ['database', 'memory'] as const;

/** Every API-key store this build ships. */
export const API_KEY_DRIVERS = ['database', 'memory'] as const;

/** The stores that survive a restart. */
export const PERSISTENT_AUTH_DRIVERS: readonly string[] = ['database'];

/** One `sessions.store` entry, as configuration sees it. */
export interface ConfiguredAuthStore {
  /**
   * As written in `tsir.js`. Typed `string`, not the union: an unknown name must fail with a
   * message that lists the real ones, and narrowing here only moves the failure somewhere with
   * less to say.
   */
  readonly driver: string;
  /** The table a `database` store reads. `tsir_sessions` / `tsir_api_keys` by default. */
  readonly table?: string | undefined;
  /** The connection name an app resolves for a `database` store. Informational here. */
  readonly connection?: string | undefined;
}

/**
 * The SQL port both stores need, built from a `@tsir/database` connection.
 *
 * Passed in rather than imported, so this package keeps its promised absence of a database
 * dependency — a test supplies a double, and an app supplies its own connection.
 */
export type AuthQuery = SessionSql['query'];

export interface AuthStoreBuildOptions<T extends ConfiguredAuthStore> {
  readonly store: T | undefined;
  /** Omitted only when the store is `memory`, which needs no SQL at all. */
  readonly sql?:
    { readonly capabilities: SessionSql['capabilities']; readonly query: AuthQuery } | undefined;
  /** `isProduction()` from `@tsir/core`. Opt-in, so a test can build the stores it wants. */
  readonly production?: boolean | undefined;
}

function sqlFor(
  name: string,
  options: { readonly sql?: AuthStoreBuildOptions<ConfiguredAuthStore>['sql'] },
): SessionSql {
  if (options.sql === undefined) {
    // A `database` store with no connection would answer "no session" for every request — every
    // user logged out — and "no key" for every key. Refusing here names the missing wire.
    throw new TsirError(
      'AUTH_CONFIG_INVALID',
      `the "${name}" store uses the \`database\` driver but no SQL connection was supplied`,
      {
        kind: 'capability',
        hint: "pass the app's connection, e.g. `sql: databases.defaultDatabase`",
        context: { store: name },
      },
    );
  }
  return options.sql;
}

/**
 * The session store the project names, or `undefined` when it declares no `sessions.store`.
 *
 * `undefined` rather than a memory store: an app that never configured sessions should not get a
 * store that works in dev and logs everyone out in production. The app's own bootstrap decides
 * what to do about it.
 */
export function sessionStoreFromConfig(
  options: AuthStoreBuildOptions<ConfiguredAuthStore>,
): SessionStore | undefined {
  const config = options.store;
  if (config === undefined) return undefined;
  switch (config.driver) {
    case 'memory':
      if (options.production === true) throw forbiddenInProduction('memory');
      return memorySessionStore();
    case 'database':
      return databaseSessionStore(sqlFor('sessions', options), {
        ...(config.table === undefined ? {} : { table: config.table }),
      });
    default:
      throw driverMissing(config.driver, SESSION_DRIVERS);
  }
}

/** The API-key store the project names, on the same terms as the session store. */
export function apiKeyStoreFromConfig(
  options: AuthStoreBuildOptions<ConfiguredAuthStore>,
): ApiKeyStore | undefined {
  const config = options.store;
  if (config === undefined) return undefined;
  switch (config.driver) {
    case 'memory':
      if (options.production === true) throw forbiddenInProduction('memory');
      return memoryApiKeyStore();
    case 'database':
      return databaseApiKeyStore(sqlFor('api keys', options), {
        ...(config.table === undefined ? {} : { table: config.table }),
      });
    default:
      throw driverMissing(config.driver, API_KEY_DRIVERS);
  }
}
