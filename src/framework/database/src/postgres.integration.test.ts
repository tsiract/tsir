/**
 * The Postgres driver against a real server (`DB-012`, `DB-018`).
 *
 * Runs only through `bun src/tools/test-integration.ts`, which requires
 * `DATABASE_URL`; a plain `bun test` skips the file because its name is not
 * `*.test.ts`. The point is to prove the things a fake cannot: real SQLSTATEs,
 * real transaction isolation, and a real connection pool.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { createDatabase, type Database } from '../src/index.ts';
import { createPostgresDriver } from '../src/postgres.ts';
import { connectPostgres, databaseUrl, type TestDatabase } from '../../../tools/pg-test-client.ts';

const url = databaseUrl();
const suite = url === undefined ? describe.skip : describe;

let pg: TestDatabase;
let db: Database;

suite('database · Postgres integration (DB-012)', () => {
  beforeAll(() => {
    pg = connectPostgres(url ?? '');
    db = createDatabase({
      driver: createPostgresDriver({ client: pg.client }),
      logging: 'off',
    });
  });

  afterAll(async () => {
    await db.close();
    await pg.close();
  });

  beforeEach(async () => {
    await pg.run('drop table if exists it_notes');
    await pg.run('create table it_notes (id int primary key, body text not null)');
  });

  test('a query returns rows with Postgres $n placeholders', async () => {
    await pg.run('insert into it_notes (id, body) values (1, $1)', ['first']);

    const result = await db.query({
      sql: 'select id, body from it_notes where id = $1',
      params: [1],
    });

    expect(result.rows).toEqual([{ id: 1, body: 'first' }]);
  });

  test('a constraint violation surfaces with the real SQLSTATE in cause', async () => {
    await pg.run('insert into it_notes (id, body) values (1, $1)', ['first']);

    const error = await db
      .query({ sql: 'insert into it_notes (id, body) values ($1, $2)', params: [1, 'dup'] })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    // Bun's SQL carries SQLSTATE in `errno`; postgres.js carries it in `code`.
    // The assertion accepts either so it documents the shape rather than a vendor.
    const shaped = error as { code?: string; errno?: string; cause?: { errno?: string } };
    expect(shaped.errno ?? shaped.code ?? shaped.cause?.errno).toBe('23505');
  });

  test('interactiveTx commits, and rolls back on throw', async () => {
    await db.interactiveTx(async (tx) => {
      await tx.query({ sql: 'insert into it_notes (id, body) values ($1, $2)', params: [1, 'a'] });
    });

    await db
      .interactiveTx(async (tx) => {
        await tx.query({
          sql: 'insert into it_notes (id, body) values ($1, $2)',
          params: [2, 'b'],
        });
        throw new Error('rollback');
      })
      .catch(() => undefined);

    const rows = await pg.run('select id from it_notes order by id');
    expect(rows).toEqual([{ id: 1 }]);
  });

  test('a nested transaction is a savepoint: the inner failure keeps the outer work', async () => {
    await db.interactiveTx(async (tx) => {
      await tx.query({ sql: 'insert into it_notes (id, body) values ($1, $2)', params: [1, 'a'] });
      await tx
        .interactiveTx(async (inner) => {
          await inner.query({
            sql: 'insert into it_notes (id, body) values ($1, $2)',
            params: [2, 'b'],
          });
          throw new Error('inner');
        })
        .catch(() => undefined);
    });

    const rows = await pg.run('select id from it_notes order by id');
    expect(rows).toEqual([{ id: 1 }]);
  });

  test('connection() pins one backend, and close() returns it to the pool', async () => {
    const pids = await db.pinned(async (pinned) => {
      const first = await pinned.query({ sql: 'select pg_backend_pid() as pid', params: [] });
      const second = await pinned.query({ sql: 'select pg_backend_pid() as pid', params: [] });
      return [(first.rows[0] as { pid: number }).pid, (second.rows[0] as { pid: number }).pid];
    });

    expect(pids[0]).toBe(pids[1]);
    // The pool stays usable afterwards: the connection went back, not away.
    const after = await db.query({ sql: 'select 1 as one', params: [] });
    expect(after.rows).toEqual([{ one: 1 }]);
  });

  test('connection() refuses on D1, where there is no session to pin', async () => {
    const d1 = createDatabase({
      driver: {
        capabilities: {
          interactiveTx: false,
          batch: true,
          placeholder: 'question',
          engine: 'd1',
          pinnedConnection: false,
        },
        query: async () => ({ rows: [], changes: 0 }),
        batch: async () => [],
        health: async () => ({ ok: true, engine: 'd1', latencyMs: 0, detail: {} }),
        close: async () => undefined,
      },
    });

    const error = await d1
      .pinned(async () => undefined)
      .then(
        () => undefined,
        (reason: unknown) => reason as { code?: string; hint?: string },
      );
    expect(error?.code).toBe('DB_CONNECTION_PIN_UNSUPPORTED');
    expect(error?.hint).toContain('D1 has no per-session state to pin');
  });

  test('health() reports the engine and a measured latency', async () => {
    const health = await db.health();
    expect(health.ok).toBe(true);
    expect(health.engine).toBe('postgres');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
