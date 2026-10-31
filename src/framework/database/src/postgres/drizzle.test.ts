import { describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';

import { createDatabase } from '../database.ts';
import { errorCode, rootCause } from '../drizzle.ts';
import { createPgDrizzle } from './drizzle.ts';
import { createPostgresDriver, type PgClientLike, type PgResultLike } from '../postgres.ts';

const users = pgTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
});

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly raw: boolean;
}

/** A fake postgres.js that records SQL and answers with positional rows. */
function fakeClient(rows: readonly unknown[][] = []) {
  const recorded: Recorded[] = [];
  const executed: string[] = [];

  const client: PgClientLike = {
    unsafe(query: string, params: readonly unknown[] = []) {
      return {
        then: <T>(resolve: (value: PgResultLike) => T) => {
          executed.push(query);
          recorded.push({ sql: query, params, raw: false });
          return Promise.resolve(rows.map((row) => row) as unknown as PgResultLike).then(resolve);
        },
        raw: async () => {
          executed.push(query);
          recorded.push({ sql: query, params, raw: true });
          return rows as unknown as readonly unknown[];
        },
      } as never;
    },
    async begin<T>(work: (scope: PgClientLike) => Promise<T>): Promise<T> {
      executed.push('BEGIN');
      try {
        const value = await work(client);
        executed.push('COMMIT');
        return value;
      } catch (error: unknown) {
        executed.push('ROLLBACK');
        throw error;
      }
    },
    async end() {
      executed.push('END');
    },
  };

  return { client, recorded, executed };
}

describe('database · Drizzle over the Postgres driver (DB-012)', () => {
  test('a typed select generates Postgres SQL with $n placeholders and maps rows', async () => {
    const { client, recorded } = fakeClient([[7, 'ada@example.com']]);
    const db = createPgDrizzle(createDatabase({ driver: createPostgresDriver({ client }) }));

    const result = await db.select().from(users).where(eq(users.id, 7));

    expect(recorded[0]?.sql).toBe('select "id", "email" from "users" where "users"."id" = $1');
    expect(recorded[0]?.params).toEqual([7]);
    expect(result).toEqual([{ id: 7, email: 'ada@example.com' }]);
  });

  test('rows are requested positionally, because a proxy has no field metadata', async () => {
    const { client, recorded } = fakeClient([[1, 'a@example.com']]);
    const db = createPgDrizzle(createDatabase({ driver: createPostgresDriver({ client }) }));

    await db.select().from(users);

    expect(recorded.every((entry) => entry.raw)).toBe(true);
  });

  test('an insert runs as a write, not as a row query', async () => {
    const { client, recorded } = fakeClient([]);
    const db = createPgDrizzle(createDatabase({ driver: createPostgresDriver({ client }) }));

    await db.insert(users).values({ id: 1, email: 'ada@example.com' });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.sql).toStartWith('insert into "users"');
    expect(recorded[0]?.raw).toBe(false);
  });

  test('every generated statement goes through the Database, so logging sees it', async () => {
    const { client } = fakeClient([[1, 'ada@example.com']]);
    const logged: { sql: string; paramCount: number }[] = [];
    // Only SQL events: the transaction-open warning has no statement attached.
    const record = (event: { event: string; sql?: string; paramCount?: number }): void => {
      if (event.event !== 'db.query') return;
      logged.push({ sql: event.sql ?? '', paramCount: event.paramCount ?? 0 });
    };
    const database = createDatabase({
      driver: createPostgresDriver({ client }),
      logging: 'all',
      log: record,
    });
    const db = createPgDrizzle(database);

    await db.select().from(users).where(eq(users.id, 1));

    expect(logged).toHaveLength(1);
    expect(logged[0]?.sql).toContain('select "id", "email" from "users"');
    expect(logged[0]?.paramCount).toBe(1);
  });

  test('db.transaction() throws on this dialect — transactions belong to Database', async () => {
    const { client } = fakeClient([]);
    const db = createPgDrizzle(createDatabase({ driver: createPostgresDriver({ client }) }));

    const error = await db
      .transaction(async () => 'never')
      .then(
        () => undefined,
        (reason: unknown) => reason as Error,
      );

    expect(error?.message).toContain('Transactions are not supported');
  });

  test('Drizzle re-wraps errors here too; rootCause() finds the original', async () => {
    const client: PgClientLike = {
      unsafe: () => {
        throw Object.assign(new Error('relation "users" does not exist'), { code: '42P01' });
      },
    };
    const database = createDatabase({ driver: createPostgresDriver({ client }) });
    const db = createPgDrizzle(database);

    const error = await db
      .select()
      .from(users)
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(rootCause(error)).toBeInstanceOf(Error);
    expect((rootCause(error) as Error).message).toContain('does not exist');
    // The driver does not translate Postgres SQLSTATE codes; it preserves them.
    expect((rootCause(error) as { code?: string }).code).toBe('42P01');
    expect(errorCode(error)).toBe('42P01');
  });

  test('a transaction-scoped Drizzle instance works inside interactiveTx', async () => {
    const { client, executed } = fakeClient([[1]]);
    const database = createDatabase({ driver: createPostgresDriver({ client }) });

    await database.interactiveTx(async (tx) => {
      const dtx = createPgDrizzle(tx);
      await dtx.select().from(users);
    });

    // The query really ran inside the transaction: BEGIN, the select, COMMIT.
    expect(executed[0]).toBe('BEGIN');
    expect(executed[1]).toContain('select "id", "email" from "users"');
    expect(executed.at(-1)).toBe('COMMIT');
  });
});
