/**
 * Build a connections registry from `config/database.ts`.
 *
 * This is the framework-side bootstrap the application used to write by hand
 * (a `database.ts` with lazy proxies and an `initDatabase(binding)` call). The
 * config already declares the driver and the binding name, so the framework can
 * create the connections and leave only the runtime binding to be supplied.
 *
 * D1 bindings arrive in `env` at request time, not at module load. The driver is
 * therefore deferred: the registry is built up front, but the real D1 driver is
 * only instantiated the first time a connection is used, by which point the
 * handler has made the binding available. Capabilities are static and known at
 * boot, so boot-time validation still works.
 */

import { createConnections, type ConnectionDefinition } from './connections.ts';
import { createD1Driver, D1_CAPABILITIES, type D1Like } from './d1.ts';
import { createHttpMysqlDriver } from './mysql.ts';
import { createHttpPostgresDriver, parsePostgresUrl } from './postgres-http.ts';
import { createSqliteDriver, SQLITE_CAPABILITIES, sqliteBegin, type SqliteLike } from './sqlite.ts';
import type { DbDriver, DbHealth, DbResult, DbStatement } from './driver.ts';
import type { DatabaseConfig } from './config.ts';
import { driverUnavailable } from './errors.ts';
import { TsirError } from '@tsir/core';

/**
 * The bindings the runtime hands to the handler. A plain record keyed by
 * binding name; the actual value is whatever the platform injected (a
 * `D1Database`, a `KVNamespace`, &c.).
 */
export type RuntimeBindings = Record<string, unknown>;

/**
 * Either bindings known at construction, or a getter that resolves them later.
 * The getter form is what lets D1 work: the registry is built at boot, but the
 * binding only becomes available on the first request.
 *
 * The getter may be **async** because one of its producers has to be: the CLI's local SQLite
 * fallback loads `bun:sqlite`, which cannot be imported statically without dragging a Bun builtin
 * into every bundle (`bootstrap.ts`). Every consumer of the resolved value is already a promise
 * (`query`, `batch`, `health`), so awaiting here costs nothing and keeps the builtin out of the
 * Workers graph — which is the point of the fallback existing at all.
 */
export type BindingsSource = RuntimeBindings | (() => RuntimeBindings | Promise<RuntimeBindings>);

async function resolveBindings(source: BindingsSource): Promise<RuntimeBindings> {
  return typeof source === 'function' ? await source() : source;
}

/**
 * A D1 driver whose binding is resolved lazily.
 *
 * The registry builds the `Database` eagerly and reads `capabilities` at boot
 * (they are static for D1), but the actual `D1Database` binding only becomes
 * available when the handler receives `env`. The first `query`/`batch`/`health`
 * call resolves the binding and builds the real driver; subsequent calls reuse
 * it.
 */
function deferredD1Driver(
  bindingName: string,
  bindings: BindingsSource,
  statementTimeoutMs: number,
): DbDriver {
  let real: DbDriver | null = null;

  /**
   * One promise for the whole process, so concurrent first queries share a single binding
   * resolution instead of racing to build two drivers.
   */
  let pending: Promise<DbDriver> | null = null;

  async function getDriver(): Promise<DbDriver> {
    if (real !== null) return real;

    pending ??= (async () => {
      const resolved = await resolveBindings(bindings);
      const binding = resolved[bindingName] as D1Like | undefined;
      if (binding === undefined) {
        throw driverUnavailable(
          'd1',
          'runtime',
          `binding "${bindingName}" is not available — pass it to the handler's env or provide it at boot`,
        );
      }
      real = createD1Driver({ binding, statementTimeoutMs });
      return real;
    })();

    try {
      return await pending;
    } catch (error: unknown) {
      // A failed resolution must not be cached: the binding may arrive on the next request,
      // which is exactly the sequence `deferred` exists to survive.
      pending = null;
      throw error;
    }
  }

  return {
    capabilities: D1_CAPABILITIES,
    async query(statement: DbStatement): Promise<DbResult> {
      return (await getDriver()).query(statement);
    },
    async batch(statements: readonly DbStatement[]): Promise<readonly DbResult[]> {
      return (await getDriver()).batch(statements);
    },
    async health(): Promise<DbHealth> {
      return (await getDriver()).health();
    },
    close(options?: { readonly timeoutMs?: number }): Promise<void> {
      return real?.close(options) ?? Promise.resolve();
    },
  };
}

/**
 * A sqlite driver whose file handle is resolved lazily, exactly as `deferredD1Driver` does for a
 * binding.
 *
 * Capabilities are static and known at boot (`SQLITE_CAPABILITIES`), so `declare()` still refuses
 * a component that needs something this engine lacks before the first query. The handle is looked
 * up under the connection's own name in the bindings record, so several sqlite connections in one
 * project are several files rather than one shared handle.
 */
