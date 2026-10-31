/**
 * Fixture builders (`SED-008`).
 *
 * A seeder describes data that ships; a fixture describes data a *test* needs.
 * They share a problem — "this row, except for one field" — and the answer is the
 * same shape both times: typed defaults, a spread of overrides, and an insert
 * that the caller supplies because `@tsir/seed` does not know the schema.
 *
 * Three properties are deliberate:
 *
 *   · **The type is the schema.** `T` comes from `defaults`, so an override of a
 *     field that does not exist is a compile error, not a silently ignored key.
 *   · **Deterministic by default.** Each build gets an incrementing `index`, and
 *     randomness arrives through the same `Random` the seeder runners use, so a
 *     failing test reproduces.
 *   · **No hidden insert.** `create()` calls the `insert` you passed; it does not
 *     look up a table, and it does not pretend to know a Drizzle table type.
 */

import { fixtureInvalid, fixtureNoInsert } from './errors.ts';
import type { Random } from '@tsir/core';
import type { Database } from '@tsir/database';

export interface FixtureContext {
  /** Position in the current build sequence, starting at 0. */
  readonly index: number;
  /** The runner's `Random`, so fixtures and seeders share one source. */
  readonly random: Random;
}

export interface FixtureDefinition<T> {
  /** Used in error messages and nothing else. */
  readonly name: string;
  readonly defaults: (context: FixtureContext) => T;
  /** Writes the row. Receives the built value, returns whatever the caller wants. */
  readonly insert?: (database: Database, row: T) => Promise<unknown>;
}

export interface Fixture<T> {
  readonly name: string;
  /** Builds without touching a database. Overrides win over defaults. */
  build(overrides?: Partial<T>): T;
  /** `count` rows, indexes continuing from the previous build. */
  buildMany(count: number, overrides?: (index: number) => Partial<T>): readonly T[];
  /** Builds and inserts once. Requires `insert` on the definition. */
  create(database: Database, overrides?: Partial<T>): Promise<unknown>;
  /** Builds and inserts `count` rows in order. Requires `insert`. */
  createMany(
    database: Database,
    count: number,
    overrides?: (index: number) => Partial<T>,
  ): Promise<readonly unknown[]>;
  /** Resets the index counter, so a test can assert on generated values. */
  reset(): void;
}

export function defineFixture<T>(
  definition: FixtureDefinition<T>,
  options: { readonly random: Random },
): Fixture<T> {
  if (definition.name.trim() === '') {
    throw fixtureInvalid('a fixture needs a non-empty name');
  }

  let index = 0;

  function build(overrides: Partial<T> = {}): T {
    const context: FixtureContext = { index, random: options.random };
    index += 1;
    // Defaults first, overrides second: an override can set a field to
    // `undefined` if it wants to, which spreading the other way would not allow.
    return { ...definition.defaults(context), ...overrides };
  }

  function buildMany(count: number, overrides?: (index: number) => Partial<T>): readonly T[] {
    return Array.from({ length: count }, (_, position) => build(overrides?.(position) ?? {}));
  }

  async function insertOne(database: Database, row: T): Promise<unknown> {
    if (definition.insert === undefined) {
      throw fixtureNoInsert(
        `fixture "${definition.name}" has no insert(); call build() instead, or pass an insert function`,
      );
    }
    return definition.insert(database, row);
  }

  return {
    name: definition.name,
    build,
    buildMany,
    create: (database, overrides = {}) => insertOne(database, build(overrides)),
    async createMany(database, count, overrides) {
      const rows = buildMany(count, overrides);
      const inserted: unknown[] = [];
      for (const row of rows) inserted.push(await insertOne(database, row));
      return inserted;
    },
    reset() {
      index = 0;
    },
  };
}
