/**
 * The `postgres` HTTP transport (`DB-028`).
 *
 * Every case here is a shape a real pooler returns, quoted from the three that publish one: Neon's
 * serverless driver, Supabase's `pg-meta`, and PgBouncer's HTTP front-ends. The failures that
 * matter are the quiet ones — a `rowCount` read as `rows.length`, a SQL error inside a 200, a
 * positional read against object rows — so each has a case.
 */
import { describe, expect, test } from 'bun:test';

import {
  createHttpPostgresDriver,
  HTTP_POSTGRES_CAPABILITIES,
  parsePostgresUrl,
} from './postgres-http.ts';

/** `url` is `string | URL | Request`; only the string case is ever what this file passes. */
function urlText(url: string | URL | Request): string {
  if (typeof url === 'string') return url;
  return url instanceof URL ? url.href : url.url;
}

/** `RequestInit.body` is a union; these tests only ever set a string. */
function bodyText(init: RequestInit | undefined): string {
  const body = init?.body;
  return typeof body === 'string' ? body : '';
}

function stubFetch(body: unknown, init: { status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = ((url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: urlText(url), init: options ?? {} });
    const status = init.status ?? 200;
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('postgres over HTTP', () => {
  test('a SELECT answers its rows', async () => {
    const { impl } = stubFetch({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });
    const db = createHttpPostgresDriver({ host: 'https://db.example', fetch: impl });
    const result = await db.query({ sql: 'select id from t', params: [] });
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.changes).toBe(2);
  });

  test('an UPDATE with no RETURNING reports the rows it changed, not the rows it returned', async () => {
    // The bug this pins: `changes` from `rows.length` makes a five-row update look like a no-op,
    // and callers that check `changes` then report "nothing to do".
    const { impl } = stubFetch({ rows: [], rowCount: 5 });
    const db = createHttpPostgresDriver({ host: 'https://db.example', fetch: impl });
    const result = await db.query({ sql: 'update t set x = 1', params: [] });
    expect(result.rows).toEqual([]);
    expect(result.changes).toBe(5);
  });

  test('a SQL error inside a 200 is thrown, not returned as zero rows', async () => {
    // A pooler reports a missing table this way. Swallowing it turns a schema bug into a 404.
    const { impl } = stubFetch({ error: 'relation "t" does not exist' });
    const db = createHttpPostgresDriver({ host: 'https://db.example', fetch: impl });
    let caught: unknown;
    try {
      await db.query({ sql: 'select * from t', params: [] });
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(String(caught)).toMatch(/relation "t" does not exist/u);
  });

  test('a non-2xx with a plain-text body names the status and what came back', async () => {
    const { impl } = stubFetch('upstream unavailable', { status: 503 });
    const db = createHttpPostgresDriver({ host: 'https://db.example', fetch: impl });
    let caught: unknown;
    try {
      await db.query({ sql: 'select 1', params: [] });
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(String(caught)).toMatch(/503/u);
    expect(String(caught)).toMatch(/upstream unavailable/u);
  });

  test('positional rows follow the select order the pooler names', async () => {
    // A query builder maps columns by index. Re-ordering objects by `Object.values` would use
    // insertion order, which is not the select order when two columns share a name.
    const { impl } = stubFetch({
      rows: [
        { b: 2, a: 1 },
        { b: 4, a: 3 },
      ],
      fields: [{ name: 'a' }, { name: 'b' }],
      rowCount: 2,
    });
    const db = createHttpPostgresDriver({ host: 'https://db.example', fetch: impl });
    const result = await db.query({ sql: 'select a, b from t', params: [], format: 'arrays' });
    expect(result.rows).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test('a pooler that names no columns cannot answer a positional read, and says so', async () => {
    const { impl } = stubFetch({ rows: [{ a: 1 }], rowCount: 1 });
    const db = createHttpPostgresDriver({ host: 'https://db.example', fetch: impl });
    let caught: unknown;
    try {
      await db.query({ sql: 'select a from t', params: [], format: 'arrays' });
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(String(caught)).toMatch(/did not name its columns/u);
  });

  test('the credentials and the statement are in the body, and the secret is not in the URL', async () => {
    const { impl, calls } = stubFetch({ rows: [], rowCount: 0 });
    const db = createHttpPostgresDriver({
      host: 'https://db.example/',
      user: 'app',
      password: 'hunter2',
      database: 'shop',
      fetch: impl,
    });
    await db.query({ sql: 'select 1', params: [] });
    expect(calls[0]?.url).toBe('https://db.example/sql');
    const body = JSON.parse(bodyText(calls[0]?.init)) as Record<string, unknown>;
    expect(body['query']).toBe('select 1');
    expect(body['database']).toBe('shop');
    expect(calls[0]?.url).not.toContain('hunter2');
  });

  test('batch sends every statement in one request and reads every answer', async () => {
    const { impl, calls } = stubFetch([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 2 },
    ]);
    const db = createHttpPostgresDriver({ host: 'https://db.example', fetch: impl });
    const results = await db.batch([
      { sql: 'insert into t values (1)', params: [] },
      { sql: 'insert into t values (2)', params: [] },
    ]);
    expect(results.map((result) => result.changes)).toEqual([1, 2]);
    expect(calls.length).toBe(1);
  });

  test('health reports a down pooler as data, not an exception', async () => {
    const { impl } = stubFetch('nope', { status: 500 });
    const db = createHttpPostgresDriver({ host: 'https://db.example', fetch: impl });
    const health = await db.health();
    expect(health.ok).toBe(false);
    expect(health.engine).toBe('postgres');
  });

  test('the capabilities say what HTTP cannot do', () => {
    // The load-bearing part: `declare()` refuses a component that needs a transaction at boot,
    // because this transport cannot provide one. A driver claiming otherwise fails at request time.
    expect(HTTP_POSTGRES_CAPABILITIES.interactiveTx).toBe(false);
    expect(HTTP_POSTGRES_CAPABILITIES.pinnedConnection).toBe(false);
    expect(HTTP_POSTGRES_CAPABILITIES.batch).toBe(true);
    expect(HTTP_POSTGRES_CAPABILITIES.placeholder).toBe('dollar');
  });
});

describe('parsePostgresUrl', () => {
  test('a Neon-style url becomes an https host with the credentials kept out of it', () => {
    const parsed = parsePostgresUrl(
      'postgresql://app:hunter2@ep-cool-1.eu-central-1.aws.neon.tech/shop?sslmode=require',
    );
    expect(parsed.host).toBe('https://ep-cool-1.eu-central-1.aws.neon.tech');
    expect(parsed.user).toBe('app');
    expect(parsed.password).toBe('hunter2');
    expect(parsed.database).toBe('shop');
    expect(parsed.host).not.toContain('hunter2');
  });

  test('percent-encoded credentials are decoded', () => {
    const parsed = parsePostgresUrl('postgres://a%40b:p%40ss@db.example/app');
    expect(parsed.user).toBe('a@b');
    expect(parsed.password).toBe('p@ss');
  });

  test('a non-postgres scheme is refused by name', () => {
    let caught: unknown;
    try {
      parsePostgresUrl('mysql://app:x@db.example/shop');
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(String(caught)).toMatch(/must start with postgres/u);
  });
});
