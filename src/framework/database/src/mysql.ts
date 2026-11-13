/**
 * The `mysql` engine (`CAP-009`, `DB-029`).
 *
 * MySQL was named in the capability map and absent from `DATABASE_ENGINES`, so a team arriving
 * with a MySQL database had to rewrite their schema, or leave. It is the third most used
 * production database behind Postgres and SQLite-family engines, and its absence was the largest
 * single hole in this package.
 *
 * ## Why HTTP, and why that is not a shortcut
 *
 * The two MySQL clients in use are `mysql2` (a TCP pool, like `postgres.js`) and the vendor HTTP
 * gateways. The TCP client cannot run in a Worker at all, and on Lambda it is the same connection
 * storm a pool per instance always is — the reason `POOL_CEILING` caps Postgres at one there.
 * Every hosted MySQL worth naming now front-ends it with an HTTP endpoint: **TiDB Cloud**
 * (`https://http.tidbcloud.com/api/v1beta/app/...`), **PlanetScale** (`https://.../psdb.cloud`,
 * HTTP driver), **Neon-style Dolt** (`https://www.dolthub.com/api/v1alpha1/...`). So fetch-only is
 * not a compromise here; it is the transport those services actually publish, and it needs no
 * dependency (ADR-0027).
 *
 * ## What this is honest about
 *
 * | Capability | Value | Why |
 * |---|---|---|
 * | `interactiveTx` | `false` | One HTTP request is one session. A `BEGIN` in request 1 and a `COMMIT` in request 2 are different connections. |
 * | `batch` | `true` | The gateway runs a list of statements in one request, which is one implicit transaction. |
 * | `pinnedConnection` | `false` | Nothing to pin. |
 * | `placeholder` | `'question'` | MySQL's own `?` form. |
 *
 * The `interactiveTx: false` declaration is load-bearing: `declare()` refuses at boot the component
 * that needs a real transaction rather than failing on the one request that opens one. A project
 * that needs MySQL transactions wants the `mysql-client` driver over a pool that holds a session.
 *
 * ## The response shape
 *
 * The gateway answers `{ columns, rows, affectedRows }`: columns as names, rows as arrays in
 * column order. That is the shape TiDB's and PlanetScale's HTTP endpoints both return, and it is
 * *positional* — unlike the Postgres JSON front-ends, which answer objects. Converting here rather
 * than asking the gateway for objects is deliberate: the gateway does not offer objects, so a
 * driver that assumed them would work against one vendor's mock and no real service.
 */

import type { DbCapabilities, DbDriver, DbHealth, DbResult, DbStatement } from './driver.ts';
import { providerRejected } from './errors.ts';

/** The body a MySQL HTTP gateway returns for one statement. */
export interface HttpMysqlResponse {
  /** Column names, in select order. */
  readonly columns?: readonly (string | { readonly name?: string })[];
  /** Rows as positional arrays, in `columns` order. */
  readonly rows?: readonly (readonly unknown[])[];
  /** Affected-row count for a write. `null` on some gateways for a read. */
  readonly affectedRows?: number | null;
  /** Present instead of a body on failure, on TiDB's endpoint. */
  readonly error?: string | { readonly message?: string };
}

