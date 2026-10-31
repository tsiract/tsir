/**
 * The seeder contract (`SED-001`).
 *
 * A seeder is data, not a script: a name, an order, a declaration of whether it
 * is safe to run twice, and the environments where it belongs. Everything the
 * runner needs to protect you from a bad seeder is in the declaration, which is
 * why `defineSeeder` validates it instead of trusting it.
 *
 * Three members are load-bearing:
 *
 *   · `idempotent` — the runner *tests* this by running the seeder twice against
 *     a real database (`SED-004`); declaring it is a promise, not a comment.
 *   · `environments` — a seeder that lists `production` is a reference-data
 *     seeder, and the runner still refuses to touch production without
 *     `--reference-data` (`SED-006`, `SED-009`).
 *   · `transaction` — defaults to `true`; turning it off is allowed but must be
 *     justified, because a half-seeded table is a debugging session.
 *
 * One member is opt-in and load-bearing in a multi-connection project:
 * `connections` (`SED-011`). A seeder that writes reference data belongs to one
 * database, and a run bound to another must be refused *before* the first insert —
 * after it, the damage is rows in the wrong place.
 */

import { TsirError } from '@tsir/container';
import type { Clock, Random } from '@tsir/core';
import type { Database } from '@tsir/database';

export type SeedEnvironment = 'development' | 'test' | 'staging' | 'production';

export interface SeederContext {
  readonly db: Database;
  readonly env: SeedEnvironment;
  /** Fixed in tests, so a seeder that reads the clock is still deterministic. */
  readonly clock: Clock;
  /** Seeded in tests; `random.uuid()` and `random.bytes()` come from here. */
  readonly random: Random;
  readonly log: (message: string) => void;
}

export interface Seeder {
  readonly name: string;
  /** Lower runs first. Ties are a boot error, not a coin flip (`SED_ORDER_AMBIGUOUS`). */
  readonly order: number;
  /** Must be true for any seeder that can run more than once without duplicating rows. */
  readonly idempotent: boolean;
  readonly environments: readonly SeedEnvironment[];
  /** Reference/lookup data that is legitimate in production (`SED-009`). */
  readonly production?: boolean;
  /** Defaults to `true`; `false` must say why in a comment. */
  readonly transaction?: boolean;
  /**
   * Connections this seeder is allowed to write to (`SED-011`).
   *
   * Omitted means "any connection this seeder is bound to" — the honest default
   * for a seeder with no opinion. Declaring them turns a wrong `--connection` into
   * a refusal instead of rows in the wrong database.
   */
  readonly connections?: readonly string[];
  run(context: SeederContext): Promise<void>;
}

export interface SeederDefinition extends Omit<
  Seeder,
  'name' | 'order' | 'idempotent' | 'environments'
> {
  readonly name: string;
  readonly order: number;
  readonly idempotent: boolean;
  readonly environments: readonly SeedEnvironment[];
}

const ENVIRONMENTS = new Set<string>(['development', 'test', 'staging', 'production']);

/**
 * Validates and freezes a seeder.
 *
 * The validation is not ceremony: an empty name breaks selection, a non-integer
 * order breaks tie detection, and an unknown environment silently never runs —
 * each of those is a bug that only shows up in the environment you were least
 * likely to test.
 */
export function defineSeeder(definition: SeederDefinition): Seeder {
  const { name, order, environments } = definition;

  if (typeof name !== 'string' || name.trim() === '') {
    throw new TsirError('SED_INVALID', 'a seeder needs a non-empty name', {
      kind: 'database',
      hint: 'the name is how `--class` selects it and how ties are reported',
    });
  }
  if (!Number.isInteger(order)) {
    throw new TsirError('SED_INVALID', `seeder "${name}" has a non-integer order`, {
      kind: 'database',
      hint: 'order is an integer; ties are detected, so 10 and 11 are safer than 10.5',
      context: { seeder: name },
    });
  }
  if (environments.length === 0) {
    throw new TsirError('SED_INVALID', `seeder "${name}" lists no environments`, {
      kind: 'database',
      hint: 'list at least one of development, test, staging, production',
      context: { seeder: name },
    });
  }
  for (const environment of environments) {
    if (!ENVIRONMENTS.has(environment)) {
      throw new TsirError(
        'SED_INVALID',
        `seeder "${name}" names unknown environment "${environment}"`,
        {
          kind: 'database',
          hint: 'valid environments: development, test, staging, production',
          context: { seeder: name },
        },
      );
    }
  }
  const connections = definition.connections;
  if (connections !== undefined) {
    if (connections.length === 0) {
      throw new TsirError('SED_INVALID', `seeder "${name}" declares an empty connections list`, {
        kind: 'database',
        hint: 'omit `connections` to allow any connection, or name at least one',
        context: { seeder: name },
      });
    }
    for (const connection of connections) {
      if (typeof connection !== 'string' || connection.trim() === '') {
        throw new TsirError('SED_INVALID', `seeder "${name}" names an empty connection`, {
          kind: 'database',
          hint: 'connection names are the keys of database.connections',
          context: { seeder: name },
        });
      }
    }
    if (new Set(connections).size !== connections.length) {
      throw new TsirError('SED_INVALID', `seeder "${name}" repeats a connection name`, {
        kind: 'database',
        hint: 'list each connection once',
        context: { seeder: name },
      });
    }
  }

  if (definition.production === true && !environments.includes('production')) {
    throw new TsirError('SED_INVALID', `seeder "${name}" declares production: true`, {
      kind: 'database',
      hint: 'but does not list "production" in environments — add it or drop the flag',
      context: { seeder: name },
    });
  }

  return Object.freeze({
    ...definition,
    environments: Object.freeze([...environments]),
    transaction: definition.transaction ?? true,
    ...(connections === undefined ? {} : { connections: Object.freeze([...connections]) }),
  });
}

/** Frozen copy of a list, so a caller cannot mutate the runner's plan. */
export function defineSeeders(seeders: readonly Seeder[]): readonly Seeder[] {
  return Object.freeze([...seeders]);
}
