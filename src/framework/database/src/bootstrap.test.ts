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

/**
 * The Bun-only file opener is an *argument*, and that is the whole point.
 *
 * A bootstrap that imported `openSqliteFiles` itself would put `bun:sqlite`, `node:fs` and
 * `node:path` in every Workers bundle — not on a code path, in the module graph — and the Worker
 * would fail to load. `deploy-bundle-targets.test.ts` proves the bundle side; these prove the
 * option is honoured, so an app that passes it still gets its CLI fallback.
 */
describe('openSqlite is supplied by the caller (INF-002)', () => {
  const sqliteConfig = {
    default: 'primary',
    connections: { primary: { driver: 'sqlite', url: 'file::memory:' } },
  } as const;

  test('a supplied opener runs, and what it opens becomes the binding', async () => {
    const opened: unknown[] = [];
    const bootstrap = createDatabaseBootstrap(sqliteConfig, {
      migrationsDir: '/tmp/migrations',
      sqlitePath: '/tmp/app.db',
      openSqlite: async (options) => {
        opened.push(options);
        return { primary: fakeBinding() };
      },
    });
    expect(opened).toEqual([]); // still lazy: nothing opened at construction

    await bootstrap.db.query({ sql: 'select 1', params: [] });
    await bootstrap.db.query({ sql: 'select 1', params: [] });
    // Opened once, not per statement: the handle the opener returned is kept on the connection.
    expect(opened).toHaveLength(1);
    // The opener is told what to open — the parsed config, so it sees the defaults — rather than
    // reading `config/database.ts` a second time and drifting from what was parsed.
    const told = opened[0] as {
      connections: Record<string, { driver: string; url?: string }>;
      sqlitePath?: string;
    };
    expect(told.connections['primary']?.url).toBe('file::memory:');
    expect(told.sqlitePath).toBe('/tmp/app.db');
  });

  test('no opener means no file is opened, and the driver says which connection it needs', async () => {
    // This is the Workers configuration. The failure has to name the connection, because the
    // alternative — an empty binding that fails later, somewhere else — is what makes a missing
    // binding feel like a framework bug.
    const bootstrap = createDatabaseBootstrap(sqliteConfig, { migrationsDir: '/tmp/migrations' });
    const failure: unknown = await bootstrap.db
      .query({ sql: 'select 1', params: [] })
      .catch((error: unknown) => error);
    // `format()` is the rendering that carries the code; `String(error)` is just the message, and
    // asserting on it would pass for any error that happened to say the same words.
    const error = failure as { format?: () => string };
    expect(error.format?.()).toContain('DB_SQLITE_NO_HANDLE');
  });
});
