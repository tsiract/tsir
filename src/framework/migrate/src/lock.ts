/**
 * The advisory lock (`MIG-003`).
 *
 * Two runners applying the same migration is not a race that ends well: both read
 * "not applied", both run the DDL, and the loser fails halfway through with the
 * schema in an undefined state. Postgres has the primitive for this —
 * `pg_advisory_lock` — and it is session-scoped, so it disappears when the
 * connection dies rather than leaving a stale row behind the way a lock table
 * would.
 *
 * D1 has no advisory locks. That is *stated*, not worked around: a D1 deployment
 * runs migrations from one place (the migrate unit, `MIG-012`), and pretending
 * otherwise would be a lock that never blocks. `acquireMigrationLock` therefore
 * reports whether it actually locked, and the CLI says so.
 *
 * The key is derived from the application name so two applications sharing a
 * database do not lock each other out, and is stable across processes and
 * machines because it is a plain hash of a string — no randomness, no registry.
 */

import { TsirError } from '@tsir/container';
import { statement, type Database } from '@tsir/database';

import { bind, type Engine } from './state.ts';

/** FNV-1a, 64-bit, returned as a signed bigint (Postgres `bigint` range). */
export function advisoryLockKey(name: string): bigint {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const byte of new TextEncoder().encode(name)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x0000_0100_0000_01b3n);
  }
  return BigInt.asIntN(64, hash);
}

export interface LockHandle {
  readonly acquired: boolean;
  /** False on engines without advisory locks (D1) — the caller must say so. */
  readonly supported: boolean;
  release(): Promise<void>;
}

/**
 * Takes the lock, or reports that someone else holds it.
 *
 * `waitMs` is a bounded wait rather than an unbounded one: a migration runner that
 * hangs forever holds a deployment open with no output, which is indistinguishable
 * from a hung deploy. `pg_try_advisory_lock` in a loop keeps the semantics simple
 * (one round trip per attempt, no server-side waits to time out).
 */
export async function acquireMigrationLock(
  database: Database,
  options: {
    /** Application name — the first half of the key. */
    readonly name: string;
    /**
     * Connection name — the second half (`MIG-015`).
     *
     * Two connections of one application must not exclude each other: `app` on D1
     * and `reporting` on Postgres have separate journals and separate DDL, so one
     * lock for both would serialise unrelated deployments. Defaults to the
     * database's own name, which is the name the registry gave it.
     */
    readonly connection?: string;
    readonly waitMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    /** Clock for the wait deadline (CFG-011). Default `Date.now`; tests fix it. */
    readonly now?: () => number;
  },
): Promise<LockHandle> {
  const engine: Engine = database.capabilities.engine;

  if (engine !== 'postgres') {
    return {
      acquired: true,
      supported: false,
      async release(): Promise<void> {
        // Nothing to release: there is no lock.
      },
    };
  }

  const connection = options.connection ?? database.name;
  const id = advisoryLockKey(`${options.name}:${connection}`);
  const now = options.now ?? ((): number => Date.now());
  const deadline = now() + (options.waitMs ?? 0);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (;;) {
    const result = await database.query(
      statement(`select pg_try_advisory_lock(${bind(engine, 1)}) as locked`, [id.toString()]),
    );
    const locked = readBoolean(result.rows[0], 'locked');
    if (locked) {
      return {
        acquired: true,
        supported: true,
        async release(): Promise<void> {
          await database.query(
            statement(`select pg_advisory_unlock(${bind(engine, 1)}) as released`, [id.toString()]),
          );
        },
      };
    }
    if (now() >= deadline) {
      return { acquired: false, supported: true, release: async () => undefined };
    }
    await sleep(250);
  }
}

function readBoolean(row: unknown, column: string): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const value = (row as Record<string, unknown>)[column];
  // postgres.js returns booleans; a fake or a proxy may hand back 't'/'f'.
  return value === true || value === 't' || value === 1;
}

/** A lock that could not be taken is not an error — a second runner exits 0. */
export function lockHeldMessage(name: string, connection?: string): string {
  return connection === undefined
    ? `another migration is in progress for "${name}"`
    : `another migration is in progress for "${name}" on connection "${connection}"`;
}

/** Raised only when a caller explicitly requires the lock and cannot have it. */
export function lockUnsupported(engine: Engine): TsirError {
  return new TsirError(
    'DB_MIGRATION_LOCK_UNSUPPORTED',
    `${engine} has no advisory locks, so concurrent runners cannot be excluded`,
    {
      kind: 'database',
      hint: 'run migrations from exactly one place',
    },
  );
}
