/**
 * Type-level test for the Postgres driver (`DB-012`).
 *
 * The driver in `src/postgres.ts` is typed against a **structural** subset of
 * `postgres.js` and never imports it (ADR-0009). That is only safe if the real
 * client actually satisfies the shape — this file is the proof, and it is checked
 * by `tsc --noEmit` rather than at runtime, because the whole point is that no
 * Postgres client is installed at runtime.
 *
 * `postgres` is a dev dependency for exactly this reason.
 */

import postgres from 'postgres';

import type { PgClientLike, PgQueryLike, PgResultLike } from '../src/postgres.ts';

// The whole client: `unsafe`, `begin`, `end`.
const client: PgClientLike = postgres('postgres://user:pass@localhost:5432/app');

// The root client is what `createPostgresDriver({ client })` takes.
export const driverClient = client;

// `unsafe()` returns a thenable, so it can be awaited — and `raw()` exists on it,
// which the `format: 'arrays'` path depends on.
const pending: PgQueryLike = client.unsafe('select $1::int as n', [1]);
export async function read(): Promise<readonly unknown[]> {
  const objects: PgResultLike = await pending;
  const positional = await pending.raw?.();
  return [objects.length, positional?.length ?? 0];
}

// A transaction scope is *also* a client, which is what makes `interactiveTx`
// return a driver rather than a special case.
export const inTransaction =
  client.begin === undefined
    ? undefined
    : client.begin(async (tx) => {
        const scoped: PgClientLike = tx;
        await scoped.unsafe('select 1');
        return tx.unsafe('select 2');
      });

// `end()` takes the timeout the driver passes on close.
export const closed = client.end?.({ timeout: 500 });
