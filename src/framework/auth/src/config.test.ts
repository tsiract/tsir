/**
 * `CAP-018` — the `sessions.store` and `apiKeys.store` registries.
 *
 * The bug these close is not that a store was missing; both stores were implemented and tested. It
 * is that nothing tied the choice to a deployment: `memorySessionStore` was a legal thing for an
 * app to construct, and the failure it produces — a user logged out at random when their next
 * request lands on another instance — has no error in it to grep for.
 */
import { describe, expect, test } from 'bun:test';

import { TsirError } from '@tsir/container';

import {
  apiKeyStoreFromConfig,
  sessionStoreFromConfig,
  API_KEY_DRIVERS,
  PERSISTENT_AUTH_DRIVERS,
  SESSION_DRIVERS,
} from './config.ts';
import type { SessionSql } from './drivers/session-database.ts';

/** The `hint` carries the actionable part of these errors; `String(error)` cannot see it. */
function rendered(error: unknown): string {
  return error instanceof TsirError ? error.format() : String(error);
}

/** A SQL double with no rows — enough to construct the stores. */
const sql: SessionSql = {
  capabilities: { engine: 'sqlite', placeholder: 'question' },
  query: async () => ({ rows: [], changes: 0 }),
};

describe('session and API-key stores from config (CAP-018)', () => {
  test('no store configured means no store, rather than a memory one', () => {
    // An app that never configured sessions should not get a store that works in dev and logs
    // everyone out in production.
    expect(sessionStoreFromConfig({ store: undefined })).toBeUndefined();
    expect(apiKeyStoreFromConfig({ store: undefined })).toBeUndefined();
  });

  test('the database store is built over the app connection', () => {
    const store = sessionStoreFromConfig({ store: { driver: 'database' }, sql });
    expect(store).toBeDefined();
    expect(typeof store?.get).toBe('function');
  });

  test('a database store with no SQL connection refuses at construction', () => {
    // Without it every session read would answer "no session" — everyone logged out, silently.
    const error = (() => {
      try {
        sessionStoreFromConfig({ store: { driver: 'database' } });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as TsirError).code).toBe('AUTH_CONFIG_INVALID');
    expect(rendered(error)).toContain('connection');
  });

  test('memory sessions are refused in production', () => {
    const error = (() => {
      try {
        sessionStoreFromConfig({ store: { driver: 'memory' }, production: true });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as TsirError).code).toBe('AUTH_FORBIDDEN_IN_PRODUCTION');
    // The hint says what to do instead, not only what was wrong.
    expect(rendered(error)).toContain('database');
  });

  test('memory API keys are refused in production, for the same reason', () => {
    const error = (() => {
      try {
        apiKeyStoreFromConfig({ store: { driver: 'memory' }, production: true });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as TsirError).code).toBe('AUTH_FORBIDDEN_IN_PRODUCTION');
  });

  test('memory is allowed outside production', () => {
    // `tsir dev` and every test want a store with no migration. Refusing it there is how a guard
    // grows an escape hatch.
    expect(
      sessionStoreFromConfig({ store: { driver: 'memory' }, production: false }),
    ).toBeDefined();
    expect(apiKeyStoreFromConfig({ store: { driver: 'memory' }, production: false })).toBeDefined();
  });

  test('the two concerns are configured separately', () => {
    // An app may keep sessions in Redis and keys in Postgres; sharing one block would have made
    // that impossible to express.
    expect(
      sessionStoreFromConfig({ store: { driver: 'database' }, sql, production: true }),
    ).toBeDefined();
    expect(apiKeyStoreFromConfig({ store: { driver: 'memory' }, production: false })).toBeDefined();
  });

  test('an unknown driver lists the ones this build ships', () => {
    const error = (() => {
      try {
        sessionStoreFromConfig({ store: { driver: 'redis' }, sql });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as TsirError).code).toBe('AUTH_DRIVER_MISSING');
    const text = rendered(error);
    for (const driver of SESSION_DRIVERS) expect(text).toContain(driver);
  });

  test('the shipped store lists and the persistent list agree', () => {
    // A driver added to one list and not the other means either a store nobody can select, or a
    // store that slips past the production guard.
    expect(SESSION_DRIVERS).toEqual(API_KEY_DRIVERS);
    expect(SESSION_DRIVERS).toContain('database');
    expect(PERSISTENT_AUTH_DRIVERS).toEqual(['database']);
    for (const driver of PERSISTENT_AUTH_DRIVERS) {
      expect(SESSION_DRIVERS as readonly string[]).toContain(driver);
    }
  });

  test('every declared engine builds a working store', () => {
    // The stores branch on `placeholder`, not on the engine name, so all four have to construct —
    // `CAP-016` is the promise this is checking.
    for (const engine of ['d1', 'sqlite', 'postgres', 'mysql'] as const) {
      const port: SessionSql = {
        capabilities: { engine, placeholder: engine === 'postgres' ? 'dollar' : 'question' },
        query: async () => ({ rows: [], changes: 0 }),
      };
      expect(sessionStoreFromConfig({ store: { driver: 'database' }, sql: port })).toBeDefined();
      expect(apiKeyStoreFromConfig({ store: { driver: 'database' }, sql: port })).toBeDefined();
    }
  });
});
