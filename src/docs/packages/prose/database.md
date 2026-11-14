## Example

Create a database from a driver and run a statement on it. This example uses a stub D1 binding so it
runs with no Cloudflare account. In a Worker, pass the real `env.DB` binding instead.

```ts
import { type D1Like, createD1Driver, createDatabase, statement } from '@tsir/database';

const binding = {
  prepare: () => ({
    bind() {
      return this;
    },
    all: async () => ({ success: true, results: [{ one: 1 }] }),
    run: async () => ({ success: true, meta: { changes: 0 } }),
  }),
  batch: async () => [],
} as unknown as D1Like;

const database = createDatabase({ driver: createD1Driver({ binding }) });
const result = await database.query(statement('select 1 as one'));

console.log(result.rows);
```

## Failure modes

- `DB_POSTGRES_HTTP_FAILED` / `DB_MYSQL_HTTP_FAILED`: the provider rejected a statement. The message
  carries what the provider said, because that is the operable part — a missing table, a stale
  password, a paused database; the code is Tsir's, so a caller can branch on "the database rejected
  this" without parsing vendor prose.
- `DB_SQLITE_NO_HANDLE`: the `sqlite` connection has no file handle. Nothing opens a file implicitly:
  pass `openSqlite: openSqliteFiles` from `@tsir/database/bun` to `createDatabaseBootstrap`, or hand the
  driver a handle yourself. A Worker that never does this is correct — it has no filesystem — and the
  error names the connection rather than failing with an unhandled `EBADF`. See "Two entrypoints" below.
- `DB_TX_NESTED_UNSUPPORTED`: a transaction was opened inside another on a SQLite file. SQLite has no
  nested transactions and no savepoints in this driver; flatten the work into one transaction, or
  run the statements as a batch.
- `DB_URL_REQUIRED`: a `postgres` or `mysql` connection has no `url`. Both engines reach a pooler
  over HTTP, so the URL is the connection — there is no pool object to fall back on, and a
  connection that built without one would fail on its first statement instead of at boot.
- `DB_D1_NO_BINDING`: a `d1` connection has no `binding` in `config/database.ts`. D1 is reached through
  a Worker binding, never a connection string, so the binding name is required even though the rest of
  the entry looks complete.
- `DB_POSTGRES_BOOTSTRAP_UNWIRED`: `bootstrap` was asked to wire PostgreSQL but no `postgres()` client
  factory was supplied. Tsir does not pick a Postgres client for you (ADR-0009), so the application
  supplies one; the error names the missing factory rather than failing on the first query.
- `DB_TX_STATEMENT_UNSUPPORTED`: `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT` reached a D1 connection. D1 has
  no interactive transactions; use `batch([...])` for atomic multi-statement writes (ADR-0016).

- `DB_UNKNOWN_CONNECTION`: a connection name was used that is not declared. The message lists the
  declared connections.
- `DB_UNKNOWN_DEFAULT`: the default names a connection that is not declared.
- `DB_NO_CONNECTIONS`: no connections are declared.
- `DB_CLOSED`: a query was made after the database was closed.
- `DB_DRIVER_UNAVAILABLE`: the driver is not available on this target, such as a Node driver inside a
  Worker. The message gives the target and the reason.
- `DB_HEALTH_FAILED`: the health check could not reach the database.
- `DB_BATCH_EMPTY`: a batch was sent with no statements.
- `DB_TX_INTERACTIVE_UNSUPPORTED`: the driver cannot hold a transaction open across several statements.
  Use `batch([...])` instead, or choose a driver that supports it.
- `DB_TX_OPTION_UNSUPPORTED`: a transaction option is not supported on this driver.
- `DB_TX_DEPTH_EXCEEDED`: transactions are nested deeper than the limit.
- `DB_REQUIRES_INTERACTIVE_TX`: a component needs interactive transactions, but the driver has none.
  The message names the component.
- `DB_REQUIRES_TX_CONNECTION`: a component needs a transaction, but was given a connection outside one.
- `DB_CAPABILITY_MISMATCH`: a driver declares interactive transactions without `begin()`, or the other
  way round. This is a bug in the driver.
- `DB_CONNECTION_PIN_UNSUPPORTED`: the driver cannot pin a connection to one request.
- `DB_CODEC_INVALID_NAME`: a column codec has no name. A name identifies the stored format, so an
  anonymous codec cannot be audited.
- `DB_CODEC_INVALID_COLUMN`: a table or column name is not a plain SQL identifier. Column codecs are
  declared in code and never from request data.
- `DB_CODEC_DUPLICATE_COLUMN`: a column is declared with two codecs. A column has one storage format.
- `DB_CODEC_UNDEFINED_VALUE`: a codec column was given `undefined`. Pass `null` for no value.
- `DB_ROTATION_INVALID_IDENTIFIER`: a rotation was given a table or column that is not a valid
  identifier.
- `DB_ROTATION_TARGET_MISMATCH`: a rotation store is used for a different column from the one it was
  built for.

- `DB_RAW_UNSUPPORTED`: the Postgres client cannot return rows by position, which the `arrays` row format
  needs. Use a client that implements `raw()`, such as postgres.js. The driver does not guess column order.
- `DB_BATCH_UNSUPPORTED`: the Postgres client has no `begin()`, so `batch()` cannot be atomic. Pass a client
  built by postgres.js.

## Security notes

Queries use bound parameters, and the names of tables and columns are checked as identifiers, so request
data never becomes SQL text. Logged SQL is scrubbed of parameter values before it is written. Keep
connection strings and bindings in the platform's secret store, and pass them to the driver rather than
writing them into code.

## Two entrypoints

`@tsir/database` is what a Worker imports. `@tsir/database/bun` is what a CLI or a local dev script
imports, and it is the only one that may name `bun:sqlite`, `node:fs` or `node:path`.

```ts
// database.ts — a Workers app that also runs `tsir migrate` locally
import { createDatabaseBootstrap } from '@tsir/database';
import { openSqliteFiles } from '@tsir/database/bun';
import config from './config/database.ts';
import { join } from 'node:path';

export const { db, drizzle } = createDatabaseBootstrap(config, {
  migrationsDir: join(import.meta.dir, 'migrations'),
  sqlitePath: join(import.meta.dir, '..', '.tsir', 'app.db'),
  openSqlite: openSqliteFiles,
});
```

The split is not tidiness. Those three specifiers cannot be bundled for a Worker at all: a bundle
that contains one fails when the module graph is evaluated, not when the fallback branch runs, so an
`await import()` inside the function does not help. `deploy-bundle-targets.test.ts` builds the root
entrypoint for a browser target and asserts none of the three appear in the emitted code. Omitting
`openSqlite` is the Workers-only configuration and costs nothing.

This is the subpath-scope decision applied to a runtime rather than a package: an optional
dependency may live behind one entrypoint, and a bundle proof keeps the scope honest. `@tsir/link`
does the same for gRPC and its XML parser.
