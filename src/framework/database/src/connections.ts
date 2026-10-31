/**
 * Named connections (`DB-019`, ADR-0019).
 *
 * A project can hold several databases — `app` on D1, `reporting` on Postgres — and
 * a query must say which one it means. This module is the registry that makes the
 * name real: every connection is built once at boot, so an unknown name fails at
 * the first call instead of at the first request that happened to use it.
 *
 * What this deliberately does **not** do:
 *
 * - No ambient context. There is no "current connection" that a query inherits
 *   implicitly, because the one thing worse than naming a connection everywhere is
 *   not knowing which one a stray query landed on (ADR-0019 § 3).
 * - No lazy drivers. A connection that only failed once someone used it would move
 *   a boot error to production; the registry builds every driver eagerly and
 *   `close()` drains every one of them.
 * - No cross-connection transactions. `registry.connection('a').interactiveTx(...)`
 *   opens a transaction on `a` only; touching `b` inside it is a second, unrelated
 *   transaction (ADR-0019 § 6).
 */

import { createDatabase, type Database, type DatabaseOptions } from './database.ts';
import type { DbDriver, DbHealth } from './driver.ts';
import {
  connectionRequirementsMissing,
  noConnections,
  unknownConnection,
  unknownDefaultConnection,
} from './errors.ts';

/**
 * One entry of `database.connections`.
 *
 * Everything `createDatabase` accepts except the driver (which every entry must
 * name) and the registry plumbing (`name`, `lookup`), which the registry owns.
 */
export interface ConnectionDefinition extends Omit<DatabaseOptions, 'driver' | 'name' | 'lookup'> {
  readonly driver: DbDriver;
}

export interface ConnectionsOptions<C extends Record<string, ConnectionDefinition>> {
  readonly connections: C;
  /** Required and must exist (ADR-0019 § 1). There is no "first key wins". */
  readonly default: keyof C & string;
}

/** Shutdown budget for the whole registry. */
export interface RegistryCloseOptions {
  /** Total time for all connections. Default: the registry's own 5 s budget. */
  readonly timeoutMs?: number | undefined;
}

export interface Connections<Names extends string = string> {
  /** Declared names, in declaration order — the exact list errors print. */
  readonly names: readonly Names[];
  readonly default: Names;
  /** The connection every unnamed call site uses. */
  readonly defaultDatabase: Database<Names>;
  /** Same contract as the default: same `batch`, that driver's capabilities. */
  connection(name: Names): Database<Names>;
  /** `SELECT 1` per connection. Never throws — a down database is data. */
  health(): Promise<{ readonly [K in Names]: DbHealth }>;
  /**
   * Drains and closes every connection, `default` first.
   *
   * `timeoutMs` is **one budget for the whole registry**, not one per connection:
   * with three connections the naive version waits three times as long, and a
   * wedged reporting client would hold shutdown open while the process is already
   * refusing traffic (`DB-021`).
   */
  close(options?: RegistryCloseOptions): Promise<void>;
}

/** Matches `Database`'s own default drain, so a registry of one behaves the same. */
const DEFAULT_CLOSE_MS = 5_000;

/**
 * Builds every declared connection eagerly and returns the registry.
 *
 * Eager on purpose: a broken URL or a capability lie must fail at boot, when the
 * process has not served anything yet and the error is still cheap.
 */
export function createConnections<const C extends Record<string, ConnectionDefinition>>(
  input: ConnectionsOptions<C>,
): Connections<keyof C & string> {
  type Names = keyof C & string;

  const names = Object.keys(input.connections) as Names[];
  if (names.length === 0) throw noConnections();

  const defaultName = input.default;
  if (!names.includes(defaultName)) throw unknownDefaultConnection(defaultName, names);

  const built = new Map<Names, Database<Names>>();

  const resolve = (name: string): Database<Names> => {
    const found = built.get(name);
    if (found === undefined) throw unknownConnection(name, names);
    return found;
  };

  const order: readonly Names[] = [defaultName, ...names.filter((name) => name !== defaultName)];
  for (const name of order) {
    const definition = input.connections[name];
    // Unreachable after the `names` check above; typed anyway because a registry
    // that silently skipped an entry would be worse than a compile error.
    if (definition === undefined) throw unknownConnection(name, names);
    const { driver, ...rest } = definition;
    built.set(name, createDatabase<Names>({ ...rest, driver, name, lookup: resolve }));
  }

  const connections: Connections<Names> = {
    names,
    default: defaultName,
    get defaultDatabase() {
      return resolve(defaultName);
    },
    connection: resolve,
    async health() {
      const entries = await Promise.all(
        names.map(async (name) => [name, await resolve(name).health()] as const),
      );
      return Object.fromEntries(entries) as { readonly [K in Names]: DbHealth };
    },
    async close(closeOptions) {
      // Sequential and default-first: the default connection is the one the
      // application's request path uses, so it should stop accepting work before
      // the reporting connection it might have fanned out to.
      //
      // The budget is shared: each connection gets what is left of it, so three
      // wedged clients cannot turn a 5 s shutdown into 15 s.
      const deadline = Date.now() + (closeOptions?.timeoutMs ?? DEFAULT_CLOSE_MS);
      let failure: unknown;
      for (const name of order) {
        try {
          await resolve(name).close({ drainTimeoutMs: Math.max(0, deadline - Date.now()) });
        } catch (error: unknown) {
          failure ??= error;
        }
      }
      // Re-thrown after every connection was closed: a failed drain of one must
      // not leave the others open. A non-Error rejection is wrapped rather than
      // re-thrown, because a throwable that is not an Error loses its stack.
      if (failure !== undefined) {
        throw failure instanceof Error
          ? failure
          : new Error('closing the database registry failed', { cause: failure });
      }
    },
  };

  return connections;
}

/**
 * One component's declared needs, per connection (`DB-020`).
 *
 * `connection` is optional and means "the registry default", so the common case
 * stays a one-line declaration. Naming a connection that does not exist is not a
 * capability failure: it is a typo, and it throws `DB_UNKNOWN_CONNECTION` with the
 * declared names.
 */
export interface ConnectionRequirement<Names extends string = string> {
  readonly component: string;
  readonly connection?: Names | undefined;
  readonly interactiveTx?: boolean;
}

/**
 * The per-connection boot check (`DB-020`).
 *
 * The single-connection `assertRequirements()` answers "can this driver do it?".
 * With a registry the useful question is "can *that* connection do it?", because
 * the same process legitimately holds a D1 connection and a Postgres one. Every
 * unsatisfied pair is reported in one error, with the connection name — the fix is
 * to move one component, and that is only obvious when the name is printed.
 */
export function assertConnectionRequirements<Names extends string>(
  connections: Connections<Names>,
  requirements: readonly ConnectionRequirement<Names>[],
): void {
  const unsatisfied: { component: string; connection: string; engine: string }[] = [];

  for (const requirement of requirements) {
    if (requirement.interactiveTx !== true) continue;

    const name = requirement.connection ?? connections.default;
    // Resolves first: an unknown name must fail as a name, not be counted as a
    // missing capability and reported with a confusing hint about BEGIN.
    const database = connections.connection(name);
    if (database.capabilities.interactiveTx) continue;

    unsatisfied.push({
      component: requirement.component,
      connection: name,
      engine: database.capabilities.engine,
    });
  }

  if (unsatisfied.length > 0) throw connectionRequirementsMissing(unsatisfied);
}
