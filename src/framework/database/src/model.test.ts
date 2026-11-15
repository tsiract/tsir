import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { createDrizzle } from './drizzle.ts';
import { createConnectionsFromConfig } from './from-config.ts';
import { defineModel } from './model.ts';

/**
 * `DX-004` against a real driver.
 *
 * The model's whole claim is that it removes boilerplate without removing a guarantee, and the only
 * way to check both halves is one code path: an in-memory SQLite database, Drizzle's sqlite-proxy on
 * top of it (which is what `createDrizzle` builds), and the real `Bun` handle underneath.
 */

const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
});

function open() {
  const handle = new Database(':memory:');
  handle.run(
    'create table users (id integer primary key, email text not null, name text not null)',
  );
  handle.run(
    "insert into users (id, email, name) values (1, 'ada@example.com', 'Ada'), (2, 'bob@example.com', 'Bob')",
  );
  const databases = createConnectionsFromConfig(
    {
      default: 'main',
      connections: {
        main: {
          driver: 'sqlite',
          url: 'file::memory:',
          logging: 'off',
          slowQueryMs: 5_000,
          statementTimeoutMs: 5_000,
        },
      },
    },
    () => ({ main: handle }),
  );
  return createDrizzle(databases.defaultDatabase);
}

const Users = defineModel(users);

describe('DX-004 · typed reads', () => {
  test('`find` returns the row, and `undefined` when there is none', async () => {
    const db = open();
    expect((await Users.find(db, 1))?.email).toBe('ada@example.com');
    // `find` is the read for "a missing row is expected", so it is the one that does not throw.
    expect(await Users.find(db, 99)).toBeUndefined();
  });

  test('`findOrFail` names the table and the id', async () => {
    const db = open();
    const failure = (await Users.findOrFail(db, 99).catch((error: unknown) => error)) as {
      code?: string;
      message?: string;
    };
    expect(failure.code).toBe('DB_MODEL_NOT_FOUND');
    // Both halves of the question: which table, which row.
    expect(failure.message).toContain('users');
    expect(failure.message).toContain('99');
  });

  test('`where` takes a column record', async () => {
    const db = open();
    expect(await Users.where(db, { email: 'ada@example.com' })).toHaveLength(1);
    expect(await Users.where(db, { name: 'Bob', email: 'bob@example.com' })).toHaveLength(1);
    // Two keys that cannot both be true: the `and` is real, not "first key wins".
    expect(await Users.where(db, { name: 'Bob', email: 'ada@example.com' })).toHaveLength(0);
  });

  test('`where` refuses a key that is not a column, rather than matching everything', async () => {
    const db = open();
    // The type rejects `{ emial: … }` at the call site. This is the other path: a filter built from
    // a query string, where the key arrives as data. Ignoring it would return both rows and look
    // like a working filter.
    const failure = (await Users.where(db, { emial: 'ada@example.com' } as never).catch(
      (error: unknown) => error,
    )) as { code?: string; message?: string };
    expect(failure.code).toBe('DB_MODEL_AMBIGUOUS');
    expect(failure.message).toContain('email');
  });

  test('`where` with an empty record is every row, not an error', async () => {
    const db = open();
    expect(await Users.where(db, {})).toHaveLength(2);
  });

  test('`first`, `count` and `exists`', async () => {
    const db = open();
    expect((await Users.first(db, { email: 'nobody@example.com' }))?.id).toBeUndefined();
    expect(await Users.count(db)).toBe(2);
    expect(await Users.count(db, { name: 'Ada' })).toBe(1);
    expect(await Users.exists(db, { email: 'ada@example.com' })).toBe(true);
    expect(await Users.exists(db, { email: 'nobody@example.com' })).toBe(false);
  });

  test('the row type comes from the table, so a wrong field does not compile', async () => {
    const db = open();
    const user = await Users.find(db, 1);
    if (user !== undefined) {
      expect(user.email).toBe('ada@example.com');
      // @ts-expect-error — `users` has no `passwordHash`. An index signature would have allowed it
      // and returned `undefined`; the inferred row type is what makes this a compile error.
      expect(user.passwordHash).toBeUndefined();
    }
  });

  test('a table without an `id` column says so instead of querying `undefined`', async () => {
    const keys = sqliteTable('keys', { key: text('key').primaryKey() });
    const Keys = defineModel(keys);
    const failure = (await Keys.find(open(), 'abc').catch((error: unknown) => error)) as {
      code?: string;
      message?: string;
    };
    // `eq(undefined, …)` would throw a Drizzle internal error naming a symbol; this names the table
    // and the column it could not find.
    expect(failure.code).toBe('DB_MODEL_AMBIGUOUS');
    expect(failure.message).toContain('keys');
  });
});
