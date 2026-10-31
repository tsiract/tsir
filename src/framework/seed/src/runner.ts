/**
 * The seeder runner (`SED-002`, `SED-005`, `SED-006`, `SED-007`).
 *
 * Planned first, executed second. Planning answers four questions before a single
 * row is written, because every one of them is a reason *not* to write:
 *
 *   1. **Order** — sorted by `order`, then name; two seeders sharing an order is
 *      `SED_ORDER_AMBIGUOUS`, and it fails before the first insert. Ordering by
 *      "whatever the array said" works until someone reorders an import.
 *   2. **Environment** — a seeder listing `development` does not run in `staging`,
 *      and production requires both a `production: true` declaration *and* an
 *      explicit `--reference-data` (`SED_PRODUCTION_REFUSED` otherwise).
 *   3. **Selection** — `--class` runs exactly what was asked for, including when
 *      the dependency ordering would have pulled a neighbour in. Selecting an
 *      unknown class is an error, never an empty success.
 *   4. **Transaction** — one transaction per seeder, so a failure rolls back that
 *      seeder and leaves the earlier ones committed. A seeder that opted out gets
 *      no transaction and the runner says so, rather than pretending.
 *   5. **Connection** (`SED-011`) — a seeder that declares `connections` runs only
 *      when the bound database is one of them. Also before the first insert: rows
 *      in the wrong database are not undone by a later error.
 */

import type { Clock, Random } from '@tsir/core';
import { TsirError } from '@tsir/container';
import type { Database } from '@tsir/database';

import type { SeedEnvironment, Seeder, SeederContext } from './seeder.ts';

export interface SeedOptions {
  readonly database: Database;
  readonly seeders: readonly Seeder[];
  readonly env: SeedEnvironment;
  /** Exact seeder names to run, in the order they will run. Omit for all. */
  readonly only?: readonly string[];
  /** Required for production; gates every seeder, not just the ones that ask. */
  readonly referenceData?: boolean;
  readonly clock: Clock;
  readonly random: Random;
  readonly log?: (message: string) => void;
}

export interface SeededOne {
  readonly name: string;
  readonly durationMs: number;
  /** False when the seeder declared `transaction: false`, or the engine cannot. */
  readonly atomic: boolean;
}

export interface SkippedOne {
  readonly name: string;
  readonly reason: 'environment' | 'not-selected' | 'production-refused';
}

export interface SeedResult {
  readonly seeded: readonly SeededOne[];
  readonly skipped: readonly SkippedOne[];
}

/** Environment gate: what this run is allowed to touch at all (`SED-006`). */
export function assertEnvironmentAllowed(options: {
  readonly env: SeedEnvironment;
  readonly seeders: readonly Seeder[];
  readonly referenceData?: boolean;
}): void {
  if (options.env !== 'production') return;

  if (options.referenceData !== true) {
    throw new TsirError('SED_PRODUCTION_REFUSED', 'refusing to seed a production database', {
      kind: 'database',
      hint:
        '`tsir db:seed` never runs against production without --reference-data, and only seeders that ' +
        'declare `production: true` will run even then',
    });
  }

  const allowed = options.seeders.filter((seeder) => seeder.production === true);
  if (allowed.length === 0) {
    throw new TsirError(
      'SED_PRODUCTION_REFUSED',
      'no seeder declares `production: true`, so --reference-data has nothing it may run',
      {
        kind: 'database',
        hint: 'development fixtures belong in development and test; production seeders are reference data only',
      },
    );
  }
}

/**
 * Plans the run: filtering, ordering and tie detection. Pure — the tests assert
 * the plan without a database, which is the only way to prove "ties fail before
 * any insert" cheaply.
 */
export function planSeeders(options: {
  readonly seeders: readonly Seeder[];
  readonly env: SeedEnvironment;
  readonly only?: readonly string[];
  readonly referenceData?: boolean;
}): { readonly run: readonly Seeder[]; readonly skipped: readonly SkippedOne[] } {
  const byName = new Map<string, Seeder>();
  for (const seeder of options.seeders) {
    if (byName.has(seeder.name)) {
      throw new TsirError('SED_DUPLICATE_NAME', `two seeders are named "${seeder.name}"`, {
        kind: 'database',
        hint: 'names are the selection key; rename one',
        context: { seeder: seeder.name },
      });
    }
    byName.set(seeder.name, seeder);
  }

  if (options.only !== undefined) {
    const unknown = options.only.filter((name) => !byName.has(name));
    if (unknown.length > 0) {
      throw new TsirError('SED_UNKNOWN_CLASS', `no seeder named ${unknown.join(', ')}`, {
        kind: 'database',
        hint: `available: ${[...byName.keys()].join(', ') || '(none)'}`,
        context: { seeder: unknown[0] ?? '' },
      });
    }
  }

  const selected = new Set(options.only ?? [...byName.keys()]);
  const skipped: SkippedOne[] = [];
  const runnable: Seeder[] = [];

  for (const seeder of options.seeders) {
    if (!selected.has(seeder.name)) {
      skipped.push({ name: seeder.name, reason: 'not-selected' });
      continue;
    }
    if (options.env === 'production') {
      // In production only reference-data seeders run, whatever else was selected.
      if (seeder.production !== true) {
        skipped.push({ name: seeder.name, reason: 'production-refused' });
        continue;
      }
    } else if (!seeder.environments.includes(options.env)) {
      skipped.push({ name: seeder.name, reason: 'environment' });
      continue;
    }
    runnable.push(seeder);
  }

  const ordered = [...runnable].sort((a, b) => (a.order === b.order ? 0 : a.order - b.order));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous !== undefined && current !== undefined && previous.order === current.order) {
      throw new TsirError(
        'SED_ORDER_AMBIGUOUS',
        `"${previous.name}" and "${current.name}" both use order ${String(current.order)}`,
        {
          kind: 'database',
          hint: 'ties are not broken alphabetically — give one of them a different order',
          context: { seeder: current.name },
        },
      );
    }
  }

  return { run: Object.freeze(ordered), skipped };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Refuses a run whose bound connection a seeder did not declare (`SED-011`).
 *
 * Every offending seeder is reported at once: fixing them one per run turns a typo
 * in `--connection` into a guessing game.
 */
