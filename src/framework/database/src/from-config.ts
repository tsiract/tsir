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
 * Turn one config entry into a connection definition the registry can use.
 *
 * The name is the map key, not a field on the definition (matching
 * `createConnections`' contract).
 */
function definitionFromConfig(
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

  // Postgres is wired by URL. The client is created eagerly because it has its
  // own lazy connection pool — no binding to wait for.
  throw driverUnavailable(
    'postgres',
    'config',
    'postgres bootstrap from config is not yet wired — pass a driver directly via createConnections()',
  );
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
    ([name, entry]) => [name, definitionFromConfig(entry, bindings)] as const,
  );

  return createConnections({
    default: config.default,
    connections: Object.fromEntries(entries),
  });
}
