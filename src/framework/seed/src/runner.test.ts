import { describe, expect, test } from 'bun:test';

import { TsirError } from '@tsir/container';
import { systemClock, systemRandom } from '@tsir/core';
import {
  createDatabase,
  createD1Driver,
  type D1Like,
  type D1ResultLike,
  type D1StatementLike,
} from '@tsir/database';
import { createPostgresDriver, type PgClientLike } from '@tsir/database/postgres';

import { defineSeeder, defineSeeders, type Seeder } from './seeder.ts';
import { assertEnvironmentAllowed, assertIdempotent, planSeeders, runSeeders } from './runner.ts';

/** A database that records queries and counts them per table, nothing more. */
function fakeDatabase(engine: 'd1' | 'postgres' = 'postgres', name?: string) {
  const queries: string[] = [];

  const d1: D1Like = {
    prepare: (sql: string) => {
      const statement = {
        bind: () => statement,
        all: async () => {
          queries.push(sql);
          return { results: [], success: true };
        },
        run: async () => ({ success: true, meta: { changes: 1 } }),
      };
      return statement;
    },
    batch: async <T = Record<string, unknown>>(
      statements: readonly D1StatementLike[],
    ): Promise<readonly D1ResultLike<T>[]> =>
      Promise.all(statements.map((entry) => entry.all<T>())),
    exec: async () => ({ count: 0, duration: 0 }),
  };

  const pg: PgClientLike = {
    unsafe: (sql: string) => {
      queries.push(sql);
      const rows: Record<string, unknown>[] = [];
      const result = Object.assign([...rows], { count: 0 }) as unknown as {
        readonly length: number;
      };
      const queryLike = {
        then: (
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (error: unknown) => unknown,
        ) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return queryLike as never;
    },
    begin: async (work) => work(pg),
  };

  const database =
    engine === 'd1'
      ? createDatabase({
          driver: createD1Driver({ binding: d1 }),
          logging: 'off',
          ...(name === undefined ? {} : { name }),
        })
      : createDatabase({
          driver: createPostgresDriver({ client: pg }),
          logging: 'off',
          ...(name === undefined ? {} : { name }),
        });

  return { database, queries };
}

function seeder(overrides: Partial<Seeder> & Pick<Seeder, 'name' | 'order'>): Seeder {
  return defineSeeder({
    idempotent: true,
    environments: ['development', 'test'],
    run: async () => undefined,
    ...overrides,
  });
}

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error: unknown) {
    return error instanceof TsirError ? error.code : `not-a-tsir-error: ${String(error)}`;
  }
};

describe('defineSeeder', () => {
  test('defaults to a transaction', () => {
    expect(seeder({ name: 'UsersSeeder', order: 10 }).transaction).toBe(true);
  });

  test('rejects a non-integer order', () => {
    expect(codeOf(() => seeder({ name: 'X', order: 1.5 }))).toBe('SED_INVALID');
  });

  test('rejects an empty environments list', () => {
    expect(codeOf(() => seeder({ name: 'X', order: 1, environments: [] }))).toBe('SED_INVALID');
  });

  test('rejects production: true without the production environment', () => {
    expect(codeOf(() => seeder({ name: 'X', order: 1, production: true }))).toBe('SED_INVALID');
  });
});

describe('planSeeders', () => {
  const first = seeder({ name: 'First', order: 10 });
  const second = seeder({ name: 'Second', order: 20 });
  const prod = seeder({
    name: 'Countries',
    order: 5,
    environments: ['development', 'test', 'production'],
    production: true,
  });

  test('orders by `order`, not by array position', () => {
    const plan = planSeeders({ seeders: [second, prod, first], env: 'development' });
    expect(plan.run.map((entry) => entry.name)).toEqual(['Countries', 'First', 'Second']);
  });

  test('two seeders sharing an order fail before anything runs', () => {
    expect(
      codeOf(() =>
        planSeeders({
          seeders: [seeder({ name: 'A', order: 10 }), seeder({ name: 'B', order: 10 })],
          env: 'development',
        }),
      ),
    ).toBe('SED_ORDER_AMBIGUOUS');
  });

  test('duplicate names are refused', () => {
    expect(
      codeOf(() =>
        planSeeders({
          seeders: [seeder({ name: 'A', order: 1 }), seeder({ name: 'A', order: 2 })],
          env: 'development',
        }),
      ),
    ).toBe('SED_DUPLICATE_NAME');
  });

  test('--class selects exactly those seeders', () => {
    const plan = planSeeders({ seeders: [first, second], env: 'development', only: ['Second'] });
    expect(plan.run.map((entry) => entry.name)).toEqual(['Second']);
    expect(plan.skipped).toEqual([{ name: 'First', reason: 'not-selected' }]);
  });

  test('an unknown class is an error, not an empty success', () => {
    expect(
      codeOf(() => planSeeders({ seeders: [first], env: 'development', only: ['Nope'] })),
    ).toBe('SED_UNKNOWN_CLASS');
  });

  test('a seeder outside the environment is skipped, with the reason', () => {
    const stagingOnly = seeder({ name: 'Staging', order: 30, environments: ['staging'] });
    const plan = planSeeders({ seeders: [first, stagingOnly], env: 'development' });
    expect(plan.run.map((entry) => entry.name)).toEqual(['First']);
    expect(plan.skipped).toContainEqual({ name: 'Staging', reason: 'environment' });
  });

  test('in production only `production: true` seeders run', () => {
    const plan = planSeeders({ seeders: [prod, first], env: 'production' });
    expect(plan.run.map((entry) => entry.name)).toEqual(['Countries']);
    expect(plan.skipped).toContainEqual({ name: 'First', reason: 'production-refused' });
  });
});

