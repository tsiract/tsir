/**
 * @tsir/seed — seeders that are safe to run twice.
 *
 * The whole design is one sentence: **a seeder declares what it needs to be
 * protected from, and the runner enforces it before the first insert.** Order,
 * environment, production refusal, transaction and idempotency are all declared
 * data, checkable without running the seeder at all.
 *
 *   import { defineSeeder, runSeeders } from '@tsir/seed';
 *
 * Seeding is a development and reference-data operation. It never runs from a
 * request path, never runs automatically, and never runs against production
 * without an explicit flag *and* a seeder that opted in.
 */

export { defineSeeder, defineSeeders } from './seeder.ts';
export type { SeedEnvironment, Seeder, SeederContext, SeederDefinition } from './seeder.ts';

export { defineFixture } from './fixture.ts';
export type { Fixture, FixtureContext, FixtureDefinition } from './fixture.ts';

export { assertEnvironmentAllowed, assertIdempotent, planSeeders, runSeeders } from './runner.ts';
export type { SeedOptions, SeedResult, SeededOne, SkippedOne } from './runner.ts';
