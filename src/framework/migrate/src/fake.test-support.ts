/**
 * A tiny SQL-shaped fake for the two engines.
 *
 * `@tsir/migrate` talks to Drizzle's `__drizzle_migrations` table and to its own
 * audit table, plus whatever SQL the migrations themselves contain. Emulating
 * those four statement shapes by pattern matching is enough to test the applier
 * end to end — locking, atomicity, drift, failure — without a database server,
 * and it keeps the tests honest about *which* SQL the applier emits.
 *
 * It lives in `src/` because `tsconfig.json` includes `src/**` and the runner
 * discovers `*.test.ts` only; the file ships in the dist tree exactly like a test
 * helper would, which is why it is named `.test-support.ts` and not imported by
 * `index.ts`.
 */

import {
  D1_CAPABILITIES,
  type D1Like,
  type D1ResultLike,
  type D1StatementLike,
} from '@tsir/database';
import { createDatabase, createD1Driver, type Database } from '@tsir/database';
import {
  createPostgresDriver,
  type PgClientLike,
  type PgQueryLike,
  type PgResultLike,
} from '@tsir/database/postgres';

export interface FakeState {
  /** Rows of `__drizzle_migrations`, as Dart would store them. */
  readonly journal: { id: number; hash: string; created_at: number }[];
  readonly runs: Record<string, unknown>[];
  /** Every statement the applier issued, in order. */
  readonly statements: { sql: string; params: readonly unknown[] }[];
  /** Set to make the next statement matching this pattern fail. */
  failOn?: RegExp;
  /** Statements matching this fail the way a database without that table does. */
  missingTable?: RegExp;
  /** Rows for a statement the fake does not model; `undefined` falls through. */
  rows?: (sql: string) => readonly unknown[] | undefined;
  /** Set to simulate another runner holding the advisory lock. */
  lockHeld?: boolean;
  /** `reserve()`/`release()` calls, in order (`DB-018`). */
  readonly pins: string[];
}

export function emptyState(): FakeState {
  return { journal: [], runs: [], statements: [], pins: [] };
}

function rowResult<T>(rows: readonly T[]): D1ResultLike<T> {
  return { results: rows, success: true, meta: { changes: rows.length } };
}

function write(sql: string, params: readonly unknown[], state: FakeState): D1ResultLike<never> {
  if (/insert into "__drizzle_migrations"/i.test(sql)) {
    state.journal.push({
      id: state.journal.length + 1,
      hash: typeof params[0] === 'string' ? params[0] : '',
      // coercion-ok: params come from `bind()`ed statements in this process, and
      // the fake mirrors what a driver would store in an INTEGER column.
      created_at: Number(params[1] ?? 0),
    });
    return { success: true, meta: { changes: 1 } };
  }
  if (/delete from "__drizzle_migrations"/i.test(sql)) {
    // coercion-ok: the bound `created_at` of the row being deleted, as above.
    const when = Number(params[0] ?? 0);
    const index = state.journal.findIndex((row) => row.created_at === when);
    if (index !== -1) state.journal.splice(index, 1);
    return { success: true, meta: { changes: index === -1 ? 0 : 1 } };
  }
  if (/insert into "__tsir_migration_runs"/i.test(sql)) {
    const [runId, tag, checksum, host, actor, durationMs, appliedAt] = params;
    state.runs.push({
      run_id: runId,
      tag,
      checksum,
      host,
      actor,
      duration_ms: durationMs,
      applied_at: appliedAt,
    });
    return { success: true, meta: { changes: 1 } };
  }
  return { success: true, meta: { changes: 1 } };
}

function read(sql: string, params: readonly unknown[], state: FakeState): readonly unknown[] {
  const custom = state.rows?.(sql);
  if (custom !== undefined) return custom;
  if (/select "id", "hash", "created_at" from "__drizzle_migrations"/i.test(sql)) {
    return [...state.journal].sort((a, b) => a.created_at - b.created_at);
  }
  if (/select .* from "__tsir_migration_runs"/i.test(sql)) {
    return state.runs;
  }
  if (/pg_try_advisory_lock/i.test(sql)) {
    return [{ locked: state.lockHeld !== true }];
  }
  if (/pg_advisory_unlock/i.test(sql)) {
    state.lockHeld = false;
    return [{ released: true }];
  }
  void params;
  return [];
}

