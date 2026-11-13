/**
 * The distributed lock, and why it is its own port.
 *
 * The original design said the lock would reuse `@tsir/cache`. Building it showed that
 * it cannot: a lock needs a **conditional write** — "take this only if it is free" — and the cache
 * port has an atomic `increment` but an unconditional `set` and no compare-and-set, so a
 * cache-backed lock would be a read-then-write race dressed up as mutual exclusion. Rather than
 * widen five cache drivers to serve one caller, the lock became a port of its own with the two
 * drivers its callers actually need, and the decision record was amended in the same change.
 *
 * The contract is deliberately small, and every part of it is load-bearing:
 *
 *   · **`acquire` is atomic.** Two callers racing on one name get exactly one handle, and the
 *     loser gets `undefined` — never "I think you got it".
 *   · **A lock expires.** The TTL is the *crash* bound, not the expected duration: a process that
 *     dies mid-run must not hold the name until an operator notices. Because of that, a holder
 *     whose run outlives its TTL has already lost the lock, and `release` says so (`false`)
 *     instead of deleting someone else's.
 *   · **`release` is owner-checked.** Releasing by name alone is how a slow run deletes the lock
 *     of the run that replaced it, which silently re-enables the overlap the lock exists to stop.
 *   · **`shared` is a capability, not a hope.** A per-process lock cannot prevent overlap across
 *     isolates, so it says so and the scheduler refuses it in production.
 */

import { lockRefused } from './errors.ts';

export interface LockCapabilities {
  /** Visible to other processes — and to other isolates of the same Worker. */
  readonly shared: boolean;
  /** An expired lock can be taken without an operator (every driver here honours it). */
  readonly expiry: boolean;
}

export interface LockHandle {
  readonly name: string;
  /** Whatever identity the caller supplied; the scheduler uses a random id per run. */
  readonly owner: string;
  /** Epoch ms. After this, the lock may be taken by anyone. */
  readonly expiresAt: number;
}

export interface LockProvider {
  readonly name: string;
  readonly capabilities: LockCapabilities;
  /**
   * Take the lock, or `undefined` when someone else holds it.
   *
   * Atomic. An expired lock is treated as free, so a crashed holder never blocks the next tick.
   */
  acquire(input: {
    readonly name: string;
    readonly owner: string;
    readonly ttlMs: number;
    readonly now: number;
  }): Promise<LockHandle | undefined>;
  /** Give it up. `false` when this owner does not hold it (expired, taken over, or never held). */
  release(input: {
    readonly name: string;
    readonly owner: string;
    readonly now: number;
  }): Promise<boolean>;
  /** Who holds it right now, for `tsir schedule:list`. */
  inspect(name: string, now: number): Promise<LockHandle | undefined>;
  /** Every live lock, for `tsir schedule:list`. Bounded by the number of tasks. */
  list(now: number): Promise<readonly LockHandle[]>;
}

/**
 * A lock in one process's memory: `make dev`, tests, and a single-instance deployment that has
 * exactly one process.
 *
 * `shared: false` is the whole story — see `createScheduler`'s production guard.
 */
export function memoryLock(
  options: { readonly now?: (() => number) | undefined } = {},
): LockProvider {
  const held = new Map<string, LockHandle>();
  const now = options.now ?? ((): number => Date.now());

  const live = (name: string, at: number): LockHandle | undefined => {
    const handle = held.get(name);
    if (handle === undefined) return undefined;
    if (handle.expiresAt <= at) {
      // Expiry is read-time: nothing has to sweep for a crashed holder to stop blocking.
      held.delete(name);
      return undefined;
    }
    return handle;
  };

  return {
    name: 'memory',
    capabilities: { shared: false, expiry: true },

    acquire(input) {
      const at = input.now || now();
      if (live(input.name, at) !== undefined) return Promise.resolve(undefined);
      const handle: LockHandle = {
        name: input.name,
        owner: input.owner,
        expiresAt: at + input.ttlMs,
      };
      held.set(input.name, handle);
      return Promise.resolve(handle);
    },

    release(input) {
      const current = live(input.name, input.now || now());
      if (current === undefined || current.owner !== input.owner) return Promise.resolve(false);
      held.delete(input.name);
      return Promise.resolve(true);
    },

    inspect(name, at) {
      return Promise.resolve(live(name, at));
    },

    list(at) {
      return Promise.resolve(
        [...held.keys()]
          .map((name) => live(name, at))
          .filter((handle): handle is LockHandle => handle !== undefined),
      );
    },
  };
}

/** The slice of `@tsir/database` this driver needs — `{ capabilities, query }`, structurally. */
export interface LockSqlStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface LockSqlResult {
  readonly rows: readonly unknown[];
  readonly changes: number;
}

