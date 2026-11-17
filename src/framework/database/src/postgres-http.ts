/**
 * Postgres over HTTP (`CAP-009`, `DB-028`).
 *
 * The `postgres` engine has existed for three years and could not be selected from `tsir.js`: the
 * driver took a `postgres.js`-shaped client, and `from-config.ts` therefore had no way to build one
 * — it threw `driverUnavailable` instead. So the Lambda and Bun *defaults* named an engine that
 * could not start. That is the same defect as `memory` in a cheaper costume: a default that is not
 * a working service.
 *
 * This driver closes it without adding a dependency and without a socket. `postgres.js` holds a
 * TCP connection pool, which a Worker does not have; D1 and Hyperdrive are how Cloudflare answers
 * that, and on Lambda a pool per instance is the connection storm `POOL_CEILING` already caps at
 * one. Every one of those is a reason to use a pooler — Neon, Supabase, RDS Proxy, PgBouncer — and
 * every pooler worth the name speaks the **PostgreSQL wire protocol over HTTP**, which is what this
 * file speaks. It is one `POST` per statement.
 *
 * ## What this is honest about
 *
 * | Capability | Value | Why |
 * |---|---|---|
 * | `interactiveTx` | `false` | HTTP has no session. A `BEGIN` in one request and a `COMMIT` in the next are two different backends. |
 * | `batch` | `true` | A single request carries the statements, so they are one implicit transaction — which is exactly what `batch()` promises. |
 * | `pinnedConnection` | `false` | Same reason as `interactiveTx`: there is no connection to pin. |
 * | `placeholder` | `'dollar'` | It is Postgres; `$1` is the protocol's own form. |
 *
 * Declaring `interactiveTx: false` is not a limitation accepted quietly — it is what makes
 * `declare()` refuse at boot the component that needs a real transaction, instead of failing on
 * the one request that happens to open one. An application that needs `interactiveTx` on Lambda
 * should point the `postgres-client` driver at RDS Proxy, where a pool holds the session.
 *
 * ## The endpoint
 *
 * `host` is the pooler's base URL; statements go to `<host>/sql`. A project that needs a different
 * path sets `path`. Nothing about the *response* is configurable: the shape is the one Neon's
 * serverless driver, Supabase's `pg-meta` and PgBouncer's HTTP front-ends all return — `rows` as
 * an array of objects, `rowCount`, and `fields` naming the columns. Reading three vendors' shapes
 * through a per-vendor adapter would be the honest thing to do if they disagreed; they do not, and
 * `postgres-http.test.ts` pins the one shape this file reads.
 */

import type { DbCapabilities, DbDriver, DbHealth, DbResult, DbStatement } from './driver.ts';
import { providerRejected } from './errors.ts';

/** The response body every HTTP Postgres front-end returns for one statement. */
export interface HttpPostgresResponse {
  readonly rows?: readonly Record<string, unknown>[];
  readonly rowCount?: number;
  readonly fields?: readonly { readonly name: string }[];
  /** Present on a failed statement rather than a non-2xx status, on some front-ends. */
  readonly error?: string;
}