/** The shared engine: decides what a statement returns and records it. */
function execute(sql: string, params: readonly unknown[], state: FakeState): readonly unknown[] {
  state.statements.push({ sql, params });
  if (state.failOn !== undefined && state.failOn.test(sql)) {
    throw new Error(`synthetic failure for: ${sql}`);
  }
  if (state.missingTable !== undefined && state.missingTable.test(sql)) {
    throw new Error(`no such table: ${sql}`);
  }
  if (/^(insert|delete|update)/i.test(sql)) {
    write(sql, params, state);
    return [];
  }
  return read(sql, params, state);
}

/** A `D1Database`-shaped binding over the fake engine. */
export function fakeD1(state: FakeState): D1Like {
  const statement = (sql: string, params: readonly unknown[] = []): D1StatementLike => ({
    bind: (...values: readonly unknown[]) => statement(sql, values),
    all: async <T = Record<string, unknown>>(): Promise<D1ResultLike<T>> =>
      rowResult(execute(sql, params, state) as readonly T[]),
    run: async () => write(sql, params, state),
  });
  return {
    prepare: (sql: string) => statement(sql),
    async batch<T = Record<string, unknown>>(
      statements: readonly D1StatementLike[],
    ): Promise<readonly D1ResultLike<T>[]> {
      // D1's batch is atomic: run each against a copy, and only commit the copy
      // if every statement succeeded. That is the property the applier relies on.
      const snapshot: FakeState = {
        journal: [...state.journal],
        runs: [...state.runs],
        statements: state.statements,
        pins: state.pins,
        ...(state.failOn === undefined ? {} : { failOn: state.failOn }),
        ...(state.lockHeld === undefined ? {} : { lockHeld: state.lockHeld }),
      };
      const results: D1ResultLike<T>[] = [];
      try {
        for (const prepared of statements) {
          results.push(await prepared.all<T>());
        }
      } catch (error: unknown) {
        state.journal.length = 0;
        state.journal.push(...snapshot.journal);
        state.runs.length = 0;
        state.runs.push(...snapshot.runs);
        throw error;
      }
      return results;
    },
    exec: async () => ({ count: 0, duration: 0 }),
  };
}

/** A D1 `Database` over the fake engine. */
export function fakeD1Database(state: FakeState): Database {
  return createDatabase({ driver: createD1Driver({ binding: fakeD1(state) }), logging: 'off' });
}

/** A `postgres.js`-shaped client over the fake engine, with savepoints via `begin`. */
export function fakePgClient(state: FakeState): PgClientLike {
  const client: PgClientLike = {
    unsafe(sql: string, params?: readonly unknown[]): ReturnType<PgClientLike['unsafe']> {
      const rows = execute(sql, params ?? [], state) as readonly Record<string, unknown>[];
      const result = Object.assign([...rows], {
        command: /^(insert|delete|update)/i.test(sql) ? 'INSERT' : 'SELECT',
        count: rows.length,
      }) as unknown as PgResultLike;
      const queryLike: PgQueryLike = {
        then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
        raw: async () => rows,
      };
      return queryLike;
    },
    async begin<T>(work: (scope: PgClientLike) => Promise<T>): Promise<T> {
      // A real `begin` commits or rolls back; the fake only has to prove the
      // applier *uses* one, and that the scope sees the same engine.
      return work(client);
    },
  };
  return client;
}

export function fakePgDatabase(state: FakeState): Database {
  return createDatabase({
    driver: createPostgresDriver({ client: fakePgClient(state) }),
    logging: 'off',
  });
}

/**
 * The same fake, plus `reserve()` — a client that can pin a connection.
 *
 * Reaches into `state` the same way, so a test can tell *which* client ran the
 * migration: the reservation writes `reserved-…` statements into `state.pins`.
 */
export function fakePgClientWithReserve(state: FakeState): PgClientLike {
  const base = fakePgClient(state);
  return {
    ...base,
    reserve(): PgClientLike {
      state.pins.push('reserved');
      return {
        ...fakePgClient(state),
        release(): void {
          state.pins.push('released');
        },
      };
    },
  };
}

export function fakePgDatabaseWithReserve(state: FakeState): Database {
  return createDatabase({
    driver: createPostgresDriver({ client: fakePgClientWithReserve(state) }),
    logging: 'off',
  });
}

export const D1_ENGINE = D1_CAPABILITIES.engine;
