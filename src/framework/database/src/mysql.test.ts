/**
 * The `mysql` HTTP transport (`DB-029`).
 *
 * The gateways this speaks to — TiDB Cloud, PlanetScale, Dolt — answer **positional rows with a
 * separate `columns` list**, unlike the Postgres front-ends which answer objects. That difference
 * is the whole driver, so it is what these tests pin: a driver that assumed objects would work
 * against a mock and fail against every real service.
 */
import { describe, expect, test } from 'bun:test';

import { createHttpMysqlDriver, HTTP_MYSQL_CAPABILITIES } from './mysql.ts';

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
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: init.status ?? 200,
      }),
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ENDPOINT = 'https://http.tidbcloud.com/api/v1beta/app/x/endpoint/sql';

describe('mysql over HTTP', () => {
  test('positional rows and a separate column list become named rows', async () => {
    // TiDB's own shape: `columns: ['id','name']`, `rows: [[1,'red bicycle']]`.
    const { impl } = stubFetch({ columns: ['id', 'name'], rows: [[1, 'red bicycle']] });
    const db = createHttpMysqlDriver({ url: ENDPOINT, fetch: impl });
    const result = await db.query({ sql: 'select id, name from products', params: [] });
    expect(result.rows).toEqual([{ id: 1, name: 'red bicycle' }]);
    expect(result.changes).toBe(1);
  });

  test('columns sent as objects are named from their `name`', async () => {
    // PlanetScale names them `{ name, type }`. Same row shape, one more field to read.
    const { impl } = stubFetch({
      columns: [
        { name: 'id', type: 'BIGINT' },
        { name: 'title', type: 'VARCHAR' },
      ],
      rows: [[7, 'a']],
    });
    const db = createHttpMysqlDriver({ url: ENDPOINT, fetch: impl });
    const result = await db.query({ sql: 'select id, title from t', params: [] });
    expect(result.rows).toEqual([{ id: 7, title: 'a' }]);
  });

  test('an UPDATE reports affectedRows, not the empty result set', async () => {
    const { impl } = stubFetch({ columns: [], rows: [], affectedRows: 12 });
    const db = createHttpMysqlDriver({ url: ENDPOINT, fetch: impl });
    const result = await db.query({ sql: 'update t set x = 1', params: [] });
    expect(result.changes).toBe(12);
  });

  test('a failed statement inside a 200 is thrown', async () => {
    const { impl } = stubFetch({ error: { message: "Table 't' doesn't exist" } });
    const db = createHttpMysqlDriver({ url: ENDPOINT, fetch: impl });
    let caught: unknown;
    try {
      await db.query({ sql: 'select * from t', params: [] });
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(String(caught)).toMatch(/Table 't' doesn't exist/u);
  });

  test('a string error is thrown as written', async () => {
    const { impl } = stubFetch({ error: 'syntax error near FROM' });
    const db = createHttpMysqlDriver({ url: ENDPOINT, fetch: impl });
    let caught: unknown;
    try {
      await db.query({ sql: 'select from', params: [] });
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(String(caught)).toMatch(/syntax error near FROM/u);
  });

  test('the token is a bearer by default, and a raw header when the vendor wants that', async () => {
    // PlanetScale takes `Authorization: <token>`; TiDB takes `Authorization: Bearer <token>`.
    // The prefix is a setting because both are real, and guessing would authenticate as nothing.
    const bearer = stubFetch({ rows: [], affectedRows: 0 });
    await createHttpMysqlDriver({ url: ENDPOINT, token: 'abc', fetch: bearer.impl }).query({
      sql: 'select 1',
      params: [],
    });
    const bearerHeaders = bearer.calls[0]?.init.headers as Record<string, string>;
    expect(bearerHeaders['authorization']).toBe('Bearer abc');

    const raw = stubFetch({ rows: [], affectedRows: 0 });
    await createHttpMysqlDriver({
      url: ENDPOINT,
      token: 'abc',
      bearerPrefix: false,
      fetch: raw.impl,
    }).query({ sql: 'select 1', params: [] });
    const rawHeaders = raw.calls[0]?.init.headers as Record<string, string>;
    expect(rawHeaders['authorization']).toBe('abc');
  });

  test('no token sends no authorization header at all', async () => {
    // A gateway that does not need one must not receive `Bearer undefined`.
    const { impl, calls } = stubFetch({ rows: [], affectedRows: 0 });
    await createHttpMysqlDriver({ url: ENDPOINT, fetch: impl }).query({
      sql: 'select 1',
      params: [],
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBeUndefined();
  });

  test('the schema name travels with the statement', async () => {
    const { impl, calls } = stubFetch({ rows: [], affectedRows: 0 });
    await createHttpMysqlDriver({ url: ENDPOINT, database: 'shop', fetch: impl }).query({
      sql: 'select 1',
      params: [],
    });
    const body = JSON.parse(bodyText(calls[0]?.init)) as Record<string, unknown>;
    expect(body['database']).toBe('shop');
  });

  test('batch reads every per-statement result and fails on the first error', async () => {
    const ok = stubFetch([
      { rows: [], affectedRows: 1 },
      { rows: [], affectedRows: 2 },
    ]);
    const results = await createHttpMysqlDriver({ url: ENDPOINT, fetch: ok.impl }).batch([
      { sql: 'insert into t values (1)', params: [] },
      { sql: 'insert into t values (2)', params: [] },
    ]);
    expect(results.map((result) => result.changes)).toEqual([1, 2]);

    const bad = stubFetch([{ rows: [], affectedRows: 1 }, { error: 'duplicate key' }]);
    let caught: unknown;
    try {
      await createHttpMysqlDriver({ url: ENDPOINT, fetch: bad.impl }).batch([
        { sql: 'insert into t values (1)', params: [] },
        { sql: 'insert into t values (1)', params: [] },
      ]);
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(String(caught)).toMatch(/duplicate key/u);
  });

  test('health reports a down gateway as data', async () => {
    const { impl } = stubFetch('bad gateway', { status: 502 });
    const health = await createHttpMysqlDriver({ url: ENDPOINT, fetch: impl }).health();
    expect(health.ok).toBe(false);
    expect(health.engine).toBe('mysql');
  });

  test('the capabilities say what HTTP cannot do', () => {
    expect(HTTP_MYSQL_CAPABILITIES.interactiveTx).toBe(false);
    expect(HTTP_MYSQL_CAPABILITIES.engine).toBe('mysql');
    // MySQL's own placeholder form — the reason `database.ts` widths exist at all.
    expect(HTTP_MYSQL_CAPABILITIES.placeholder).toBe('question');
  });
});