function deferredSqliteDriver(connectionName: string, bindings: BindingsSource): DbDriver {
  let real: DbDriver | null = null;
  let pending: Promise<DbDriver> | null = null;

  async function getDriver(): Promise<DbDriver> {
    if (real !== null) return real;
    pending ??= (async () => {
      const resolved = await resolveBindings(bindings);
      // A caller-supplied handle wins: an application that opened the file itself may have tuned
      // it, or may be sharing it with a second driver.
      const supplied = resolved[connectionName];
      if (supplied !== undefined) {
        const driver = createSqliteDriver({ handle: supplied as SqliteLike });
        real = driver;
        return driver;
      }
      // No handle is an unanswered lookup, not an empty database: the driver cannot invent a
      // file, and guessing a path would open one nobody named. `createDatabaseBootstrap` supplies
      // the handle for a config that names a `url`; an application that builds the registry
      // directly passes its own.
      throw new TsirError(
        'DB_SQLITE_NO_HANDLE',
        `sqlite connection "${connectionName}" has no open file handle`,
        {
          kind: 'config',
          hint: `pass bindings: { ${connectionName}: new Sqlite(path) } — createDatabaseBootstrap opens \`database.connections.${connectionName}.url\` for you`,
          context: { connection: connectionName },
        },
      );
    })();
    try {
      return await pending;
    } catch (error: unknown) {
      // A handle may arrive on the next request in a platform that injects it, so a failed
      // resolution is not cached.
      pending = null;
      throw error;
    }
  }

  return {
    capabilities: SQLITE_CAPABILITIES,
    async query(statement: DbStatement): Promise<DbResult> {
      return (await getDriver()).query(statement);
    },
    async batch(statements: readonly DbStatement[]): Promise<readonly DbResult[]> {
      return (await getDriver()).batch(statements);
    },
    async health(): Promise<DbHealth> {
      return (await getDriver()).health();
    },
    /**
     * `SQLITE_CAPABILITIES.interactiveTx` is `true`, and `createDatabase` refuses a driver that
     * declares it without implementing it — so this must forward, not inherit. The boundary is
     * `sqliteBegin`, the same one the eager driver uses, so the two cannot disagree about the
     * rollback.
     */
    async begin<T>(work: (tx: DbDriver) => Promise<T>): Promise<T> {
      const driver = await getDriver();
      const resolved = await resolveBindings(bindings);
      const supplied = resolved[connectionName];
      if (supplied === undefined) {
        // The driver resolved, so a handle exists somewhere; the branch is unreachable unless a
        // consumer mutated the record between two reads, and throwing beats an assertion.
        throw new TsirError(
          'DB_SQLITE_NO_HANDLE',
          `sqlite connection "${connectionName}" has no handle`,
          {
            kind: 'config',
          },
        );
      }
      return sqliteBegin(supplied as SqliteLike, driver, work);
    },
    close(options?: { readonly timeoutMs?: number }): Promise<void> {
      return real?.close(options) ?? Promise.resolve();
    },
  };
}

/**
 * Turn one config entry into a connection definition the registry can use.
 *
 * The name is the map key, not a field on the definition (matching
 * `createConnections`' contract).
 */
function definitionFromConfig(
  name: string,
  config: DatabaseConfig['connections'][string],
  bindings: BindingsSource,
): ConnectionDefinition {
  if (config.driver === 'd1') {
    const bindingName = config.binding;
    if (bindingName === undefined) {
      throw new TsirError(
        'DB_D1_NO_BINDING',
        'database connection is D1 but has no `binding` set in config/database.ts',
        { kind: 'config', hint: 'add `binding: "<name>"` to the connection entry' },
      );
    }
    return {
      driver: deferredD1Driver(bindingName, bindings, config.statementTimeoutMs),
    };
  }

  // The three network engines are wired by `url`, and they share the HTTP transport: a Workers
  // bundle cannot open a socket, and on Lambda a pool per instance is the connection storm
  // `POOL_CEILING` exists to prevent. A pooler answers both, over HTTP (`DB-028`).
  return { driver: networkDriver(config, bindings, name) };
}

/**
 * The driver for a `url`-based connection.
 *
 * Split out so the `binding` branch above stays about bindings. `sqlite` is here rather than in
 * `from-config`'s caller because the config entry is what names it; where the file handle comes
 * from is a runtime question the caller answers.
 */
function networkDriver(
  config: DatabaseConfig['connections'][string],
  bindings: BindingsSource,
  connectionName: string,
): DbDriver {
  const url = config.url;
  if (url === undefined) {
    throw new TsirError(
      'DB_URL_REQUIRED',
      `database connection uses driver "${config.driver}" but has no \`url\` in config/database.ts`,
      {
        kind: 'config',
        hint: 'add `url: { fromEnv: "DATABASE_URL" }` — a secret never belongs in the file',
      },
    );
  }

  if (config.driver === 'sqlite') {
    // A path, not a transport. The handle is resolved through `bindings` under the connection's
    // own name, deferred for the same reason D1's is: opening the file needs `bun:sqlite`, which
    // cannot be imported statically here without dragging a Bun builtin into every bundle that
    // imports this module. `createDatabaseBootstrap` opens it when a `sqlitePath`/`url` is set.
    return deferredSqliteDriver(connectionName, bindings);
  }

  if (config.driver === 'postgres') {
    const parsed = parsePostgresUrl(url);
    return createHttpPostgresDriver({
      ...parsed,
      ...(config.statementTimeoutMs === undefined ? {} : { timeoutMs: config.statementTimeoutMs }),
    });
  }

  if (config.driver === 'mysql') {
    return createHttpMysqlDriver({
      url,
      ...(config.databaseName === undefined ? {} : { database: config.databaseName }),
      ...(config.statementTimeoutMs === undefined ? {} : { timeoutMs: config.statementTimeoutMs }),
    });
  }

  throw driverUnavailable(config.driver, 'config', 'no driver is registered for this engine');
}

/**
 * Build a connections registry from `config/database.ts`.
 *
 * ```ts
 * import { createConnectionsFromConfig } from '@tsir/database';
 * import config from './config/database.ts';
 *
 * // bindings resolved per-request by the handler
 * export const databases = createConnectionsFromConfig(config, () => runtimeBindings);
 * ```
 */
export function createConnectionsFromConfig(
  config: DatabaseConfig,
  bindings: BindingsSource,
): ReturnType<typeof createConnections> {
  const entries = Object.entries(config.connections).map(
    ([name, entry]) => [name, definitionFromConfig(name, entry, bindings)] as const,
  );

  return createConnections({
    default: config.default,
    connections: Object.fromEntries(entries),
  });
}
