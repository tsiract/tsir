import { describe, expect, test } from 'bun:test';

import { createDatabase, type Database } from './database.ts';
import { createD1Driver, type D1Like, type D1ResultLike, type D1StatementLike } from './d1.ts';
import { applyOptimistic, optimisticUpdate, retryOnConflict } from './optimistic.ts';

/**
 * A minimal in-memory table behind a D1-shaped binding.
 *
 * It understands exactly one statement form — the guarded `update … where id = ?
 * and version = ?` that `optimisticUpdate` builds — plus `select 1 … limit 1`.
 * A fake that "just updated the row" would hide the whole point: the write only
 * lands if the version still matches.
 */
interface Row {
  readonly id: number;
  email: string;
  version: number;
}

function fakeD1(rows: Row[]): D1Like {
  class Prepared implements D1StatementLike {
    #sql = '';
    #params: readonly unknown[] = [];

    constructor(query: string) {
      this.#sql = query;
    }

    bind(...values: readonly unknown[]): D1StatementLike {
      this.#params = values;
      return this;
    }

    async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
      return this.#execute() as D1ResultLike<T>;
    }

    async run(): Promise<D1ResultLike<never>> {
      return this.#execute() as D1ResultLike<never>;
    }

    #execute(): D1ResultLike<Record<string, unknown>> {
      const lower = this.#sql.toLowerCase();
      if (lower.startsWith('update')) {
        // `update "users" set "email" = ?, "version" = "version" + 1 where "id" = ? and "version" = ?`
        const id = this.#params.at(-2) as number;
        const version = this.#params.at(-1) as number;
        const email = this.#params[0] as string;
        const row = rows.find((candidate) => candidate.id === id);
        if (row === undefined || row.version !== version)
          return { success: true, meta: { changes: 0 } };
        row.email = email;
        row.version += 1;
        return { success: true, meta: { changes: 1 } };
      }
      if (lower.startsWith('select 1')) {
        const id = this.#params[0] as number;
        const present = rows.some((row) => row.id === id);
        return { success: true, results: present ? [{ present: 1 }] : [] };
      }
      return { success: false, error: `unsupported statement: ${this.#sql}` };
    }
  }

  return {
    prepare: (query: string) => new Prepared(query),
    async batch<T = Record<string, unknown>>(statements: readonly D1StatementLike[]) {
      const results: D1ResultLike<T>[] = [];
      for (const prepared of statements) results.push(await prepared.all<T>());
      return results;
    },
    exec: async () => ({ count: 0, duration: 0 }),
  };
}

function databaseWith(rows: Row[]): Database {
  return createDatabase({ driver: createD1Driver({ binding: fakeD1(rows) }) });
}

describe('database · optimistic concurrency (DB-011)', () => {
  test('the update is guarded by the version and bumps it itself', () => {
    const built = optimisticUpdate({
      table: 'users',
      id: 7,
      expectedVersion: 3,
      set: { email: 'new@example.com' },
    });

    expect(built.sql).toBe(
      'update "users" set "email" = ?, "version" = "version" + 1 where "id" = ? and "version" = ?',
    );
    expect(built.params).toEqual(['new@example.com', 7, 3]);
  });

  test('identifiers are validated before they reach the SQL string', () => {
    // Every one of these is an injection attempt wearing a column name.
    for (const table of ['users; drop table users', 'users" --', 'public.users', '']) {
      expect(() =>
        optimisticUpdate({ table, id: 1, expectedVersion: 0, set: { email: 'a' } }),
      ).toThrow(/not a valid SQL identifier/);
    }
    for (const column of ['email" = "x', 'email where 1=1', '1email']) {
      expect(() =>
        optimisticUpdate({ table: 'users', id: 1, expectedVersion: 0, set: { [column]: 'a' } }),
      ).toThrow(/not a valid SQL identifier/);
    }
    expect(() => optimisticUpdate({ table: 'users', id: 1, expectedVersion: 0, set: {} })).toThrow(
      /at least one column/,
    );
  });

  test('a stale version is a conflict, not a silent success', async () => {
    const database = databaseWith([{ id: 1, email: 'old@example.com', version: 2 }]);

    const result = await applyOptimistic(database, {
      table: 'users',
      id: 1,
      expectedVersion: 1, // someone else already bumped it to 2
      set: { email: 'mine@example.com' },
    });

    expect(result).toEqual({ ok: false, reason: 'conflict' });
  });

  test('a missing row is reported as missing, not as a conflict', async () => {
    const database = databaseWith([]);

    const result = await applyOptimistic(database, {
      table: 'users',
      id: 404,
      expectedVersion: 1,
      set: { email: 'mine@example.com' },
    });

    expect(result).toEqual({ ok: false, reason: 'missing' });
  });

  test('two writers and one wins: the loser retries once and then succeeds', async () => {
    const rows: Row[] = [{ id: 1, email: 'old@example.com', version: 1 }];
    const alice = databaseWith(rows);
    const bob = databaseWith(rows);

    // Both read version 1 first — that is the race.
    const aliceWrite = await applyOptimistic(alice, {
      table: 'users',
      id: 1,
      expectedVersion: 1,
      set: { email: 'alice@example.com' },
    });
    const bobWrite = await applyOptimistic(bob, {
      table: 'users',
      id: 1,
      expectedVersion: 1,
      set: { email: 'bob@example.com' },
    });

    expect(aliceWrite).toEqual({ ok: true, version: 2 });
    expect(bobWrite).toEqual({ ok: false, reason: 'conflict' });
    expect(rows[0]?.email).toBe('alice@example.com');
    expect(rows[0]?.version).toBe(2);

    // Bob re-reads and retries, and this time the version matches.
    const retried = await retryOnConflict(async () => {
      const fresh = rows[0]?.version ?? 0;
      return applyOptimistic(bob, {
        table: 'users',
        id: 1,
        expectedVersion: fresh,
        set: { email: 'bob@example.com' },
      });
    });

    expect(retried).toEqual({ ok: true, version: 3 });
    expect(rows[0]?.email).toBe('bob@example.com');
  });

  test('retry backs off exponentially and stops as soon as it wins', async () => {
    const delays: number[] = [];
    let attempts = 0;

    const result = await retryOnConflict(
      async () => {
        attempts += 1;
        return attempts < 3
          ? ({ ok: false, reason: 'conflict' } as const)
          : ({ ok: true, version: 9 } as const);
      },
      {
        attempts: 5,
        backoffMs: 10,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result).toEqual({ ok: true, version: 9 });
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  test('a missing row is never retried: retrying cannot bring it back', async () => {
    let attempts = 0;
    const result = await retryOnConflict(
      async () => {
        attempts += 1;
        return { ok: false, reason: 'missing' } as const;
      },
      { sleep: async () => undefined },
    );

    expect(result).toEqual({ ok: false, reason: 'missing' });
    expect(attempts).toBe(1);
  });

  test('retries are bounded by attempts and give up with the last conflict', async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await retryOnConflict(
      async () => {
        attempts += 1;
        return { ok: false, reason: 'conflict' } as const;
      },
      {
        attempts: 3,
        backoffMs: 5,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: 'conflict' });
    expect(attempts).toBe(3);
    expect(delays).toEqual([5, 10]);
  });
});