export interface HttpPostgresOptions {
  /** The pooler's base URL, e.g. `https://ep-x.eu-central-1.aws.neon.tech`. */
  readonly host: string;
  /** Where statements are posted. Default `/sql`. */
  readonly path?: string | undefined;
  /** The database user. Sent in the body, not as a query parameter — it is not a secret. */
  readonly user?: string | undefined;
  /** The password. A secret, so it reaches this function from `{ fromEnv }` and nothing else. */
  readonly password?: string | undefined;
  /** The database name. */
  readonly database?: string | undefined;
  /** Added to `search_path` via the statement itself, not a connection parameter. */
  readonly searchPath?: string | undefined;
  /** Per-statement cap. Default 10 s — a pooler that has not answered by then is not going to. */
  readonly timeoutMs?: number | undefined;
  /** Injected so the driver is testable without a pooler, exactly as `s3` and `resend` are. */
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * A pooler answers `rows` for a read and `rowCount` for a write, and the two are not the same
 * thing: an `UPDATE` with no `RETURNING` has zero rows and a non-zero count. Reading `changes`
 * from `rows.length` would report a five-row update as `changes: 0`, which is the bug
 * `toResult` in `postgres.ts` already documents for `postgres.js`.
 */
function toResult(body: HttpPostgresResponse): DbResult {
  const rows = body.rows ?? [];
  const changes = body.rowCount ?? rows.length;
  return { rows, changes };
}

/**
 * The capabilities this transport has, which are a fact about HTTP rather than about the pooler.
 *
 * Exported so `from-config.ts` can name the driver's capabilities *before* a request exists — the
 * registry reads them at boot, and `declare()` refuses an unsatisfiable requirement there.
 */
export const HTTP_POSTGRES_CAPABILITIES: DbCapabilities = Object.freeze({
  interactiveTx: false,
  batch: true,
  placeholder: 'dollar',
  engine: 'postgres',
  pinnedConnection: false,
});

/**
 * Build the driver.
 *
 * ```ts
 * // config/database.ts
 * export default {
 *   default: 'primary',
 *   connections: {
 *     primary: {
 *       driver: 'postgres',
 *       url: { fromEnv: 'DATABASE_URL' },  // host + credentials, parsed by `from-config`
 *     },
 *   },
 * };
 * ```
 */
export function createHttpPostgresDriver(options: HttpPostgresOptions): DbDriver {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const endpoint = `${options.host.replace(/\/+$/u, '')}${options.path ?? '/sql'}`;

  async function send(statement: DbStatement): Promise<DbResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: statement.sql,
          params: statement.params,
          ...(options.user === undefined ? {} : { user: options.user }),
          ...(options.password === undefined ? {} : { password: options.password }),
          ...(options.database === undefined ? {} : { database: options.database }),
          ...(options.searchPath === undefined ? {} : { searchPath: options.searchPath }),
          // The rows come back by column name. `format: 'arrays'` is what a query builder wants,
          // and the front-end is asked for it rather than having the objects re-ordered here — a
          // re-order guesses when two columns share a name, which is the whole reason the format
          // exists (`driver.ts`).
          format: statement.format === 'arrays' ? 'arrays' : 'objects',
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // A pooler reports a SQL error as a non-2xx *or* as a 200 with `error`, depending on the
    // vendor, so both are read. Returning an empty result on either would turn a broken statement
    // into "no rows", which is how a missing table becomes a quiet 404.
    const text = await response.text();
    let body: HttpPostgresResponse = {};
    if (text !== '') {
      try {
        body = JSON.parse(text) as HttpPostgresResponse;
      } catch {
        if (!response.ok) {
          throw providerRejected(
            'postgres',
            `postgres: ${String(response.status)} from ${endpoint}: ${text}`,
          );
        }
        throw providerRejected(
          'postgres',
          `postgres: ${endpoint} answered something that is not JSON: ${text}`,
        );
      }
    }
    if (!response.ok || body.error !== undefined) {
      throw providerRejected(
        'postgres',
        body.error ?? `${String(response.status)} from ${endpoint}`,
      );
    }

    const result = toResult(body);
    if (statement.format === 'arrays') {
      // Positional order is the order of `fields`, which is the select order. The front-end that
      // echoes neither cannot answer this request, and saying so beats returning objects a
      // builder will read as arrays.
      const fields = body.fields;
      if (fields === undefined) {
        throw providerRejected(
          'postgres',
          'the pooler did not name its columns, so positional rows cannot be answered',
        );
      }
      return {
        rows: (body.rows ?? []).map((row) => fields.map((field) => row[field.name])),
        changes: result.changes,
      };
    }
    return result;
  }