export function assertConnectionsAllowed(options: {
  readonly connection: string;
  readonly seeders: readonly Seeder[];
}): void {
  const offenders = options.seeders.filter(
    (seeder) =>
      seeder.connections !== undefined && !seeder.connections.includes(options.connection),
  );
  if (offenders.length === 0) return;

  const detail = offenders
    .map((seeder) => `${seeder.name} (declares: ${(seeder.connections ?? []).join(', ')})`)
    .join('; ');
  throw new TsirError(
    'SED_UNDECLARED_CONNECTION',
    `${String(offenders.length)} seeder(s) do not declare connection "${options.connection}": ${detail}`,
    {
      kind: 'database',
      hint: "pass the connection that seeder names, or add it to the seeder's `connections` list — nothing was written",
      context: { connection: options.connection },
    },
  );
}

export async function runSeeders(options: SeedOptions): Promise<SeedResult> {
  const log = options.log ?? (() => undefined);

  assertEnvironmentAllowed({
    env: options.env,
    seeders: options.seeders,
    ...(options.referenceData === undefined ? {} : { referenceData: options.referenceData }),
  });

  const plan = planSeeders({
    seeders: options.seeders,
    env: options.env,
    ...(options.only === undefined ? {} : { only: options.only }),
    ...(options.referenceData === undefined ? {} : { referenceData: options.referenceData }),
  });

  // Checked against the *plan*, before the first insert: a seeder skipped for its
  // environment cannot be the reason a run fails.
  assertConnectionsAllowed({ connection: options.database.name, seeders: plan.run });

  const seeded: SeededOne[] = [];

  for (const seeder of plan.run) {
    const context: SeederContext = {
      db: options.database,
      env: options.env,
      clock: options.clock,
      random: options.random,
      log,
    };
    const started = options.clock.monotonicMs();
    // A seeder that opted out of a transaction, or an engine that has none (D1),
    // runs plainly — and the result says `atomic: false` so a half-seeded table
    // is never mistaken for success.
    const transactional =
      seeder.transaction !== false && options.database.capabilities.interactiveTx;

    try {
      if (transactional) {
        await options.database.interactiveTx(async (tx) => {
          await seeder.run({ ...context, db: tx });
        });
      } else {
        await seeder.run(context);
      }
    } catch (error: unknown) {
      throw new TsirError('SED_FAILED', `seeder "${seeder.name}" failed: ${describe(error)}`, {
        kind: 'database',
        hint: transactional
          ? 'its transaction was rolled back; earlier seeders stay committed'
          : 'this seeder ran without a transaction, so some of its rows may exist already',
        context: { seeder: seeder.name },
        cause: error,
      });
    }

    seeded.push({
      name: seeder.name,
      durationMs: options.clock.monotonicMs() - started,
      atomic: transactional,
    });
    log(`seeded ${seeder.name}`);
  }

  return { seeded, skipped: plan.skipped };
}

/**
 * Runs every seeder twice, and reports which ones are not idempotent (`SED-004`).
 *
 * This is a `@tsir/testing`-friendly helper rather than a test assertion of its own:
 * the count query belongs to the application, because only it knows which table a
 * seeder is about. The contract is the callback.
 */
export async function assertIdempotent(
  options: SeedOptions & {
    /** Row counts for every table the seeders touch, after one run. */
    readonly snapshot: (database: Database) => Promise<Readonly<Record<string, number>>>;
  },
): Promise<readonly string[]> {
  await runSeeders(options);
  const first = await options.snapshot(options.database);
  await runSeeders(options);
  const second = await options.snapshot(options.database);

  const unstable = Object.keys(first).filter((table) => first[table] !== second[table]);
  if (unstable.length > 0) {
    throw new TsirError(
      'SED_NOT_IDEMPOTENT',
      `running the seeders twice changed row counts in: ${unstable.join(', ')}`,
      {
        kind: 'database',
        hint: 'a seeder declared `idempotent: true` must upsert or skip; use `onConflictDoNothing()`',
      },
    );
  }
  return unstable;
}
