import { describe, expect, test } from 'bun:test';

import { eq, sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { createDatabase } from './database.ts';
import { createD1Driver, type D1Like, type D1ResultLike, type D1StatementLike } from './d1.ts';
import { createDrizzle, errorCode, rootCause } from './drizzle.ts';

/** A fake D1 that records statements and answers with scripted rows. */
interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly raw: boolean;
}

function fakeD1(respond: (sql: string) => readonly unknown[][] = () => []) {
  const recorded: Recorded[] = [];
  let batches = 0;

  class Prepared implements D1StatementLike {
    #sql: string;
    #params: readonly unknown[] = [];

    constructor(query: string) {
      this.#sql = query;
    }

    bind(...values: readonly unknown[]): D1StatementLike {
      this.#params = values;
      return this;
    }

    async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
      recorded.push({ sql: this.#sql, params: this.#params, raw: false });
      if (/^begin\b/i.test(this.#sql)) {
        return { success: false, error: 'cannot start a transaction within a transaction' };
      }
      const rows = respond(this.#sql) as unknown as T[];
      return { success: true, results: rows, meta: { changes: 0 } };
    }

    async raw<T = unknown[]>(): Promise<readonly T[]> {
      recorded.push({ sql: this.#sql, params: this.#params, raw: true });
      return respond(this.#sql) as unknown as T[];
    }

    async run(): Promise<D1ResultLike<never>> {
      recorded.push({ sql: this.#sql, params: this.#params, raw: false });
      if (/^begin\b/i.test(this.#sql)) {
        return { success: false, error: 'cannot start a transaction within a transaction' };
      }
      return { success: true, meta: { changes: 1 } };
    }
  }

  const binding: D1Like = {
    prepare: (query: string) => new Prepared(query),
    async batch<T = Record<string, unknown>>(
      statements: readonly D1StatementLike[],
    ): Promise<readonly D1ResultLike<T>[]> {
      batches += 1;
      const results: D1ResultLike<T>[] = [];
      for (const prepared of statements) results.push(await prepared.all<T>());
      // Atomic: a failure aborts the batch, as D1 does.
      const failed = results.find((result) => !result.success);
      return failed === undefined ? results : [failed];
    },
    exec: async () => ({ count: 1, duration: 0 }),
  };

  return { binding, recorded, batches: () => batches };
}

const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
});

describe('database · Drizzle over the driver (DB-002)', () => {
  test('a typed select generates SQL, binds params, and maps positional rows', async () => {
    const fake = fakeD1((query) =>
      query.includes('from "users"') ? [[7, 'ada@example.com']] : [],
    );
    const database = createDatabase({ driver: createD1Driver({ binding: fake.binding }) });
    const db = createDrizzle(database);

    const rows = await db.select().from(users).where(eq(users.id, 7));

    // Typed: `rows` is `{ id: number; email: string }[]` — this line fails `tsc`
    // if the schema and the mapping ever disagree.
    expect(rows).toEqual([{ id: 7, email: 'ada@example.com' }]);

    const sent = fake.recorded.at(-1);
    expect(sent?.sql).toContain('select');
    expect(sent?.sql).toContain('from "users"');
    expect(sent?.sql).toContain('"users"."id" = ');
    expect(sent?.params).toEqual([7]);
    // Positional rows come from `raw()`, not from re-ordering objects.
    expect(sent?.raw).toBe(true);
  });

  test('every Drizzle query goes through the Database, so shutdown can drain it', async () => {
    const fake = fakeD1(() => [[1, 'a@example.com']]);
    const database = createDatabase({ driver: createD1Driver({ binding: fake.binding }) });
    const db = createDrizzle(database);

    await db.select().from(users);
    await database.close();

    // If Drizzle were given the raw binding, this query would still succeed after
    // close and the drain counter would never have seen it.
    const error = await db
      .select()
      .from(users)
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    // Drizzle re-wraps the driver error, so `error.code` is undefined and the
    // original is on `cause` — the reason `errorCode()` exists.
    expect(error).toBeInstanceOf(Error);
    expect(errorCode(error)).toBe('DB_CLOSED');
    expect(rootCause(error)).toMatchObject({ kind: 'database' });
  });

  test('an insert runs as a write and returns changes, not rows', async () => {
    const fake = fakeD1(() => []);
    const database = createDatabase({ driver: createD1Driver({ binding: fake.binding }) });
    const db = createDrizzle(database);

    await db.insert(users).values({ id: 1, email: 'a@example.com' });

    const sent = fake.recorded.at(-1);
    expect(sent?.sql).toContain('insert into "users"');
    expect(sent?.params).toEqual([1, 'a@example.com']);
    expect(sent?.raw).toBe(false);
  });

  test('db.batch() becomes one atomic engine batch', async () => {
    const fake = fakeD1(() => []);
    const database = createDatabase({ driver: createD1Driver({ binding: fake.binding }) });
    const db = createDrizzle(database);

    await db.batch([
      db.insert(users).values({ id: 1, email: 'a@example.com' }),
      db.insert(users).values({ id: 2, email: 'b@example.com' }),
    ]);

    // One call to the binding's batch, not two independent writes.
    expect(fake.batches()).toBe(1);
  });

  test('db.transaction() fails loudly on D1 instead of degrading silently', async () => {
    const fake = fakeD1(() => []);
    const database = createDatabase({ driver: createD1Driver({ binding: fake.binding }) });
    const db = createDrizzle(database);

    // Drizzle's SQLite proxy implements `transaction()` by issuing BEGIN/COMMIT.
    // D1 rejects BEGIN, so the failure surfaces here rather than as a
    // half-applied write — the documented cliff in ADR-0016.
    const error = await db
      .transaction(async (tx) => {
        await tx.insert(users).values({ id: 1, email: 'a@example.com' });
      })
      .then(
        () => undefined,
        (reason: unknown) => reason as Error,
      );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('begin'); // Drizzle's "Failed query: begin"
    expect(String(rootCause(error))).toContain('cannot start a transaction');
  });

  test('raw SQL returns positional rows, because there is no field metadata', async () => {
    const fake = fakeD1((query) => (query.includes('count(*)') ? [[3]] : []));
    const database = createDatabase({ driver: createD1Driver({ binding: fake.binding }) });
    const db = createDrizzle(database);

    // Honest assertion: a proxy dialect cannot know column names for hand-written
    // SQL, so the row is `[3]`. Typing it as `{ count: number }` would compile and
    // then be wrong at runtime — exactly the mistake `DB-017` warns about.
    const rows = await db.all<[number]>(sql`select count(*) as count from ${users}`);

    expect(rows).toEqual([[3]]);
    expect(fake.recorded.at(-1)?.sql).toContain('select count(*) as count from "users"');
    expect(fake.recorded.at(-1)?.raw).toBe(true);
  });
});
