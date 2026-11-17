import { describe, expect, test } from 'bun:test';

/**
 * `db` is Drizzle, `dbFor(name)` is another connection (`DX-001` / `DX-002`), per ADR-0032 § 1.
 *
 * One property here can only be checked by the compiler, so the compiler checks it: the
 * `@ts-expect-error` below is the assertion. If `dbFor` ever widened to `(name: string)`, the
 * directive becomes unused, and `tsc` fails the build with `TS2578`. A runtime test claiming "the
 * type is wrong" would pass regardless of what the type was.
 *
 * The runtime half is the part types do not catch: **identity**. Two Drizzle instances over one
 * driver are two sets of column identities, so a join across them emits duplicate table aliases
 * (`INF-010`) — a wrong query rather than a slow one.
 */

import { createDatabaseBootstrap } from './bootstrap.ts';

const TWO_CONNECTIONS = {
  default: 'primary',
  connections: {
    primary: { driver: 'sqlite', url: 'file::memory:' },
    analytics: { driver: 'sqlite', url: 'file::memory:' },
  },
} as const;

const OPTIONS = { migrationsDir: '/tmp/migrations' };

describe('DX-001 · `db` is the default connection, bound to Drizzle', () => {
  test('`db` is Drizzle itself — no wrapper, and `drizzle` is the same object', () => {
    const bootstrap = createDatabaseBootstrap(TWO_CONNECTIONS, OPTIONS);
    // Identity, not shape: a wrapper forwarding every method would pass a shape check and still
    // break every Drizzle extension.
    expect(bootstrap.db).toBe(bootstrap.drizzle);
    expect(typeof bootstrap.db.select).toBe('function');
  });

  test('`dbFor` is checked against the declared names at compile time', () => {
    const bootstrap = createDatabaseBootstrap<'primary' | 'analytics'>(TWO_CONNECTIONS, OPTIONS);
    expect(typeof bootstrap.dbFor('analytics').select).toBe('function');
    // @ts-expect-error — `nope` is not a declared connection. Delete this line and the runtime
    // assertions still pass; the rejection is the compiler's job.
    expect(() => bootstrap.dbFor('nope')).toThrow();
  });

  test('the instance is memoised per connection', () => {
    const bootstrap = createDatabaseBootstrap(TWO_CONNECTIONS, OPTIONS);
    expect(bootstrap.dbFor('analytics')).toBe(bootstrap.dbFor('analytics'));
    expect(bootstrap.dbFor('primary')).toBe(bootstrap.db);
  });

  test('an unknown name at runtime names the declared connections', () => {
    const bootstrap = createDatabaseBootstrap(TWO_CONNECTIONS, OPTIONS);
    // The compile-time guarantee covers a project that types its bootstrap; a name that arrives as
    // `string` — from config, a request — still has to fail informatively.
    const failure = (() => {
      try {
        bootstrap.dbFor('nope');
        return undefined;
      } catch (error: unknown) {
        return error as { code?: string; message?: string };
      }
    })();
    expect(failure?.code).toBe('DB_UNKNOWN_CONNECTION');
    // The message lists what *is* declared, which is the difference between an error and a clue.
    expect(failure?.message).toContain('primary, analytics');
  });

  test('the raw connection is still reachable, under its own name', () => {
    const bootstrap = createDatabaseBootstrap(TWO_CONNECTIONS, OPTIONS);
    // ADR-0032 moved the raw handle rather than removing it: the admin app's auth module issues
    // statements through it, and a health check that used Drizzle would need a table that does not
    // exist just to ask `select 1`.
    expect(bootstrap.connection.name).toBe('primary');
    expect(bootstrap.connectionFor('analytics').name).toBe('analytics');
  });
});

describe('DX-002 · one Drizzle per declared connection, built on first use', () => {
  test('two connections yield two distinct instances', () => {
    const bootstrap = createDatabaseBootstrap(TWO_CONNECTIONS, OPTIONS);
    expect(bootstrap.dbFor('analytics')).not.toBe(bootstrap.dbFor('primary'));
  });

  test('the registry is eager, the Drizzle layer is not', () => {
    const bootstrap = createDatabaseBootstrap(TWO_CONNECTIONS, OPTIONS);
    // The registry builds every connection at boot, because a broken URL must fail before the
    // process serves anything. Drizzle is built on first `dbFor` — memoisation is what proves the
    // build happened once, and the absence of a throw here is what proves `dbFor` did not need the
    // connection to have been used first.
    expect([...bootstrap.databases.names]).toEqual(['primary', 'analytics']);
    const analytics = bootstrap.dbFor('analytics');
    expect(bootstrap.dbFor('analytics')).toBe(analytics);
  });

  test('a query before the binding arrives fails with the deferred-driver hint', async () => {
    // `sqlite` with a file path defers opening the handle. With no opener supplied, the driver has
    // nothing to talk to, and the error must name that rather than `undefined is not an object`.
    const bootstrap = createDatabaseBootstrap(
      {
        default: 'primary',
        connections: { primary: { driver: 'sqlite', url: '/tmp/nothing.db' } },
      },
      OPTIONS,
    );
    const failure = await bootstrap.connection
      .query({ sql: 'select 1', params: [] })
      .then(() => undefined)
      .catch((error: unknown) => error as { code?: string; message?: string });
    expect(failure?.code).toBe('DB_SQLITE_NO_HANDLE');
  });
});
