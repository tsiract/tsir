/**
 * `@tsir/seed` against a real Postgres server (`SED-003`, `SED-004`, `SED-005`).
 *
 * The unit suite proves ordering and refusal logic with a fake. This one proves
 * the two properties a fake cannot: that a failing seeder rolls back **only its
 * own** transaction, and that running the same seeder twice leaves the same rows
 * (which is what `assertIdempotent` claims to enforce).
 *
 * Run it with `DATABASE_URL=… bun src/tools/test-integration.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { systemClock, systemRandom } from '@tsir/core';
import { createDatabase, type Database } from '@tsir/database';
import { createPostgresDriver } from '@tsir/database/postgres';

import { connectPostgres, databaseUrl, type TestDatabase } from '../../../tools/pg-test-client.ts';
import { defineSeeder } from './seeder.ts';
import { assertIdempotent, runSeeders } from './runner.ts';

const url = databaseUrl();
const suite = url === undefined ? describe.skip : describe;

let pg: TestDatabase;
let db: Database;

const clock = systemClock();
const random = systemRandom();

async function count(table: string): Promise<number> {
  const rows = await pg.run(`select count(*)::int as n from "${table}"`);
  return Number(rows[0]?.['n'] ?? -1);
}

suite('seed · Postgres integration (SED-003…SED-005)', () => {
  beforeAll(() => {
    pg = connectPostgres(url ?? '');
    db = createDatabase({ driver: createPostgresDriver({ client: pg.client }), logging: 'off' });
  });

  afterAll(async () => {
    await db.close();
    await pg.close();
  });

  beforeEach(async () => {
    await pg.run('drop table if exists seed_roles');
    await pg.run('drop table if exists seed_users');
    await pg.run('create table seed_roles (name text primary key)');
    await pg.run('create table seed_users (email text primary key, role text not null)');
  });

  test('seeders run in order and a second run leaves the same rows', async () => {
    const roles = defineSeeder({
      name: 'RolesSeeder',
      order: 10,
      idempotent: true,
      environments: ['test'],
      run: async ({ db: tx }) => {
        await tx.query({
          sql: 'insert into seed_roles (name) values ($1) on conflict do nothing',
          params: ['admin'],
        });
      },
    });
    const users = defineSeeder({
      name: 'UsersSeeder',
      order: 20,
      idempotent: true,
      environments: ['test'],
      run: async ({ db: tx }) => {
        await tx.query({
          sql: 'insert into seed_users (email, role) values ($1, $2) on conflict do nothing',
          params: ['admin@example.test', 'admin'],
        });
      },
    });

    const options = {
      database: db,
      // Deliberately out of order: the runner sorts, not the caller.
      seeders: [users, roles],
      env: 'test' as const,
      clock,
      random,
    };

    const first = await runSeeders(options);
    expect(first.seeded.map((entry) => entry.name)).toEqual(['RolesSeeder', 'UsersSeeder']);
    expect(first.seeded.every((entry) => entry.atomic)).toBe(true);

    await runSeeders(options);

    expect(await count('seed_roles')).toBe(1);
    expect(await count('seed_users')).toBe(1);
  });

  test('a failing seeder rolls back only its own transaction (SED-005)', async () => {
    const good = defineSeeder({
      name: 'GoodSeeder',
      order: 10,
      idempotent: true,
      environments: ['test'],
      run: async ({ db: tx }) => {
        await tx.query({ sql: 'insert into seed_roles (name) values ($1)', params: ['admin'] });
      },
    });
    const bad = defineSeeder({
      name: 'BadSeeder',
      order: 20,
      idempotent: true,
      environments: ['test'],
      run: async ({ db: tx }) => {
        await tx.query({
          sql: 'insert into seed_users (email, role) values ($1, $2)',
          params: ['x@example.test', 'admin'],
        });
        throw new Error('boom');
      },
    });

    const error = await runSeeders({
      database: db,
      seeders: [good, bad],
      env: 'test',
      clock,
      random,
    }).then(
      () => undefined,
      (reason: unknown) => reason as { code?: string },
    );

    expect(error?.code).toBe('SED_FAILED');
    // The good seeder committed; the bad one's insert disappeared with its tx.
    expect(await count('seed_roles')).toBe(1);
    expect(await count('seed_users')).toBe(0);
  });

  test('assertIdempotent passes for an idempotent seeder and fails for one that duplicates', async () => {
    const idempotent = defineSeeder({
      name: 'IdempotentSeeder',
      order: 10,
      idempotent: true,
      environments: ['test'],
      run: async ({ db: tx }) => {
        await tx.query({
          sql: 'insert into seed_roles (name) values ($1) on conflict do nothing',
          params: ['admin'],
        });
      },
    });
    const duplicating = defineSeeder({
      name: 'DuplicatingSeeder',
      order: 20,
      idempotent: false,
      environments: ['test'],
      run: async ({ db: tx }) => {
        await tx.query({
          sql: 'insert into seed_roles (name) values ($1) on conflict do nothing',
          // A fresh row each run: the harness must catch the drift it causes.
          params: [`role-${random.uuid()}`],
        });
      },
    });

    const snapshot = async (database: Database): Promise<Record<string, number>> => {
      const result = await database.query({
        sql: 'select count(*)::int as n from seed_roles',
        params: [],
      });
      return { seed_roles: Number((result.rows[0] as { n: number }).n) };
    };

    const stable = await assertIdempotent({
      database: db,
      seeders: [idempotent],
      env: 'test',
      clock,
      random,
      snapshot,
    });
    // Empty list = nothing drifted between the two runs.
    expect(stable).toEqual([]);

    const unstable = await assertIdempotent({
      database: db,
      seeders: [duplicating],
      env: 'test',
      clock,
      random,
      snapshot,
    }).then(
      () => undefined,
      (reason: unknown) => reason as { code?: string },
    );
    expect(unstable?.code).toBe('SED_NOT_IDEMPOTENT');
  });
});
