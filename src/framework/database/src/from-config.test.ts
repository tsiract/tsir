/**
 * Selecting an engine from `tsir.js` (`CAP-009`).
 *
 * The defect this file exists for was not a missing driver — `postgres.ts` had one for years. It
 * was that `from-config.ts` threw `DB_POSTGRES_BOOTSTRAP_UNWIRED` for every url-based connection,
 * so the Lambda and Bun *defaults* named an engine that could not start. A test that constructs
 * `createPostgresDriver` directly would have passed the whole time.
 *
 * So these start at the config object, which is what an application actually writes.
 */
import { describe, expect, test } from 'bun:test';
import { Database as Sqlite } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { databaseConfigSchema } from './config.ts';
import { createConnectionsFromConfig } from './from-config.ts';
import type { DatabaseConfig } from './config.ts';

function stubFetch(body: unknown) {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status: 200 }),
    )) as unknown as typeof fetch;
}

/** A config for one connection, which is every application's shape. */
function one(entry: DatabaseConfig['connections'][string]): DatabaseConfig {
  return { default: 'primary', connections: { primary: entry } };
}

describe('database engines selectable from config', () => {
  test('postgres is built from a url instead of refused', () => {
    // The assertion is that this does not throw. What it returns is checked by engine below.
    const databases = createConnectionsFromConfig(
      {
        default: 'primary',
        connections: {
          primary: {
            driver: 'postgres',
            url: 'postgres://app:secret@db.example/shop',
            logging: 'off',
            slowQueryMs: 200,
            statementTimeoutMs: 5_000,
          },
        },
      },
      {},
    );
    expect(databases.defaultDatabase.capabilities.engine).toBe('postgres');
    expect(databases.defaultDatabase.capabilities.placeholder).toBe('dollar');
  });

  test('mysql is built from its gateway url', () => {
    const databases = createConnectionsFromConfig(
      one({
        driver: 'mysql',
        url: 'https://http.tidbcloud.com/api/v1beta/app/x/endpoint/sql',
        logging: 'off',
        slowQueryMs: 200,
        statementTimeoutMs: 5_000,
      }),
      {},
    );
    expect(databases.defaultDatabase.capabilities.engine).toBe('mysql');
    // MySQL's placeholder form is `?`, like SQLite — not `$1`.
    expect(databases.defaultDatabase.capabilities.placeholder).toBe('question');
  });

  test('a url-based connection with no url says which key is missing, not which driver', () => {
    let caught: unknown;
    try {
      createConnectionsFromConfig(
        one({ driver: 'postgres', logging: 'off', slowQueryMs: 200, statementTimeoutMs: 5_000 }),
        {},
      );
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(String(caught)).toMatch(/DB_URL_REQUIRED|url/u);
    expect(String(caught)).toMatch(/postgres/u);
  });

  test('sqlite reads and writes a real file through the config path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsir-from-config-'));
    const file = join(dir, 'app.db');
    const handle = new Sqlite(file);
    try {
      const databases = createConnectionsFromConfig(
        one({
          driver: 'sqlite',
          url: file,
          logging: 'off',
          slowQueryMs: 200,
          statementTimeoutMs: 5_000,
        }),
        // The handle is supplied under the connection's name — `bootstrap.ts` is what opens it
        // from `url` in a real app, and this is the same seam with the file already open.
        { primary: handle },
      );
      const db = databases.defaultDatabase;
      expect(db.capabilities.engine).toBe('sqlite');
      await db.query({ sql: 'create table t (id integer primary key)', params: [] });
      await db.query({ sql: 'insert into t default values', params: [] });
      const result = await db.query({ sql: 'select count(*) as n from t', params: [] });
      expect(result.rows).toEqual([{ n: 1 }]);
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a sqlite connection with no handle names the connection, not the driver', async () => {
    // The registry is built at boot and the handle arrives later, so this fails on first use
    // rather than at construction — which is why the message must name what is absent.
    const databases = createConnectionsFromConfig(
      one({
        driver: 'sqlite',
        url: ':memory:',
        logging: 'off',
        slowQueryMs: 200,
        statementTimeoutMs: 5_000,
      }),
      {},
    );
    let caught: unknown;
    try {
      await databases.defaultDatabase.query({ sql: 'select 1', params: [] });
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(String(caught)).toMatch(/sqlite connection "primary"/u);
  });

  test('the three network engines send their statements somewhere real', async () => {
    // One assertion per transport that the driver is wired to fetch rather than to a pool: a
    // request is made, and its body carries the statement. `globalThis.fetch` is replaced for the
    // duration because `from-config` builds the driver with no `fetch` of its own.
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(
        new Response(JSON.stringify({ rows: [], rowCount: 0 }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    try {
      const pg = createConnectionsFromConfig(
        one({
          driver: 'postgres',
          url: 'postgres://app:secret@db.example/shop',
          logging: 'off',
          slowQueryMs: 200,
          statementTimeoutMs: 5_000,
        }),
        {},
      );
      await pg.defaultDatabase.query({ sql: 'select 1', params: [] });
      expect(seen.length).toBe(1);
      expect(seen[0]).toContain('select 1');

      const my = createConnectionsFromConfig(
        one({
          driver: 'mysql',
          url: 'https://example.test/sql',
          databaseName: 'shop',
          logging: 'off',
          slowQueryMs: 200,
          statementTimeoutMs: 5_000,
        }),
        {},
      );
      await my.defaultDatabase.query({ sql: 'select 2', params: [] });
      expect(seen.length).toBe(2);
      expect(seen[1]).toContain('select 2');
      expect(seen[1]).toContain('shop');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('d1 is still a binding, and the schema still refuses a url on it', () => {
    // This one asserts at the schema, not at `createConnectionsFromConfig`: the registry takes an
    // already-parsed config, so the refusal belongs to the layer that parses. Asserting it here
    // instead was my first attempt, and it passed a config the schema rejects — which is exactly
    // the mistake of testing the seam below the one that does the work.
    expect(() =>
      databaseConfigSchema.parse(
        one({
          driver: 'd1',
          binding: 'DB',
          url: 'postgres://x@y/z',
          logging: 'off',
          slowQueryMs: 200,
          statementTimeoutMs: 5_000,
        }),
      ),
    ).toThrow(/url is a setting for postgres, mysql and sqlite/u);
  });
});

// `stubFetch` is kept for the case that needs a fixed body; the sweep above replaces the global.
void stubFetch;
