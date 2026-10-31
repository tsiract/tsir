import { describe, expect, test } from 'bun:test';

import { statement } from '@tsir/database';
import type { PgClientLike, PgResultLike } from '@tsir/database/postgres';

import { expectTsirError } from './index.ts';
import { assertSchemaName, createTestDatabase, testSchemaName } from './database.ts';

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

/**
 * A Postgres client that records SQL and returns fixed rows.
 *
 * `createTestDatabase` must not need a server to be tested: it is a coordinator
 * of schema DDL, a driver and a database, and every one of those is observable
 * through this fake.
 */
function fakeClient(
  options: { rows?: readonly Record<string, unknown>[]; end?: boolean; log?: Call[] } = {},
) {
  // A shared log lets a test see every client it created, in order.
  const calls: Call[] = options.log ?? [];
  const rows = options.rows ?? [{ ok: 1 }];

  const client: PgClientLike = {
    unsafe(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params });
      const result = Object.assign([...rows], {
        command: 'SELECT',
        count: rows.length,
      }) as unknown as PgResultLike;
      return Promise.resolve(result);
    },
  };
  if (options.end !== false) {
    (client as { end?: () => Promise<void> }).end = async () => {
      calls.push({ sql: '<end>', params: undefined });
    };
  }

  return { client, calls, sqls: () => calls.map((call) => call.sql) };
}

describe('testSchemaName', () => {
  test('is prefixed, slugged and unique', () => {
    const first = testSchemaName('Users API › creates a user');
    const second = testSchemaName('Users API › creates a user');

    expect(first).toMatch(/^tsir_test_users_api_creates_a_user_[a-f0-9]{8}$/);
    expect(first).not.toBe(second);
  });

  test('survives a suite name with nothing usable in it', () => {
    expect(testSchemaName('···')).toMatch(/^tsir_test_suite_[a-f0-9]{8}$/);
  });
});

describe('assertSchemaName', () => {
  test('refuses the schemas Postgres owns', () => {
    for (const name of ['public', 'pg_catalog', 'information_schema', 'pg_toast', 'pg_temp']) {
      expect(() => assertSchemaName(name)).toThrow();
    }
  });

  test('refuses a name that is not an identifier', () => {
    for (const name of ['tsir test', 'tsir"test', 'Tsir', '9lives', 'x'.repeat(60)]) {
      expect(() => assertSchemaName(name)).toThrow();
    }
  });

  test('accepts a plain lowercase identifier', () => {
    expect(assertSchemaName('tsir_test_users_ab12cd34')).toBe('tsir_test_users_ab12cd34');
  });
});