describe('assertEnvironmentAllowed', () => {
  const prod = seeder({
    name: 'Countries',
    order: 5,
    environments: ['production'],
    production: true,
  });

  test('production without --reference-data is refused', () => {
    expect(codeOf(() => assertEnvironmentAllowed({ env: 'production', seeders: [prod] }))).toBe(
      'SED_PRODUCTION_REFUSED',
    );
  });

  test('--reference-data with no production seeder is refused', () => {
    expect(
      codeOf(() =>
        assertEnvironmentAllowed({
          env: 'production',
          seeders: [seeder({ name: 'Dev', order: 1 })],
          referenceData: true,
        }),
      ),
    ).toBe('SED_PRODUCTION_REFUSED');
  });

  test('--reference-data with a production seeder is allowed', () => {
    expect(
      codeOf(() =>
        assertEnvironmentAllowed({ env: 'production', seeders: [prod], referenceData: true }),
      ),
    ).toBeUndefined();
  });
});

describe('runSeeders', () => {
  test('runs in order and reports each duration', async () => {
    const { database } = fakeDatabase();
    const seen: string[] = [];

    const result = await runSeeders({
      database,
      seeders: [
        seeder({ name: 'Second', order: 20, run: async () => void seen.push('second') }),
        seeder({ name: 'First', order: 10, run: async () => void seen.push('first') }),
      ],
      env: 'test',
      clock: systemClock(),
      random: systemRandom(),
    });

    expect(seen).toEqual(['first', 'second']);
    expect(result.seeded.map((entry) => entry.name)).toEqual(['First', 'Second']);
    expect(result.seeded[0]?.atomic).toBe(true);
  });

  test('a failing seeder stops the run and says which one', async () => {
    const { database } = fakeDatabase();

    expect(
      runSeeders({
        database,
        seeders: [
          seeder({ name: 'Ok', order: 1 }),
          seeder({
            name: 'Broken',
            order: 2,
            run: async () => {
              throw new Error('boom');
            },
          }),
        ],
        env: 'test',
        clock: systemClock(),
        random: systemRandom(),
      }),
    ).rejects.toThrow('seeder "Broken" failed: boom');
  });

  test('D1 has no interactive transaction, so a seeder runs non-atomically and says so', async () => {
    const { database } = fakeDatabase('d1');

    const result = await runSeeders({
      database,
      seeders: [seeder({ name: 'Users', order: 1 })],
      env: 'test',
      clock: systemClock(),
      random: systemRandom(),
    });

    expect(result.seeded[0]?.atomic).toBe(false);
  });

  test('transaction: false is honoured and reported', async () => {
    const { database } = fakeDatabase();

    const result = await runSeeders({
      database,
      seeders: [seeder({ name: 'Bulk', order: 1, transaction: false })],
      env: 'test',
      clock: systemClock(),
      random: systemRandom(),
    });

    expect(result.seeded[0]?.atomic).toBe(false);
  });

  test('the seeder receives the database, clock and random from the runner', async () => {
    const { database } = fakeDatabase();
    let seenEnv: string | undefined;
    let sawClock = false;

    await runSeeders({
      database,
      seeders: [
        seeder({
          name: 'Context',
          order: 1,
          run: async (context) => {
            seenEnv = context.env;
            sawClock = context.clock.iso().endsWith('Z');
            expect(context.db).toBeDefined();
            expect(context.random.uuid()).toMatch(/^[0-9a-f-]{36}$/);
          },
        }),
      ],
      env: 'test',
      clock: systemClock(),
      random: systemRandom(),
    });

    expect(seenEnv).toBe('test');
    expect(sawClock).toBe(true);
  });
});