export interface LockSql {
  readonly capabilities: {
    /**
     * Any SQL engine. These channels branch on `placeholder`, never on the engine name, so
     * narrowing to `d1 | postgres` would reject a `mysql` or `sqlite` connection that works
     * (`CAP-009`). `@tsir/migrate` keeps the narrow pair: its state table really does have two
     * dialects.
     */
    readonly engine: 'd1' | 'postgres' | 'mysql' | 'sqlite';
    readonly placeholder: 'question' | 'dollar';
  };
  query(statement: LockSqlStatement): Promise<LockSqlResult>;
}

export interface DatabaseLockOptions {
  readonly sql: LockSql;
  /** Default `schedule_locks`. */
  readonly table?: string | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * The DDL the `database` lock needs. One row per task, reused forever — an expired row is
 * overwritten by the next acquire, so the table stays the size of the schedule.
 */
export function scheduleLockDdl(
  options: {
    readonly engine: LockSql['capabilities']['engine'];
    readonly table?: string | undefined;
  } = { engine: 'postgres' },
): readonly string[] {
  const table = options.table ?? 'schedule_locks';
  const bigint = options.engine === 'postgres' ? 'BIGINT' : 'INTEGER';

  return [
    `CREATE TABLE IF NOT EXISTS ${table} (\n  name TEXT PRIMARY KEY,\n  owner TEXT NOT NULL,\n  expires_at ${bigint} NOT NULL\n)`,
    // The acquire's `WHERE expires_at <= ?` reads this; without it a growing table makes every
    // tick a scan.
    `CREATE INDEX IF NOT EXISTS ${table}_expiry ON ${table} (expires_at)`,
  ];
}

/**
 * A lock in a table, which is the only one that is honest across isolates.
 *
 * Acquire is a single upsert with a `WHERE` on the *existing* row: it inserts when the name is
 * free and updates when the row has expired, atomically, in one statement. That is why this
 * supports `d1` and `postgres` and refuses anything else — MySQL's `ON DUPLICATE KEY UPDATE` has
 * no `WHERE`, so the same statement would take a live lock (`SCHED_LOCK_REFUSED` rather than a
 * silently broken guarantee).
 */
export function databaseLock(options: DatabaseLockOptions): LockProvider {
  const { sql } = options;
  const table = options.table ?? 'schedule_locks';
  const engine = sql.capabilities.engine;
  const now = options.now ?? ((): number => Date.now());

  if (engine !== 'd1' && engine !== 'postgres') {
    throw lockRefused(
      'database',
      `the "${String(engine)}" engine cannot express a conditional upsert, so acquire would take a live lock`,
    );
  }

  const dollar = sql.capabilities.placeholder === 'dollar';
  const p = (index: number): string => (dollar ? `$${String(index)}` : '?');

  const run = async (
    statement: string,
    params: readonly unknown[] = [],
  ): Promise<readonly Record<string, unknown>[]> => {
    const result = await sql.query({ sql: statement, params });
    return result.rows as readonly Record<string, unknown>[];
  };

  const toHandle = (row: Record<string, unknown> | undefined): LockHandle | undefined => {
    if (row === undefined) return undefined;
    return {
      name: String(row['name']),
      owner: String(row['owner']),
      // coercion-ok: `expires_at` is an integer column, not application data.
      expiresAt: Number(row['expires_at']),
    };
  };

  return {
    name: 'database',
    capabilities: { shared: true, expiry: true },

    async acquire(input) {
      const at = input.now || now();
      const expiresAt = at + input.ttlMs;
      // One statement, so there is no window between "is it free?" and "take it". `RETURNING`
      // is what distinguishes "I won" from "the WHERE matched nothing": an upsert that changed
      // nothing and one that changed a row return the same `changes` on some drivers.
      const rows = await run(
        `INSERT INTO ${table} (name, owner, expires_at) VALUES (${p(1)}, ${p(2)}, ${p(3)}) ` +
          `ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at ` +
          `WHERE expires_at <= ${p(4)} ` +
          `RETURNING name, owner, expires_at`,
        [input.name, input.owner, expiresAt, at],
      );
      return toHandle(rows[0]);
    },

    async release(input) {
      const at = input.now || now();
      // `owner` and a live expiry are both in the `WHERE`: a run that lost its lock to the clock
      // must not delete the row the *next* run now owns.
      const rows = await run(
        `DELETE FROM ${table} WHERE name = ${p(1)} AND owner = ${p(2)} AND expires_at > ${p(3)} RETURNING name`,
        [input.name, input.owner, at],
      );
      return rows.length > 0;
    },

    async inspect(name, at) {
      const rows = await run(
        `SELECT name, owner, expires_at FROM ${table} WHERE name = ${p(1)} AND expires_at > ${p(2)}`,
        [name, at],
      );
      return toHandle(rows[0]);
    },

    async list(at) {
      const rows = await run(
        `SELECT name, owner, expires_at FROM ${table} WHERE expires_at > ${p(1)} ORDER BY name ASC`,
        [at],
      );
      return rows
        .map((row) => toHandle(row))
        .filter((handle): handle is LockHandle => handle !== undefined);
    },
  };
}
