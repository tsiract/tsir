/**
 * The SQL side of rotation (`VLT-019`, `VLT-021`, `VLT-024`).
 *
 * `@tsir/vault` owns the *algorithm* — watermark batching, idempotence, resume — and
 * speaks to storage through a `RotationStore` port. This file is that port for the
 * two engines Tsir ships, and it is here rather than in `vault` for one reason:
 * `database` may import `vault` (the codec seam already does), while the reverse
 * arrow would make the dependency graph cyclic — and a crypto package that cannot
 * name a table is a crypto package that stays testable.
 *
 * Three things live in SQL and nowhere else:
 *
 * 1. **The ledger table.** `(table_name, column_name, row_key)` is the primary key,
 *    so a row cannot be recorded twice and a resumed run cannot double-count.
 * 2. **Atomic commit.** Rewriting the value and recording the ledger entry are one
 *    `batch()` — one transaction on D1, one transaction on Postgres. A crash between
 *    them is exactly the state this table exists to make impossible.
 * 3. **The lock.** `withLock` holds a **session-scoped** advisory lock: it pins one
 *    connection for the whole target, because a lock taken on a pooled connection
 *    that then hands the work to another one is not a lock. D1 has no advisory locks
 *    and does not need one — a D1 database has a single writer per location.
 */

import { TsirError } from '@tsir/core';
import {
  ROTATION_LEDGER,
  type RotationRow,
  type RotationScope,
  type RotationStore,
  type RotationTarget,
} from '@tsir/vault';

import type { Database } from './database.ts';
import { statement, type DbStatement } from './driver.ts';

/** What the caller hands over: a database and the columns to rotate. */
export interface RotationStoreOptions {
  /** The connection that owns the tables. Use `database.connection(name)` for a registry. */
  readonly table: string;
  readonly column: string;
  readonly keyColumn?: string | undefined;
}

const LEDGER_COLUMNS = ['table_name', 'column_name', 'row_key', 'key_id', 'rotated_at'] as const;

/** 64-bit FNV-1a: stable across processes, dialects and restarts. */
export function advisoryLockKey(name: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(name)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  // Postgres advisory locks take a signed bigint.
  return hash >= 0x8000000000000000n ? hash - 0x10000000000000000n : hash;
}

function rotationLockedError(table: string, column: string): TsirError {
  return new TsirError(
    'VLT_ROTATION_LOCKED',
    `another rotation is running for ${table}.${column}`,
    {
      kind: 'vault',
      hint: 'wait for it to finish, or run with --wait; only one runner may rewrite a column',
      context: { table, column },
    },
  );
}

/**
 * Builds the store for one target.
 *
 * The target is fixed here rather than passed per call so that the SQL — and its
 * identifier handling — is written once, next to the validation that makes it safe.
 */