describe('assertIdempotent', () => {
  test('passes when two runs leave the same row counts', async () => {
    const { database } = fakeDatabase();
    let rows = 0;

    const unstable = await assertIdempotent({
      database,
      seeders: [
        seeder({
          name: 'Upsert',
          order: 1,
          // Idempotent on purpose: the second run changes nothing.
          run: async () => {
            rows = 3;
          },
        }),
      ],
      env: 'test',
      clock: systemClock(),
      random: systemRandom(),
      snapshot: async () => ({ users: rows }),
    });

    expect(unstable).toEqual([]);
  });

  test('fails for a seeder that duplicates rows on the second run', async () => {
    const { database } = fakeDatabase();
    let rows = 0;

    expect(
      assertIdempotent({
        database,
        seeders: [
          seeder({
            name: 'Insert',
            order: 1,
            run: async () => {
              rows += 2;
            },
          }),
        ],
        env: 'test',
        clock: systemClock(),
        random: systemRandom(),
        snapshot: async () => ({ users: rows }),
      }),
    ).rejects.toThrow('changed row counts in: users');
  });
});
describe('defineSeeder validation (SED-001)', () => {
  test('refuses an empty or whitespace-only name', () => {
    expect(() => seeder({ name: '   ', order: 1, run: async () => undefined })).toThrow(
      'non-empty name',
    );
  });

  test('refuses an unknown environment instead of never running it', () => {
    expect(() =>
      seeder({
        name: 'Typo',
        order: 1,
        environments: ['dev' as never],
        run: async () => undefined,
      }),
    ).toThrow('unknown environment');
  });

  test('a seeder without an explicit transaction defaults to one', () => {
    const defined = seeder({ name: 'Default', order: 1, run: async () => undefined });
    expect(defined.transaction).toBe(true);
    // Frozen, so the plan a runner holds cannot be rewritten by a caller.
    expect(Object.isFrozen(defined)).toBe(true);
    expect(Object.isFrozen(defined.environments)).toBe(true);
  });

  test('defineSeeders freezes the list it is given', () => {
    const list = [seeder({ name: 'A', order: 1, run: async () => undefined })];
    const frozen = defineSeeders(list);
    expect(frozen).toHaveLength(1);
    expect(Object.isFrozen(frozen)).toBe(true);
  });
});

describe('a seeder declares its connections (SED-011)', () => {
  async function asyncCodeOf(work: () => Promise<unknown>): Promise<string> {
    try {
      await work();
      return 'none';
    } catch (reason: unknown) {
      return (reason as { code?: string }).code ?? 'no-code';
    }
  }

  test('a run bound to a connection the seeder does not declare is refused before the first insert', async () => {
    const { database, queries } = fakeDatabase('postgres', 'reporting');
    let ran = false;

    const code = await asyncCodeOf(() =>
      runSeeders({
        database,
        seeders: [
          seeder({
            name: 'UsersSeeder',
            order: 10,
            connections: ['app'],
            run: async () => {
              ran = true;
            },
          }),
        ],
        env: 'test',
        clock: systemClock(),
        random: systemRandom(),
      }),
    );

    expect(code).toBe('SED_UNDECLARED_CONNECTION');
    // Nothing was written and nothing ran: the check is before the loop, not
    // inside the seeder.
    expect(queries).toHaveLength(0);
    expect(ran).toBe(false);
  });

  test('the bound connection decides, and a matching declaration lets it run', async () => {
    const { database } = fakeDatabase('postgres', 'reporting');
    let ran = false;

    const result = await runSeeders({
      database,
      seeders: [
        seeder({
          name: 'ReportingSeeder',
          order: 10,
          connections: ['reporting'],
          run: async () => {
            ran = true;
          },
        }),
      ],
      env: 'test',
      clock: systemClock(),
      random: systemRandom(),
    });

    expect(result.seeded.map((entry) => entry.name)).toEqual(['ReportingSeeder']);
    expect(ran).toBe(true);
  });

  test('every offending seeder is reported in one error', async () => {
    const { database } = fakeDatabase('postgres', 'app');

    const error = (await runSeeders({
      database,
      seeders: [
        seeder({ name: 'A', order: 1, connections: ['reporting'] }),
        seeder({ name: 'B', order: 2, connections: ['analytics'] }),
      ],
      env: 'test',
      clock: systemClock(),
      random: systemRandom(),
    }).then(
      () => undefined,
      (reason: unknown) => reason as { message?: string },
    )) as { message?: string } | undefined;

    expect(error?.message).toContain('A');
    expect(error?.message).toContain('B');
    expect(error?.message).toContain('"app"');
  });

  test('an absent declaration means any connection, which is the honest default', async () => {
    const { database } = fakeDatabase('postgres', 'app');

    const result = await runSeeders({
      database,
      seeders: [seeder({ name: 'AnySeeder', order: 1 })],
      env: 'test',
      clock: systemClock(),
      random: systemRandom(),
    });

    expect(result.seeded.map((entry) => entry.name)).toEqual(['AnySeeder']);
  });

  test('the declaration is validated when the seeder is defined', () => {
    expect(codeOf(() => seeder({ name: 'X', order: 1, connections: [] }))).toBe('SED_INVALID');
    expect(codeOf(() => seeder({ name: 'X', order: 1, connections: [''] }))).toBe('SED_INVALID');
    expect(codeOf(() => seeder({ name: 'X', order: 1, connections: ['a', 'a'] }))).toBe(
      'SED_INVALID',
    );
  });
});
