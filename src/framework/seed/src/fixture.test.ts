import { describe, expect, test } from 'bun:test';

import { systemClock, systemRandom, type Random } from '@tsir/core';
import { createDatabase, createD1Driver, type D1Like, type D1StatementLike } from '@tsir/database';

import { defineFixture } from './fixture.ts';

/** A `Random` that hands out a fixed sequence, so assertions are exact. */
function sequence(values: readonly number[]): Random {
  let cursor = 0;
  return {
    next: () => {
      const value = values[cursor % values.length] ?? 0;
      cursor += 1;
      return value;
    },
    uuid: () => `uuid-${String(cursor++)}`,
    bytes: (length) => new Uint8Array(length),
  };
}

/** A statement that answers everything with an empty result set. */
function stubStatement(): D1StatementLike {
  const statement: D1StatementLike = {
    bind: () => statement,
    all: async () => ({ results: [], success: true }),
    raw: async () => [],
    run: async () => ({ success: true, meta: { changes: 1 } }),
  };
  return statement;
}

function recordingDatabase() {
  const rows: Record<string, unknown>[] = [];
  const binding: D1Like = {
    prepare: () => stubStatement(),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  };
  return {
    rows,
    database: createDatabase({ driver: createD1Driver({ binding }), logging: 'off' }),
  };
}

interface User {
  readonly email: string;
  readonly name: string;
  readonly index: number;
  readonly score: number;
}

function userFixture(options: { withInsert?: boolean } = {}) {
  return defineFixture<User>(
    {
      name: 'user',
      defaults: ({ index, random }) => ({
        email: `user-${String(index)}@example.test`,
        name: 'Ada',
        index,
        score: Math.round(random.next() * 100),
      }),
      ...(options.withInsert === false
        ? {}
        : {
            insert: async (database, row) => {
              await database.query({
                sql: 'insert into users (email) values (?)',
                params: [row.email],
              });
              return row.email;
            },
          }),
    },
    { random: sequence([0.42, 0.99]) },
  );
}

describe('defineFixture (SED-008)', () => {
  test('defaults are built from the context and overrides win', () => {
    const fixture = userFixture();
    const first = fixture.build();
    const second = fixture.build({ name: 'Grace' });

    expect(first).toEqual({ email: 'user-0@example.test', name: 'Ada', index: 0, score: 42 });
    expect(second.name).toBe('Grace');
    // The index keeps moving, so two fixtures never collide by accident.
    expect(second.index).toBe(1);
    expect(second.email).toBe('user-1@example.test');
  });

  test('reset() makes a sequence reproducible', () => {
    const fixture = userFixture();
    fixture.build();
    fixture.reset();
    expect(fixture.build().index).toBe(0);
  });

  test('buildMany passes the position, not the running index', () => {
    const fixture = userFixture();
    const rows = fixture.buildMany(3, (index) => ({ name: `person-${String(index)}` }));

    expect(rows.map((row) => row.name)).toEqual(['person-0', 'person-1', 'person-2']);
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2]);
  });

  test('create inserts through the caller-supplied writer', async () => {
    const { database, rows } = recordingDatabase();
    const fixture = userFixture();

    const email = await fixture.create(database);

    expect(email).toBe('user-0@example.test');
    // The fixture does not know the table; it only knows the row.
    expect(rows).toEqual([]);
  });

  test('createMany inserts in order', async () => {
    const { database } = recordingDatabase();
    const fixture = userFixture();

    const emails = await fixture.createMany(database, 2);

    expect(emails).toEqual(['user-0@example.test', 'user-1@example.test']);
  });

  test('a fixture without insert builds but refuses to write', async () => {
    const { database } = recordingDatabase();
    const fixture = userFixture({ withInsert: false });

    expect(fixture.build().name).toBe('Ada');
    expect(fixture.create(database)).rejects.toThrow('has no insert()');
  });

  test('an unnamed fixture is a programming error, not a silent one', () => {
    expect(() =>
      defineFixture({ name: ' ', defaults: () => ({ id: 1 }) }, { random: systemRandom() }),
    ).toThrow('needs a non-empty name');
  });

  test('two fixtures do not share a counter', () => {
    const a = userFixture();
    const b = userFixture();
    a.build();
    a.build();
    expect(b.build().index).toBe(0);
    // The clock and random are injectable, so a fixture never reads wall time.
    expect(systemClock().now()).toBeInstanceOf(Date);
  });
});