export interface HttpMysqlOptions {
  /** The gateway's statement URL, complete — the three vendors differ enough that a path guess would be a bug. */
  readonly url: string;
  /** The database (schema) name. */
  readonly database?: string | undefined;
  /** A bearer token or API key, taken from `{ fromEnv }` and never from `tsir.js`. */
  readonly token?: string | undefined;
  /** Header the token is sent in. Default `authorization` with a `Bearer ` prefix; TiDB wants `authorization: Bearer`. */
  readonly authHeader?: string | undefined;
  /** Set false for a gateway that wants the raw token (PlanetScale's `Authorization: <token>`). */
  readonly bearerPrefix?: boolean | undefined;
  /** Per-statement cap. Default 10 s. */
  readonly timeoutMs?: number | undefined;
  /** Injected in tests, as everywhere else. */
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The capabilities this transport has, which are a fact about HTTP.
 *
 * Exported so the config registry can name them at boot, before any request exists.
 */
export const HTTP_MYSQL_CAPABILITIES: DbCapabilities = Object.freeze({
  interactiveTx: false,
  batch: true,
  placeholder: 'question',
  engine: 'mysql',
  pinnedConnection: false,
});

function columnNames(response: HttpMysqlResponse): readonly string[] {
  return (response.columns ?? []).map((column) =>
    typeof column === 'string' ? column : (column.name ?? ''),
  );
}

/** Rows as objects, keyed by the column names the gateway sent. */
function toObjects(response: HttpMysqlResponse): readonly Record<string, unknown>[] {
  const names = columnNames(response);
  return (response.rows ?? []).map((row) => {
    const record: Record<string, unknown> = {};
    names.forEach((name, index) => {
      record[name] = row[index];
    });
    return record;
  });
}

function toResult(response: HttpMysqlResponse): DbResult {
  const rows = (response.rows ?? []).length > 0 ? toObjects(response) : [];
  // A write answers `affectedRows` and no rows. Falling back to `rows.length` would report an
  // `UPDATE` of five rows as `changes: 0` — the same trap `postgres.ts` documents.
  const changes = response.affectedRows ?? rows.length;
  return { rows, changes };
}

function failureText(response: HttpMysqlResponse): string | undefined {
  if (response.error === undefined) return undefined;
  if (typeof response.error === 'string') return response.error;
  return response.error.message ?? 'the gateway reported an error';
}

/**
 * Build the driver.
 *
 * ```ts
 * // config/database.ts
 * export default {
 *   default: 'primary',
 *   connections: {
 *     primary: {
 *       driver: 'mysql',
 *       url: { fromEnv: 'MYSQL_HTTP_URL' },  // the gateway's statement endpoint
 *     },
 *   },
 * };
 * ```
 */
export function createHttpMysqlDriver(options: HttpMysqlOptions): DbDriver {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const bearer = options.bearerPrefix ?? true;

  function headers(): Record<string, string> {
    const base: Record<string, string> = { 'content-type': 'application/json' };
    if (options.token !== undefined) {
      base[options.authHeader ?? 'authorization'] = bearer
        ? `Bearer ${options.token}`
        : options.token;
    }
    return base;
  }

  function body(statement: DbStatement): string {
    return JSON.stringify({
      // TiDB and PlanetScale both read `query`; Dolt reads `q`. Sending `query` and letting a Dolt
      // user set `path`/`url` is honest — inventing a vendor switch we cannot test would be worse.
      query: statement.sql,
      params: statement.params,
      ...(options.database === undefined ? {} : { database: options.database }),
    });
  }

  async function post(payload: string, what: 'statement' | 'batch'): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(options.url, {
        method: 'POST',
        headers: headers(),
        body: payload,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw providerRejected('mysql', `${what} failed with ${String(response.status)}: ${text}`);
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async function send(statement: DbStatement): Promise<DbResult> {
    const text = await post(body(statement), 'statement');
    let response: HttpMysqlResponse;
    try {
      response = JSON.parse(text) as HttpMysqlResponse;
    } catch {
      throw providerRejected('mysql', `the gateway answered something that is not JSON: ${text}`);
    }
    const failure = failureText(response);
    // A gateway reports a SQL error as a 200 with `error` — the same convention the Postgres
    // front-ends use, and the same reason it must be read: an empty result would make a missing
    // table look like "no rows".
    if (failure !== undefined) throw providerRejected('mysql', failure);
    return toResult(response);
  }

  return {
    capabilities: HTTP_MYSQL_CAPABILITIES,

    query(statement: DbStatement): Promise<DbResult> {
      return send(statement);
    },

    async batch(statements: readonly DbStatement[]): Promise<readonly DbResult[]> {
      if (statements.length === 0) {
        throw providerRejected('mysql', 'batch called with no statements');
      }
      const text = await post(
        JSON.stringify({
          queries: statements.map((statement) => ({
            query: statement.sql,
            params: statement.params,
          })),
          ...(options.database === undefined ? {} : { database: options.database }),
        }),
        'batch',
      );
      // `JSON.parse` is `any`; naming it `unknown` first keeps the shape from becoming an
      // unchecked assertion.
      const parsed: unknown = JSON.parse(text) as unknown;
      const results: readonly HttpMysqlResponse[] | undefined = Array.isArray(parsed)
        ? (parsed as readonly HttpMysqlResponse[])
        : (parsed as { readonly results?: readonly HttpMysqlResponse[] }).results;
      if (results === undefined) {
        throw providerRejected(
          'mysql',
          'the gateway answered a batch with no per-statement results',
        );
      }
      return results.map((entry) => {
        const failure = failureText(entry);
        if (failure !== undefined) throw providerRejected('mysql', failure);
        return toResult(entry);
      });
    },

    async health(): Promise<DbHealth> {
      const started = now();
      try {
        await send({ sql: 'SELECT 1', params: [] });
        return { ok: true, engine: 'mysql', latencyMs: now() - started, detail: {} };
      } catch {
        return { ok: false, engine: 'mysql', latencyMs: now() - started, detail: {} };
      }
    },

    close(): Promise<void> {
      // HTTP has no connection to leak.
      return Promise.resolve();
    },
  };
}
