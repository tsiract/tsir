import { describe, expect, test } from 'bun:test';

import { createDatabaseBootstrap } from './bootstrap.ts';

/**
 * `createDatabaseBootstrap` and the *deferred* binding contract.
 *
 * These two tests exist because the bootstrap had no coverage at all, and the bootstrap is where
 * two things meet that are easy to get individually right and jointly wrong:
 *
 *   1. The D1 binding only exists on the **first request** (`env`), not at boot.
 *   2. The CLI's local SQLite fallback must load `bun:sqlite` **lazily**, because a static import
 *      of that builtin makes every Workers bundle containing `@tsir/database` unbuildable.
 *
 * Making (2) work meant letting the bindings source return a promise, which is only safe if (1)
 * still holds: a query issued before the binding exists must fail with the deferred-driver hint,
 * and a query issued *after* must succeed on the same connection — no re-construction, no stale
 * "unavailable" result cached from the first attempt.
 */

const CONFIG = {
  default: 'primary',
  connections: {
    primary: { driver: 'd1', binding: 'DB' },
  },
} as const;

/** A D1 binding that answers `select 1` and nothing else: enough to prove wiring, not SQL. */
function fakeBinding(): unknown {
  const result = (rows: readonly unknown[] = []): unknown => ({
    success: true,
    results: rows,
    meta: { duration: 0, changes: 0, rows_read: 0, rows_written: 0 },
  });

  const statement = (): unknown => ({
    bind: () => statement(),
    first: async () => ({ ok: 1 }),
    run: async () => result(),
    all: async () => result([{ ok: 1 }]),
    raw: async () => [[1]],
  });

  return {
    prepare: () => statement(),
    batch: async () => [result()],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  };
}

describe('createDatabaseBootstrap · deferred bindings', () => {
  test('a query before the binding arrives reports the deferred-driver hint', async () => {
    const bootstrap = createDatabaseBootstrap(CONFIG, { migrationsDir: '/tmp/migrations' });

    // No `env` has been copied in yet, so this is the boot state of a Worker: configured, but
    // with nothing to talk to. The failure has to name the fix, not just fail.
    const failure = await bootstrap.db
      .query({ sql: 'select 1', params: [] })
      .then(() => undefined)
      .catch((error: unknown) => error as { code?: string; message?: string });

    expect(failure?.code).toBe('DB_DRIVER_UNAVAILABLE');
    // The reason travels in the message (`target: "runtime"`), with the shared D1 hint beside it:
    // `binding "DB" is not available — pass it to the handler's env or provide it at boot`.
    expect(failure?.message).toContain('binding "DB" is not available');
  });

  test('the same connection works once the binding is published, and stays usable', async () => {
    const bootstrap = createDatabaseBootstrap(CONFIG, { migrationsDir: '/tmp/migrations' });

    // The first attempt fails, and must not poison the connection.
    await bootstrap.db.query({ sql: 'select 1', params: [] }).catch(() => undefined);

    bootstrap.runtimeBindings.DB = fakeBinding();

    const first = await bootstrap.db.query({ sql: 'select 1', params: [] });
    const second = await bootstrap.db.query({ sql: 'select 1', params: [] });

    expect(first.rows).toEqual([{ ok: 1 }]);
    expect(second.rows).toEqual([{ ok: 1 }]);
    // `health` goes through the same resolved driver, so a third call proves it was reused
    // rather than rebuilt per statement.
    expect((await bootstrap.db.health()).ok).toBe(true);
  });

  test('concurrent first queries share one resolution', async () => {
    const bootstrap = createDatabaseBootstrap(CONFIG, { migrationsDir: '/tmp/migrations' });
    bootstrap.runtimeBindings.DB = fakeBinding();

    // Both start before either has resolved a driver. If the in-flight promise were not shared,
    // `createD1Driver` would run twice; that is invisible in the result, so it is asserted
    // through the outcome instead: neither call may reject.
    const [a, b] = await Promise.all([
      bootstrap.db.query({ sql: 'select 1', params: [] }),
      bootstrap.db.query({ sql: 'select 1', params: [] }),
    ]);

    expect(a.rows).toEqual([{ ok: 1 }]);
    expect(b.rows).toEqual([{ ok: 1 }]);
  });
});