describe('createTestDatabase', () => {
  test('creates its schema and hands back a working database', async () => {
    const { client, sqls } = fakeClient({ rows: [{ id: 1 }] });

    const database = await createTestDatabase({ suite: 'users', connect: () => client });

    expect(database.schema).toMatch(/^tsir_test_users_/);
    expect(sqls()[0]).toBe(`create schema if not exists "${database.schema}"`);

    const rows = await database.query<{ id: number }>('select * from users where id = $1', [1]);
    expect(rows).toEqual([{ id: 1 }]);

    await database.close();
  });

  test('connect receives the schema so the client can point search_path at it', async () => {
    const { client } = fakeClient();
    const seen: string[] = [];

    const database = await createTestDatabase({
      suite: 'billing',
      connect: (schema) => {
        seen.push(schema);
        return client;
      },
    });

    expect(seen).toEqual([database.schema]);
    await database.close();
  });

  test('runs setup after the schema exists', async () => {
    const { client, sqls } = fakeClient();
    const applied: string[] = [];

    const database = await createTestDatabase({
      suite: 'setup',
      connect: () => client,
      setup: async (db) => {
        // The schema exists by the time setup runs — otherwise every migration
        // would fail on a fresh database. `database` is still being built here,
        // so the schema is asserted through what reached the client.
        expect(sqls()).toHaveLength(1);
        expect(sqls()[0]).toStartWith('create schema if not exists "tsir_test_setup_');
        await db.query(statement('create table t (id int)'));
        applied.push('setup');
      },
    });

    expect(applied).toEqual(['setup']);
    await database.close();
  });

  test('passes bound parameters through untouched', async () => {
    const { client, calls } = fakeClient({ rows: [] });

    const database = await createTestDatabase({ suite: 'params', connect: () => client });
    await database.query('select * from users where email = $1', ['ada@example.com']);

    const query = calls.find((call) => call.sql.includes('where email'));
    expect(query?.params).toEqual(['ada@example.com']);
    await database.close();
  });

  test('reset drops, recreates, reconnects and re-runs setup', async () => {
    const log: Call[] = [];
    let connections = 0;
    const connect = (): PgClientLike => {
      connections += 1;
      return fakeClient({ log }).client;
    };

    let setups = 0;
    const database = await createTestDatabase({
      suite: 'reset',
      connect,
      setup: async () => {
        setups += 1;
      },
    });
    const schema = database.schema;

    await database.reset();

    const sqls = log.map((call) => call.sql);
    // Drop, end the pool, reconnect, create, set up — in that order, because a
    // pool that close() ended cannot run the CREATE that follows.
    const dropAt = sqls.indexOf(`drop schema if exists "${schema}" cascade`);
    const endAt = sqls.indexOf('<end>');
    const createAt = sqls.lastIndexOf(`create schema if not exists "${schema}"`);
    expect(dropAt).toBeGreaterThan(-1);
    expect(endAt).toBeGreaterThan(dropAt);
    expect(createAt).toBeGreaterThan(endAt);

    // A pool that close() ended is not reusable, so reset reconnects.
    expect(connections).toBe(2);
    expect(setups).toBe(2);
    expect(database.schema).toBe(schema);

    await database.close();
  });

  test('close drops the schema, closes the pool, and is idempotent', async () => {
    const { client, sqls } = fakeClient();

    const database = await createTestDatabase({ suite: 'close', connect: () => client });
    await database.close();
    await database.close();

    expect(sqls()).toContain(`drop schema if exists "${database.schema}" cascade`);
    expect(sqls().filter((sql) => sql === '<end>')).toHaveLength(1);
  });

  test('reset after close refuses instead of querying a dead pool', async () => {
    const { client } = fakeClient();

    const database = await createTestDatabase({ suite: 'closed', connect: () => client });
    await database.close();

    await expectTsirError(() => database.reset(), 'TEST_DATABASE_CLOSED');
  });

  test('an explicit schema is used as given', async () => {
    const { client, sqls } = fakeClient();

    const database = await createTestDatabase({
      schema: 'tsir_test_explicit',
      connect: () => client,
    });

    expect(database.schema).toBe('tsir_test_explicit');
    expect(sqls()[0]).toBe('create schema if not exists "tsir_test_explicit"');
    await database.close();
  });

  test('a protected schema is refused before anything is dropped', async () => {
    const { client, calls } = fakeClient();

    await expectTsirError(
      () => createTestDatabase({ schema: 'public', connect: () => client }),
      'TEST_SCHEMA_INVALID',
    );

    // Not one statement reached the server.
    expect(calls).toHaveLength(0);
  });

  test('the schema name is quoted, so a reserved word is harmless', async () => {
    const { client, sqls } = fakeClient();

    const database = await createTestDatabase({ schema: 'tsir_test_order', connect: () => client });
    expect(sqls()[0]).toBe('create schema if not exists "tsir_test_order"');
    await database.close();
  });
});

describe('two databases in one suite (DB-022)', () => {
  test('each harness answers to its own connection name', async () => {
    const app = await createTestDatabase({
      suite: 'app',
      connection: 'app',
      connect: () => fakeClient().client,
    });
    const reporting = await createTestDatabase({
      suite: 'reporting',
      connection: 'reporting',
      connect: () => fakeClient().client,
    });

    expect(app.database.name).toBe('app');
    expect(reporting.database.name).toBe('reporting');
    // An unnamed harness is still honest about what it is rather than empty.
    const plain = await createTestDatabase({
      suite: 'plain',
      connect: () => fakeClient().client,
    });
    expect(plain.connection).toBe('default');

    // Two schemas, not one shared schema — the isolation is what lets the two
    // databases be used in the same process without ordering constraints.
    expect(app.schema).not.toBe(reporting.schema);

    await app.close();
    await reporting.close();
    await plain.close();
  });
});