  return {
    capabilities: HTTP_POSTGRES_CAPABILITIES,

    query(statement: DbStatement): Promise<DbResult> {
      return send(statement);
    },

    /**
     * One request carrying every statement. The front-end runs them as one implicit
     * transaction — its own documented behaviour, and what `batch` promises — so this is not
     * `interactiveTx` smuggled in under another name.
     */
    async batch(statements: readonly DbStatement[]): Promise<readonly DbResult[]> {
      if (statements.length === 0) {
        // `DB_BATCH_EMPTY` is the caller's error, and `createDatabase` raises it before reaching a
        // driver. Repeating it here would give the same mistake two messages.
        throw providerRejected('postgres', 'batch called with no statements');
      }
      const body = await sendBatch(statements);
      return body;
    },

    async health(): Promise<DbHealth> {
      const started = now();
      try {
        await send({ sql: 'SELECT 1', params: [] });
        return {
          ok: true,
          engine: 'postgres',
          latencyMs: now() - started,
          detail: {},
        };
      } catch {
        // Never throws: a down pooler is data, not an exception (`Database.health`).
        return { ok: false, engine: 'postgres', latencyMs: now() - started, detail: {} };
      }
    },

    close(): Promise<void> {
      // Nothing to close. HTTP has no connection to leak, which is the one thing this transport
      // is better at than the pool.
      return Promise.resolve();
    },
  };

  /**
   * The batch request. A separate `send` because the body is a list and the response is a list of
   * results, while `send` answers one.
   */
  async function sendBatch(statements: readonly DbStatement[]): Promise<readonly DbResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          queries: statements.map((statement) => ({
            query: statement.sql,
            params: statement.params,
            format: statement.format === 'arrays' ? 'arrays' : 'objects',
          })),
          ...(options.user === undefined ? {} : { user: options.user }),
          ...(options.password === undefined ? {} : { password: options.password }),
          ...(options.database === undefined ? {} : { database: options.database }),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      throw providerRejected(
        'postgres',
        `batch failed with ${String(response.status)} from ${endpoint}: ${text}`,
      );
    }
    // A batch answer is a list of the same per-statement shape.
    // `JSON.parse` is `any`; naming it `unknown` first is what keeps a vendor's response shape
    // from silently becoming a type assertion over fields nobody checked.
    const parsed: unknown = JSON.parse(text) as unknown;
    const results: readonly HttpPostgresResponse[] | undefined = Array.isArray(parsed)
      ? (parsed as readonly HttpPostgresResponse[])
      : (parsed as { readonly results?: readonly HttpPostgresResponse[] }).results;
    if (results === undefined) {
      throw providerRejected(
        'postgres',
        'the pooler answered a batch with no per-statement results',
      );
    }
    return results.map((entry) => {
      if (entry.error !== undefined) throw providerRejected('postgres', `${entry.error}`);
      return toResult(entry);
    });
  }
}

/**
 * Parse a `postgres://` URL into the parts this driver sends.
 *
 * A connection string is how every Postgres provider hands out credentials — Neon, Supabase, RDS,
 * Render, Railway — so accepting one is what makes `url:` in `tsir.js` mean the same thing it
 * means everywhere else. The password stays out of the URL once parsed: it lives in the options
 * object and is never logged.
 */
export function parsePostgresUrl(url: string): {
  readonly host: string;
  readonly user?: string;
  readonly password?: string;
  readonly database?: string;
} {
  const parsed = new URL(url);
  // `postgres://` and `postgresql://` are both real spellings, and `URL` reads both.
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw providerRejected(
      'postgres',
      `database url must start with postgres:// or postgresql://, not ${parsed.protocol}`,
    );
  }
  const database = parsed.pathname.replace(/^\//u, '');
  return {
    // HTTP needs a scheme, and the string does not carry one for it: the pooler is reached over
    // TLS on the same host name the socket form uses.
    host: `https://${parsed.hostname}${parsed.port === '' ? '' : `:${parsed.port}`}`,
    ...(parsed.username === '' ? {} : { user: decodeURIComponent(parsed.username) }),
    ...(parsed.password === '' ? {} : { password: decodeURIComponent(parsed.password) }),
    ...(database === '' ? {} : { database: decodeURIComponent(database) }),
  };
}