export function createRotationStore(
  database: Database,
  options: RotationStoreOptions,
): RotationStore & {
  readonly target: RotationTarget;
  /** Rows still naming one key id — the count `vault:key:retire` refuses on. */
  countKey(keyId: string): Promise<number>;
} {
  const table = assertIdentifier(options.table, 'table');
  const column = assertIdentifier(options.column, 'column');
  const keyColumn = assertIdentifier(options.keyColumn ?? 'id', 'keyColumn');
  const target: RotationTarget = { table, column, keyColumn };

  const postgres = database.capabilities.engine === 'postgres';
  const placeholder = (index: number): string =>
    database.capabilities.placeholder === 'dollar' ? `$${String(index)}` : '?';

  const ledgerDdl = postgres
    ? `create table if not exists ${ROTATION_LEDGER} (
         table_name text not null,
         column_name text not null,
         row_key text not null,
         key_id text not null,
         rotated_at bigint not null,
         primary key (table_name, column_name, row_key)
       )`
    : `create table if not exists ${ROTATION_LEDGER} (
         table_name text not null,
         column_name text not null,
         row_key text not null,
         key_id text not null,
         rotated_at integer not null,
         primary key (table_name, column_name, row_key)
       )`;

  function scopeFor(run: Database): RotationScope {
    return {
      async batch(activeKeyId, after, limit): Promise<readonly RotationRow[]> {
        // Indexes are allocated as the SQL is built: the engine passes the same
        // list to `$n` and to `?`, so a parameter's position is never guessed.
        const params: unknown[] = [];
        const bind = (value: unknown): string => {
          params.push(value);
          return placeholder(params.length);
        };

        const where = [
          `${column} is not null`,
          `${column} not like ${bind(`tsir:v1:${activeKeyId}:%`)}`,
        ];
        if (after !== undefined) where.push(`${keyColumn} > ${bind(after)}`);
        const limitPlaceholder = bind(limit);

        const result = await run.query({
          sql: `select ${keyColumn} as row_key, ${column} as value
                  from ${table}
                 where ${where.join(' and ')}
                 order by ${keyColumn}
                 limit ${limitPlaceholder}`,
          params,
        });

        // The watermark column is typed by the schema (int, uuid, text); the engine
        // only needs it as an opaque, orderable string.
        return (result.rows as { row_key: unknown; value: unknown }[]).map((row) => ({
          key: String(row.row_key),
          value: typeof row.value === 'string' ? row.value : '',
        }));
      },

      async commit(row, rewritten): Promise<void> {
        // One batch, one transaction: the value and its ledger entry cannot diverge.
        const update: DbStatement = statement(
          `update ${table} set ${column} = ${placeholder(1)} where ${keyColumn} = ${placeholder(2)}`,
          [rewritten, row.key],
        );
        const insert: DbStatement = statement(
          `insert into ${ROTATION_LEDGER} (${LEDGER_COLUMNS.join(', ')})
           values (${placeholder(1)}, ${placeholder(2)}, ${placeholder(3)}, ${placeholder(4)}, ${placeholder(5)})
           on conflict do nothing`,
          [table, column, row.key, keyOf(rewritten), Date.now()],
        );
        await run.batch([update, insert]);
      },
    };
  }

  return {
    target,

    async ensureLedger(): Promise<void> {
      await database.query({ sql: ledgerDdl, params: [] });
    },

    async withLock<T>(
      targetLocked: RotationTarget,
      work: (scope: RotationScope) => Promise<T>,
    ): Promise<T> {
      // The target is fixed at construction; refusing a mismatch catches the one
      // mistake a port with both a factory and a callback invites.
      if (targetLocked.table !== table || targetLocked.column !== column) {
        throw new TsirError(
          'DB_ROTATION_TARGET_MISMATCH',
          `this store rotates ${table}.${column}, not ${targetLocked.table}.${targetLocked.column}`,
          {
            kind: 'database',
            hint: 'create one store per (table, column) with createRotationStore()',
            context: {
              expected: `${table}.${column}`,
              received: `${targetLocked.table}.${targetLocked.column}`,
            },
          },
        );
      }

      if (!postgres) {
        // D1 has no advisory locks and does not need one: a D1 database has a single
        // writer per location, so two runners cannot rewrite the same row at once.
        return work(scopeFor(database));
      }

      return database.pinned(async (pinned) => {
        const key = advisoryLockKey(`${table}.${column}`);
        const result = await pinned.query({
          sql: `select pg_try_advisory_lock(${placeholder(1)}) as locked`,
          params: [String(key)],
        });
        const acquired = (result.rows[0] as { locked?: boolean } | undefined)?.locked === true;
        if (!acquired) throw rotationLockedError(table, column);

        try {
          return await work(scopeFor(pinned));
        } finally {
          // Released explicitly: the pinned connection outlives this callback only
          // long enough to be returned to the pool.
          await pinned
            .query({ sql: `select pg_advisory_unlock(${placeholder(1)})`, params: [String(key)] })
            .catch(() => undefined);
        }
      });
    },

    /**
     * Rows that name a specific key (`VLT-017`).
     *
     * A prefix match, not a ledger lookup: the ledger only knows what a *runner*
     * wrote, and a retired key's danger is the row some earlier deployment wrote.
     */
    async countKey(keyId: string): Promise<number> {
      const result = await database.query({
        sql: `select count(*) as rows from ${table}
               where ${column} is not null and ${column} like ${placeholder(1)}`,
        params: [`tsir:v1:${keyId}:%`],
      });
      return toCount((result.rows[0] as { rows?: unknown } | undefined)?.rows);
    },

    async remaining(_target: RotationTarget, activeKeyId: string): Promise<number> {
      const result = await database.query({
        sql: `select count(*) as remaining from ${table}
               where ${column} is not null and ${column} not like ${placeholder(1)}`,
        params: [`tsir:v1:${activeKeyId}:%`],
      });
      const row = result.rows[0] as { remaining?: unknown } | undefined;
      return toCount(row?.remaining);
    },
  };
}

/**
 * `count(*)` in the three shapes a driver may hand it back.
 *
 * D1 returns a number, Postgres returns a string (or a bigint with `ArrayMode`),
 * and a driver that returns something else is a driver bug — but a count is never
 * worth failing a rotation over, so an unreadable value reads as zero and the
 * `remaining` field says "nothing known to be left" rather than NaN in JSON.
 */
function toCount(value: unknown): number {
  if (typeof value === 'bigint') {
    // coercion-ok: `bigint` → `number` is exact below 2^53, and a row count is.
    return Number(value);
  }
  if (typeof value === 'string') {
    // coercion-ok: pg returns `count(*)` as text; `Number.isFinite` rejects "" and "abc".
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The key id an envelope names, without importing `vault`'s parser a second time. */
function keyOf(envelope: string): string {
  const parts = envelope.split(':');
  return parts.length >= 3 ? (parts[2] ?? '') : '';
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new TsirError('DB_ROTATION_INVALID_IDENTIFIER', `"${value}" is not a valid ${what}`, {
      kind: 'database',
      hint: 'rotation targets come from code, never from request data',
      context: { [what]: value },
    });
  }
  return value;
}
