# 05 — Database, Migrations & Seeders

> `@tsir/database`, `@tsir/migrate`, `@tsir/seed`. Drizzle stays the ORM; Tsir owns lifecycle, transactions, safety rails, and the deploy-target driver matrix.

---

## 1. Division of labour

| Concern                                                                      | Owner                       |
| ---------------------------------------------------------------------------- | --------------------------- |
| Schema definition, query building, relations, SQL generation                 | **Drizzle** (untouched)     |
| Connection lifecycle, pooling, health, transactions, codecs, instrumentation | **`@tsir/database`**        |
| Migration generation & journal                                               | **Drizzle Kit** (untouched) |
| Migration execution, locking, status, rollback guards                        | **`@tsir/migrate`**         |
| Seeder contracts, ordering, determinism, environments                        | **`@tsir/seed`**            |

Tsir ships **no** query-builder replacement, no model class hierarchy, and no second schema description language. Tables are Drizzle tables; rows are `InferSelectModel<T>`. Because D1 is the default engine, tables are
`sqliteTable` by default and `pgTable` on the Postgres driver — see § 2.

---

## 2. Driver matrix (D1 is the default; Postgres is the escape hatch)

Per **ADR-0016**, D1 is the default engine and Postgres is a fully supported alternative. A database
driver selects a **Drizzle dialect**, not an abstraction over SQL: D1 uses `sqliteTable`, Postgres
uses `pgTable`. Changing engines is a schema rewrite plus a data migration — a documented cliff, not
a config flag. There is no Eloquent-style schema layer, because that would mean reimplementing
Drizzle.

| Target             | Default driver                           | Alternative                                                  | Notes                                                                                                          |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers | **D1** (`drizzle-orm/sqlite-proxy`)      | Hyperdrive + `mysql2` (MySQL), or Hyperdrive + `postgres.js` | D1 is a binding, reachable only from Workers. 10 GB hard cap, single-threaded, **no interactive transactions** |
| Bun (server)       | **D1 via Miniflare** in dev              | `postgres.js`, or `mysql2/promise` (`@tsir/database/mysql`)  | `tsir dev` runs Wrangler/workerd for Workers-target apps; a Bun-target app uses an in-process pool             |
| AWS Lambda         | `postgres.js`, pool `max: 1` + RDS Proxy | `mysql2`, pool `connectionLimit: 1` + RDS Proxy              | **D1 is unavailable from Lambda.** A Cloudflare-first app cannot be moved to Lambda without changing engines   |

Rules:

- A driver is selected per connection by `tsir.js` (`database.connections.<name>.driver`, ADR-0019)
  and is **explicit**; no runtime sniffing beyond
  a capability probe that fails with `DB_DRIVER_UNAVAILABLE`.
- **`interactiveTx` is the decisive capability.** D1 is `false`; Postgres is `true`. Framework code is
  written against the D1 baseline: multi-statement writes use `batch([...])`, and read-modify-write
  uses optimistic concurrency (`WHERE version = ?`) or a Durable Object. Code that needs a real
  transaction declares `requires: { interactiveTx: true }` and fails at boot on a driver that cannot
  honour it (ADR-0015).
- `batch()` requires every statement to be known before execution, so a statement cannot depend on an
  earlier statement's result. Anything that needs that shape is a Durable Object, not a retry loop.
- The driver interface is a thin, internal `DbDriver` type (`query`, `batch`, `maybeTransaction`,
  `close`, `health`) — one file per driver, not a user-extensible plugin surface.
- **The Postgres client is `postgres.js`, supplied by the application** (**ADR-0009**). The
  framework ships the driver (`@tsir/database/postgres`), not the client: `pg` is CommonJS, and
  `postgres.js` does not declare `sideEffects`, so bundling either would have meant an exception
  to the dependency policy. This is Drizzle's own model for `drizzle-orm/postgres-js`.
- **A connection is not an engine.** One application may declare several connections — a read
  replica, an analytics database, a second D1 dedicated to the cache — each with its own driver,
  pool, capabilities and lifecycle. The registry that holds them and the per-call selector
  `database.connection(name)` are specified in § 3.1 and decided in
  [ADR-0019](../decisions/0019-multi-connection.md). The engine set above is unchanged by that:
  adding MySQL/MariaDB is a _driver_ (a dialect, a placeholder syntax, a dependency review), not a
  config entry, and it stays behind `Q14` and its own ADR.

## 2.1 What actually guarantees what (`DB-017`)

The most expensive misunderstanding in a typed stack is assuming that a
TypeScript type is enforced somewhere. It is not: types are erased, and SQLite
is dynamically typed, so a column can hold `"42"` where the type says `number`
and nothing will complain. This table is the honest division of labour, and the
task list treats a claim without a test as a bug.

| Guarantee                          | Enforced by                                  | Verified by                                              | It does **not** mean                                                     |
| ---------------------------------- | -------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| Shape of a row in your code        | TypeScript (`InferSelectModel<T>`)           | `tsc --noEmit`                                           | The database returns what the type says — nothing checks this at runtime |
| Required field is present          | `NOT NULL` in the migration                  | migration test + drift check                             | A `null` never reaches a handler that expects a value                    |
| Value is the right kind            | The database's column type (SQLite is loose) | per-engine test in `createTestDatabase`                  | `"42"` is rejected by SQLite for an integer column                       |
| Uniqueness                         | `UNIQUE` index                               | concurrent-insert test                                   | Your `SELECT`-then-`INSERT` is safe — use the constraint                 |
| Referential integrity              | The engine's foreign-key support             | `PRAGMA foreign_keys` / engine test                      | FKs are on by default on every engine — they are not                     |
| Uniqueness across concurrent txs   | The index + serialization                    | two-writer test                                          | `batch()` gives serializable isolation on Postgres                       |
| Atomic multi-statement write       | `batch([...])`                               | driver test (a failing statement aborts the whole batch) | You can read a value mid-batch and branch on it                          |
| Read-modify-write safety           | `WHERE version = ?` (optimistic)             | lost-update test (`DB-011`)                              | A transaction is available on D1 — it is not                             |
| Interactive transaction            | The driver's capability flag                 | `DB-006` (throws on D1), `DB-013` (Postgres)             | `interactiveTx()` can be approximated — it refuses                       |
| Input is valid before it is stored | `@tsir/validate` at the HTTP boundary        | route tests                                              | The database validates for you, or that seeds/CLI do                     |
| Encrypted column round-trips       | `@tsir/vault` + `codec.ts`                   | `DB-010` with `VLT-008`                                  | Encryption hides the value from `WHERE` / indexes                        |
| Durations and dates                | UTC + ISO-8601 in, UTC out                   | codec test                                               | Local time is preserved — it is not                                      |

Two rules follow and are enforced in review:

1. **Any constraint that matters is in the migration.** A `.refine()` on a schema
   protects one entry point; a `CHECK` protects every writer, including a
   psql session at 2 a.m.
2. **A type without a runtime check is a comment.** Where a value crosses a
   boundary the compiler cannot see (request body, queue message, seed file), it
   is validated, not asserted.

---

## 2.2 Drizzle sits _on top of_ the driver, not beside it

There are two ways to put Drizzle in front of D1, and the choice matters more
than it looks:

| Option                                                     | What it costs                                                                                                                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drizzle-orm/d1` with the raw `D1Database` binding         | A second path to the database. Queries bypass the drain counter, the capability checks most of all the query logging/redaction (`DB-009`), and nothing ties a Drizzle call to a `Database` lifecycle. |
| `drizzle-orm/sqlite-proxy` with a callback into the driver | One extra function call per statement. **Every** generated query becomes a `DbStatement`.                                                                                                             |

Tsir takes the second. The callback is `createDrizzle(database)`; `db.batch([...])`
is routed to `Database.batch`, so Drizzle's batch is the same atomic engine
transaction everything else uses.

Two consequences show up the first time someone debugs it, so they are documented
here and asserted in `drizzle.test.ts`:

1. **Drizzle wraps driver errors.** A failure arrives as `DrizzleQueryError`
   (`Failed query: …`) with the original `TsirError` — and its `code` — on
   `cause`. `errorCode()`/`rootCause()` exist for exactly this; reading `.code`
   off the thrown value yields `undefined`.
2. **Raw SQL returns positional rows.** `db.all(sql\`…\`)`has no field
metadata, so a row is`[3]`, not `{ count: 3 }`. The query builder maps
   correctly because the table carries the column definitions. A proxy dialect
   cannot know the names of columns in hand-written SQL, and guessing by
   re-ordering object keys is how the wrong value ends up in the wrong field.
3. **`db.transaction()` fails on D1**, loudly: the proxy issues `BEGIN`, which
   the engine rejects. That is the documented cliff (ADR-0016) — a test asserts
   the failure instead of leaving it as folklore.

---

## 2.3 A query log never contains a value (`DB-009`)

A query log is one of the easiest ways to leak everything you were protecting: an
email in a `WHERE`, a password hash in an `INSERT`, a session token in an
`UPDATE`. So the rule is structural, not a setting:

| Level  | What is emitted                                             |
| ------ | ----------------------------------------------------------- |
| `off`  | nothing                                                     |
| `slow` | statements at or above `slowQueryMs`, **and every failure** |
| `all`  | every statement                                             |

Every event carries the statement text with literals scrubbed
(`scrubSql`), the **types** and count of its parameters (`paramTypes`,
`paramCount`), `durationMs`, `rows`, `ok`, and — on failure only — the driver's
message. It never carries a parameter value, at any level, in any environment,
including `development`.

- `scrubSql` rewrites `'…'`, `"…"` and backtick spans to `?`. For generated SQL
  that is a no-op (Drizzle emits placeholders); for hand-written SQL it is the
  difference between a log and a leak. It is deliberately conservative — it does
  not parse SQL, because a scrubber that can be wrong about escaping is worse
  than one that over-redacts.
- A **failed** statement is logged at every level except `off`, however fast it
  was. An error that took 3 ms is still an error.
- The event shape is flat (`event: 'db.query'`), the same rule as
  `13-observability.md § 2.4`: a log line is data for a query language, not a
  sentence for a human.
- `logging: 'debug-params'` (an earlier draft of this section) is **not** a
  supported level. A redaction switch that can be turned off is a redaction
  switch that will be off in an incident. Debug a value by querying the row.

Because `Database` is the only path to a driver (§ 2.2), redaction also covers
Drizzle-generated statements — the reason the proxy dialect was chosen.

## 2.4 Read-modify-write without transactions (`DB-011`)

D1 has no interactive transactions, so "read the row, decide, write it back"
cannot hold a lock while it thinks. The portable pattern is a version column:

```sql
update "users" set "email" = ?, "version" = "version" + 1 where "id" = ? and "version" = ?
```

`applyOptimistic()` runs it and answers `{ ok: true, version }` or
`{ ok: false, reason }`, where the reason distinguishes:

| Result     | Meaning                                                   | Correct response                           |
| ---------- | --------------------------------------------------------- | ------------------------------------------ |
| `conflict` | the row exists, someone wrote first                       | re-read, re-apply, retry                   |
| `missing`  | the row does not exist (a follow-up `select 1` proves it) | surface "not found"; retrying is pointless |

Collapsing the two is how a lost update becomes silent data corruption: answering
"not found" for a conflict makes a retry loop give up one attempt too early.
`retryOnConflict()` retries **only** conflicts, with exponential backoff —
a generic "retry any error" wrapper is how a duplicate insert becomes three
duplicate inserts.

The version bump is written by the helper, not the caller, so a forgotten
`version = version + 1` cannot silently disable the guard. Table and column names
are validated against `/^[A-Za-z_][A-Za-z0-9_]*$/` before they reach the SQL
string: they come from code, not from a request, but a helper that interpolates
an unvalidated string into SQL is the exact shape of an injection bug.

## 2.5 The codec seam (`DB-010`)

Exactly one file knows that a stored value is not the value the application sees:
`src/framework/database/src/codec.ts`. `@tsir/vault` implements the interface
(VLT-008); nothing else may.

```ts
export interface ColumnCodec {
  readonly name: string; // 'vault.envelope.v1' — a format name, never a secret
  encode(column: ColumnRef, value: unknown): Promise<unknown>;
  decode(column: ColumnRef, stored: unknown): Promise<unknown>;
}
```

Three decisions are worth recording:

1. **The seam is async, and therefore not a Drizzle column codec.** `customType`'s
   `toDriver`/`fromDriver` are synchronous; AES-GCM via WebCrypto is not. The
   alternatives are hand-rolled sync crypto (forbidden, `06-vault.md § 6`) or
   returning ciphertext from `db.select()` under a `string` type (a silent leak).
   So `encodeRow()` runs before Drizzle sees a value and `decodeRow()` after rows
   come back — which is exactly the contract in `06-vault.md § 5`.
2. **The codec is given the column identity**, `{ table, column }`, which vault
   binds into the AEAD associated data. A ciphertext moved from `users.tax_id` to
   `users.phone` then fails authentication instead of decrypting happily in the
   wrong place.
3. **`null` passes through, `undefined` throws.** SQL `NULL` is "no value"; a
   missing key is a partial select. `undefined` in a row being written is a caller
   bug that would otherwise store an unencoded value.

Note the direction of the dependency: `@tsir/database` **declares** the interface
and `@tsir/vault` **implements** it, so there is not even an import edge from
database to vault — the boundary in `02-monorepo.md` is satisfied by construction
rather than by a lint rule.

Rows are copied, never mutated, and an undeclared table or column is passed
through untouched — encryption is opt-in per column and never implicit.

## 2.6 The boot check (`DB-007`)

`assertRequirements(database, requirements)` is called from the composition root
— normally the module that owns the database provider, in its `onStart` — with
every component that needs more than the D1 baseline. It reports **all**
unsatisfied components in one error (`DB_REQUIRES_INTERACTIVE_TX`), because
fixing one component per restart is not a plan. `declare()` is the
single-component form for a direct call site.

The lifecycle wrapper (`APP_HOOK_FAILED`) owns the thrown code and keeps the
database error as its `cause`, so a boot log still names the missing capability.

## 2.7 Postgres is a subpath, and the client is yours (`DB-012`, ADR-0009)

```ts
import postgres from 'postgres'; // the application installs this
import { createDatabase } from '@tsir/database';
import { createPostgresDriver, resolvePool } from '@tsir/database/postgres';
import { createPgDrizzle } from '@tsir/database/postgres/drizzle';

const pool = resolvePool({ target: 'lambda', pool: config.database.pool });
const database = createDatabase({
  driver: createPostgresDriver({ client: postgres(env.DATABASE_URL, pool.options) }),
});
const db = createPgDrizzle(database, { schema });
```

Four decisions, each of which is a test somewhere in `postgres.test.ts`:

1. **The driver is typed structurally** (`PgClientLike`: `unsafe`, optional `begin`, optional
   `end`) and never imports a Postgres client. `type-tests/postgres.types.ts` proves the real
   `postgres.js` client still satisfies the shape, so the separation cannot silently rot.
2. **`interactiveTx` is exactly `client.begin !== undefined`.** `createDatabase` refuses a driver
   whose flag and implementation disagree, in either direction (`DB_CAPABILITY_MISMATCH`).
3. **`changes` comes from `count`, not from `rows.length`.** An `UPDATE` without `RETURNING`
   returns no rows and would otherwise report `changes: 0` — a silent "nothing happened".
4. **Positional rows come from `raw()`.** `pg-proxy` maps columns by index, and a driver that
   re-orders object rows returns the wrong column when two tables share a column name.

**Pool size is a deploy-target fact (ADR-0009 § 3):**

| Target             | Connections         | Why                                                                 |
| ------------------ | ------------------- | ------------------------------------------------------------------- |
| Bun (server)       | `pool.max` (10)     | one process, one pool — the number is a real knob                   |
| AWS Lambda         | **1** (forced)      | concurrency _is_ the pool; 200 instances × 10 is a connection storm |
| Cloudflare Workers | **5** (forced, max) | Hyperdrive already pools; more connections fight the pooler         |

`resolvePool()` returns `{ options, max, clamped }` so the boot log can say that a `max: 20` on
Lambda became `1` instead of leaving throughput a mystery.

## 2.8 Drizzle on Postgres uses the proxy dialect too

`drizzle-orm/postgres-js` would take the raw client — the second path to the database that § 2.2
forbids for D1. `drizzle-orm/pg-proxy` binds to `Database` instead, so one rule covers both
engines, and `verify-dist` proves it in both directions: `db-app` contains no Postgres dialect,
`pg-app` contains no SQLite dialect and no client at all.

### Retrying is a claim about the callback, not about the error

```ts
await database.interactiveTx(async (tx) => { … }, { idempotent: true, attempts: 3 });
```

Only two SQLSTATEs are retried — `40001` (serialization failure) and `40P01`
(deadlock) — because those are the only failures where the _same work_ can succeed
on a second attempt. A unique violation (`23505`) is a business outcome; retrying
it would be a duplicate insert. And nothing is retried without `idempotent: true`:
the framework cannot know whether the callback already sent the email.

The consequence, stated rather than discovered: **`db.transaction()` throws on this dialect**
(“Transactions are not supported by the Postgres Proxy driver”). Transactions belong to
`Database.interactiveTx()`; bind a Drizzle instance to the scope it hands you:

```ts
await database.interactiveTx(async (tx) => {
  await createPgDrizzle(tx).insert(users).values({ email });
});
```

---

## 2.9 MySQL and MariaDB (`DB-023` … `DB-026`, ADR-0020)

A third dialect, and the first engine whose **semantics** — not whose type — are the work.
The short version, with the reasoning in [ADR-0020](../decisions/0020-mysql-engine.md):

| Concern                      | Postgres                           | MySQL / MariaDB                                                                             |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| Client                       | `postgres.js`, supplied by the app | `mysql2/promise`, supplied by the app (`@tsir/database/mysql` is the adapter)               |
| Workers transport            | Hyperdrive + `postgres.js`         | Hyperdrive + `mysql2@>=3.13.0`, `nodejs_compat`, **`query()` not `execute()`**              |
| Placeholder                  | `$1`                               | `?`                                                                                         |
| DDL in a transaction         | Allowed; the migration is atomic   | **Impossible** — MySQL commits implicitly around DDL                                        |
| Advisory lock                | `pg_try_advisory_lock(bigint)`     | `GET_LOCK('tsir:<hex16>', 0)`, server-scoped, names ≤ 64 chars                              |
| `searchPath`                 | Supported                          | Refused (`CFG_UNSUPPORTED_CONNECTION_OPTION`): a schema is a database                       |
| `insert(...).returning(...)` | Supported                          | Not in Drizzle's MySQL dialect; Tsir refuses rather than guessing (`DB_UNSUPPORTED_ENGINE`) |

Rules:

- **Capabilities are per transport, not per engine** (ADR-0019 § 4). A `mysql2` pool has
  `interactiveTx`, `pinnedConnection` and transaction-backed `batch`; PlanetScale's serverless
  HTTP driver has none of the three. Boot checks the connection, never the engine name.
- **`atomic: false` for DDL is reported, not hidden.** A file containing `CREATE`/`ALTER`/
  `DROP`/`RENAME`/`TRUNCATE` reports `atomic: false` even when it declares
  `-- tsir:transaction=on`, and the runner warns that the declaration cannot be honoured. The
  down file is the only recovery path for those migrations.
- **The lock key includes the database name**, because MySQL lock names live in the server's
  namespace rather than the database's; two applications on one server would otherwise share
  a lock.
- **The adapter requires `jsonStrings: true` and refuses `multipleStatements: true`** — the
  codec seam stays the only place a JSON payload is decoded, and a runner that can send
  several statements at once is an injection amplifier (Hyperdrive rejects multi-statement
  queries anyway).
- **MariaDB is supported, not emulated.** Same protocol, same dialect, tested against
  MariaDB 11 in CI; known divergences (JSON, `CHECK`, `RETURNING`, generated columns) are
  covered by tests and listed here rather than discovered in production (`Q49`).

> **Status (2026-11-07 audit, `INF-003`): `[PLANNED]`, not shipped.** `@tsir/database/mysql`
> does not exist in `src/framework/database/`, so the table above describes the intended engine,
> not a selectable one. A `mysql` connection today fails at config validation with a driver-missing
> error, which is at least honest; the risk is a reader of this table assuming the adapter is
> importable. The adapter ships as `INF-003`'s follow-up in
> [`../tasks/16-infrastructure-hardening.md`](../tasks/16-infrastructure-hardening.md), after the
> Postgres path is fixed. The Postgres column of this table is `[PARTIAL]` for the same task: the
> `$1` placeholder bug in `@tsir/auth` (`INF-001`) is a Postgres-only defect that a MySQL adapter
> must not reproduce (`?` placeholders count differently).

---

## 3. Connection & lifecycle

### 3.1 Named connections (`DB-019`, ADR-0019)

A database configuration is a **registry plus a default**, not a single driver:

```ts
export interface DatabaseConfig {
  /** Name of the connection used when no call site names one. */
  readonly default: string;
  readonly connections: Readonly<Record<string, ConnectionConfig>>;
}

export interface ConnectionConfig {
  /** Explicit, never sniffed. `d1` is the default per ADR-0016. */
  readonly driver: DatabaseEngine; // 'd1' | 'postgres' | 'mysql' — the union lives in the driver package
  readonly logging?: 'off' | 'slow' | 'all';
  readonly slowQueryMs?: number;
  /** Postgres-only; D1 has no pool to configure. */
  readonly pool?: {
    readonly max: number;
    readonly idleTimeoutMs: number;
    readonly connectTimeoutMs: number;
  };
  readonly statementTimeoutMs?: number;
  /** Postgres-only: shows up in `pg_stat_activity`, and scopes the advisory lock. */
  readonly applicationName?: string;
  readonly searchPath?: string;
  /** `true` only for connections readiness must fail on (see below). */
  readonly required?: boolean;
}
```

```js
// tsir.js — the shape this generates
database: {
  default: 'app',
  connections: {
    app:       { driver: 'd1', binding: 'DB' },
    cache:     { driver: 'd1', binding: 'CACHE_DB', required: false }, // ADR-0016 § 1.4
    reporting: {
      driver: 'postgres',
      url: { fromEnv: 'REPORTING_URL', secret: true },
      pool: { max: 4 },
      applicationName: 'acme-reporting',
      required: false,
    },
  },
},
```

The engine union stays deliberately two values, not five. `postgres-js`, `hyperdrive` and
`neon-http` are _transports_ for the same Postgres engine, chosen by the deploy target
(`plans/modules/08-deploy.md`), not by application config: a Workers build gets Hyperdrive because that is
the only way a Worker reaches Postgres, and a Lambda build gets `postgres.js` with `max: 1`. Making
them separate config values would let an application claim a transport its target cannot provide.
A `d1` entry names the **binding** declared in the deploy config (`[[d1_databases]] binding = "DB"`);
on Workers the runtime resolves it from the unit's `env`, and under `make dev` Miniflare resolves the
same name. A connection either has a binding (D1) or a URL (Postgres), never both —
`CFG_AMBIGUOUS_CONNECTION` if it does.

```ts
// application code — explicit, typed, and checked at the call site
const rows = await db.connection('reporting').query(sql);
await db.connection('app').interactiveTx(async (tx) => { /* … */ });

// constructor DI names the connection in the token, not inside the class body
constructor(@InjectDatabase('reporting') private readonly reporting: Database) {}
```

Rules:

- **The registry key is the name; the driver is a property.** Three `postgres` connections and
  one D1 connection is a normal configuration. Nothing in the registry assumes one connection per
  engine.
- **`default` is mandatory and explicit.** There is no "first entry wins": a missing `default` is a
  config error at boot (`CFG_MISSING_DEFAULT`), because the connection a stray query lands on must
  be chosen deliberately, not by object key order.
- **Unknown names are errors.** `db.connection('reportng')` throws `DB_UNKNOWN_CONNECTION` with
  the declared names. It never falls back to the default — a silent fallback is how a reporting
  query writes to production. The name set is a literal type produced by `tsir build`, so a typo
  is also a compile error; the runtime check covers a `tsir.js` edited without a rebuild.
- **Each connection keeps its own journal.** `migrationFolder(root, connection, { base })` puts the
  default connection at `migrations/` and every other one at `migrations/<name>`; the advisory lock
  key hashes `${application}:${connection}`, because two connections are two deployments and one
  lock for both would serialise unrelated DDL. Results carry `connection` so a CI log says which
  database was changed.
- **A seeder can declare its connections** (`SED-011`). `connections: ['reporting']` on a seeder is a
  promise about where its rows belong; `db:seed --connection=app` then refuses _before_ the first
  insert (`SED_UNDECLARED_CONNECTION`), because rows written to the wrong database are not undone by
  a later error. Omitting the list means "any connection", which is the honest default for a seeder
  with no opinion.
- **The surface is `createConnections`.** `createConnections({ default, connections })` builds every
  entry eagerly and returns `{ names, default, defaultDatabase, connection(name), health(), close() }`;
  `connectionConfigSchema` and `databaseConfigSchema` validate one entry and the registry; and each
  `Database` gains `name` plus `connection(name)` — while `DB-018`'s pin becomes `pinned(fn)`, because
  "same session" and "same name" are different promises (ADR-0019 § 9).
- **Requirements are checked per connection.** `assertConnectionRequirements(connections, …)` takes
  `{ component, connection?, interactiveTx? }` and reports every unsatisfied pair at once, each with
  the connection name and _that_ connection's engine — the single-connection `assertRequirements()`
  stays for code that holds one `Database`. Every log event carries `connection`, because after
  redaction a slow-query line without the name is a duration with no database attached.
- **`connection(name)` returns a `Database`, not a wrapper.** Same contract, same transaction API,
  its own pool, its own capabilities. Code written against `Database` runs unchanged against any
  connection, which is what lets a suite run on D1 and a deployment on Postgres.
- **Capabilities are per connection.** `requires: { database: { connection: 'reporting',
interactiveTx: true } }` fails at boot with `DB_CAPABILITY_UNSUPPORTED` naming both. A mixed
  deployment (D1 `app`, Postgres `reporting`) is therefore verifiable before the first request.
- **No cross-connection transactions.** See § 4.
- **Read replicas are never implicit.** No `replica: true` flag routes reads behind the caller's
  back; a replica read is `db.connection('replica')` or a repository that names it. Read-your-writes
  violations are invisible in tests and expensive in production.
- **Driver imports stay static.** Multiplicity is per connection, not per driver: two connections on
  the same driver emit one static import in `drivers.gen.ts`. There is no
  `import('@tsir/database/' + engine)` path, ever (ADR-0012).
- **The connection name is an observability dimension.** Query logs, spans, metrics and health all
  carry `db.connection`; `make dev` prints it; a slow-query warning without it is unactionable.

### 3.2 Lifecycle, health and pinning

- **Lazily connected, eagerly validated.** A connection is opened on first use (a Workers isolate
  must not open three databases to serve a health check); its config, driver availability and
  capability requirements are validated at boot.
- **Disposal drains every connection.** Shutdown drains in-flight work on all connections in
  parallel under one shared deadline, then closes them; `pinned()` scopes are awaited first.
- **Health is per connection** (`db.health()`), each with `required`. A failing optional connection
  (the cache database, a replica) flips readiness to `degraded` and does not crash the process; a
  failing `required` connection fails readiness. In production, the process stays up either way and
  requests fail fast with `503` where configured.
- **`Database.pinned(fn)`** (renamed from `connection(fn)` in `DB-018`, because `connection` now means
  the registry — ADR-0019 § 9) pins one physical connection for the duration of `fn`, which is the
  only way session-scoped state such as `pg_try_advisory_lock` is sound on a pooled client. It is
  scoped to the connection it was called on; `db.connection('reporting').pinned(fn)` pins inside
  that connection's pool.
- **Query logging never emits a bound value**: `logging: 'all'` prints SQL with placeholders plus
  parameter _types_ and count (§ 2.3). There is no level, and no environment, in which a value
  reaches the log.

> **Status (2026-11-07 audit, `INF-002` and `INF-003`).**
>
> | Behaviour described above                       | Status         | Why                                                                                                                                                                                                                                               |
> | ----------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | Lazily connected, eagerly validated             | `[PARTIAL]`    | `createConnectionsFromConfig` builds drivers **eagerly at boot** and throws for `postgres`; the lazy path exists per connection but the config factory does not use it (`INF-003`)                                                                |
> | Hyperdrive on Workers                           | `[PARTIAL]`    | `env.HYPERDRIVE.connectionString` changes **per request**, so a boot-time client cannot be correct. Request-scoped construction is `INF-003`                                                                                                      |
> | Disposal drains every connection                | `[VERIFIED]`   | pool rules, ADR-0009                                                                                                                                                                                                                              |
> | Per-connection health                           | `[VERIFIED]`   | `db.health()`                                                                                                                                                                                                                                     |
> | `createDatabaseBootstrap` (Bun/SQLite topology) | `[LIMITATION]` | statically imports `bun:sqlite`, `node:fs`, `node:path` from the package barrel, caches the first `DbDriver` forever, and mutates a module-global binding per request (`INF-002`). It works for a single Bun process and is not usable on Workers |
> | MySQL (`@tsir/database/mysql`)                  | `[PLANNED]`    | does not exist (§ 2.9)                                                                                                                                                                                                                            |

---

## 4. Transactions

```ts
export interface TransactionContext {
  readonly db: Database;                 // transaction-scoped Drizzle instance
  readonly id: string;
  readonly depth: number;
  readonly savepoint?: string;
}

await database.withTransaction(async (tx) => {
  await tx.insert(users).values(...);
  await events.publishInTransaction(tx, new UserRegistered(user.id)); // outbox
}, { isolation: 'read committed', retry: { attempts: 3, backoff: 'exponential' } });
```

The method is `Database.interactiveTx(fn)`; the callback receives a **transaction-scoped
`Database`** (not a raw connection, and not an implicitly enrolled outer one).

Guarantees:

| Property        | Behavior                                                                                                                                             | Status        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Scoping         | `tx` is the only way to run queries inside the transaction; the outer `Database` is **not** implicitly enrolled (no CLS magic).                      | `DB-013` done |
| Nesting         | Nested calls open a `SAVEPOINT`; depth capped at 16 (`DB_TX_DEPTH_EXCEEDED`).                                                                        | `DB-013` done |
| Lifetime        | A query on the scope after the callback settles fails with `DB_CLOSED`; `close()` outside never ends the pool.                                       | `DB-013` done |
| Retry           | Only for serialization failures (`40001`) and deadlocks (`40P01`), and only when the callback is declared `idempotent: true`.                        | `DB-013` done |
| Read-only       | `{ readOnly: true }` issues `SET TRANSACTION READ ONLY` first; writes fail with `25006`. Nested scopes inherit it (`DB_TX_OPTION_UNSUPPORTED`).      | `DB-013` done |
| Long tx warning | A scope open past `3 × statementTimeoutMs` emits `db.transaction.open` with its depth, once.                                                         | `DB-013` done |
| Leak detection  | A transaction held open longer than `statementTimeoutMs * 3` logs a warning with the creation stack (dev) / id (prod).                               |
| Async escape    | Passing `tx` to a detached promise is a user bug; the framework cannot prevent it, so it is documented with a test showing the failure mode.         |
| Read-only       | `withTransaction(fn, { readOnly: true })` sets the Postgres transaction mode; writes fail with `25006`.                                              |
| Connection      | A transaction belongs to exactly one connection (`DB-019`); `tx` exposes no `connection()` selector, so a cross-connection write is not expressible. |

**Transactions never span connections.** `db.connection('app').interactiveTx(...)` hands the callback
a `Database` bound to `app`, and that handle has no selector on it — the mistake cannot be written,
which is better than an error nobody reads. Where two connections must change together, the portable
answer is a transactional outbox on the writer plus an idempotent consumer on the reader
(`15-capabilities.md` § 4.2): no target here offers two-phase commit, and D1 forbids interactive
transactions outright. Attempting to reach another connection from inside a transaction fails with
`DB_CROSS_CONNECTION_TX` and a pointer to the outbox section.

---

## 5. Migrations

### 5.1 Workflow

```bash
bun run tsir make:migration add_users_email   # wraps `drizzle-kit generate` with naming + template check
bun run tsir migrate                          # apply pending on `database.default`, under advisory lock
bun run tsir migrate --connection=reporting   # the same, on a named connection
bun run tsir migrate:status                   # applied / pending / checksum drift
bun run tsir migrate:rollback --to <name>     # explicit target required
```

- **One journal per connection.** Migrations belong to a connection, not to the application: each
  connection has its own folder (`paths.migrations` may be a string for the default connection or a
  map keyed by connection name, defaulting to `drizzle/<connection>`), its own
  `__drizzle_migrations` and its own `__tsir_migration_runs`. A repository with `app` and
  `reporting` therefore has two journals, and `migrate` without `--connection` touches exactly one of
  them. Every command prints the connection it is about to change; a multi-connection run is
  explicit (`--all-connections`) rather than the default, because "apply to everything" is the
  command that ruins a replica's lag budget during a deploy.
- **Journal:** Drizzle's `meta/_journal.json` + `__drizzle_migrations` table remain authoritative ([ADR-0007](../decisions/0007-migrations-over-drizzle.md)). Tsir adds a sidecar table `__tsir_migration_runs` (run id, host, duration, checksum, actor, connection) for observability — never a replacement journal.
- **Locking:** `pg_advisory_lock` on Postgres and `GET_LOCK` on MySQL (§ 2.9), on a key derived from `applicationName` **and the connection** (the database name too on MySQL, whose lock namespace is the server), taken inside a `pinned()` scope (`DB-018`) so the lock and the DDL share one backend. Second runner exits `0` with "another migration is in progress" or waits when `--wait` is passed.
- **Transaction policy:** per-migration declaration in a header comment (`-- tsir:transaction=on|off`). Default `on`. Statements that Postgres forbids inside a transaction (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE` on older versions) must be marked `off`; the runner warns loudly and records the run.
- **Failure:** stops at the failing migration, records the error, exits non-zero, and prints the prerequisite command to inspect state. It never "continues best-effort".
- **Drift detection:** stored checksum vs file checksum; mismatch is a hard error (`DB_MIGRATION_DRIFT`) — someone edited an applied migration.
- **Rollback policy:** `down` is generated by `drizzle-kit` where possible, but destructive rollbacks require `--allow-destructive` **and** a typed confirmation of the migration name. Data-loss risk is printed explicitly. Rollback is documented as **not universally safe**.
- **Backup guidance:** every production migration command prints the pre-flight checklist link (snapshot/PITR verification, lock impact, rollback plan).

### 5.2 Deployment guidance

- Migrations run as a **separate unit** in `separate` topology (`unit: migrate`), never on HTTP cold start.
- A **multi-connection** deployment gets one migrate unit **per connection** (`migrate:app`, `migrate:reporting`), each with its own binding, its own schedule and its own failure domain. They are not merged into one unit: a replica that is behind must not block the primary's migration, and an analytics connection that is briefly unreachable must not fail a release.
- For `single` topology, an explicit `entrypoint: migrate` invocation is generated; the docs warn against running migrations on every isolate/container start.
- A mandatory `migrate:verify` CI step runs migrations from zero against an ephemeral Postgres and then from the previous release state, **once per connection that has a journal**.

---

## 6. Seeders

```ts
export interface SeederContext {
  readonly db: Database;
  /** Which connection this run targets; `db` is already bound to it (ADR-0019). */
  readonly connection: string;
  readonly env: 'development' | 'test' | 'staging';
  readonly clock: Clock; // fixed in tests
  readonly random: Random; // seeded in tests
  readonly log: Logger;
}

export class UsersSeeder implements Seeder {
  readonly name = 'UsersSeeder';
  readonly order = 10;
  readonly idempotent = true; // must implement onConflict do-nothing / upsert
  readonly environments = ['development', 'test'] as const;

  async run(ctx: SeederContext): Promise<void> {
    /* deterministic inserts */
  }
}
```

Rules:

- **Never** run automatically in production; `tsir db:seed` refuses when `APP_ENV=production` unless `--reference-data` is passed _and_ the seeder declares `production: true` (reference/lookup data only).
- **Seeders are scoped to a connection** (`tsir db:seed --connection=reporting`, default
  `database.default`). A seeder declares which connections it may run against
  (`connections?: readonly string[]`, absent = the default only), and the runner refuses a
  connection the seeder did not declare — seeding a replica is a legitimate operation, doing it
  by accident is not. `ctx.db` is the connection-bound handle, never a registry the seeder has to
  navigate.
- Explicit ordering by `order`, then name; ties are a boot error (`SED_ORDER_AMBIGUOUS`).
- Determinism: injected `Clock`/`Random`; banned APIs (`Date.now`, `Math.random`) are lint-restricted inside `src/framework/seed` and example seeders.
- Idempotency is _declared and tested_: the test harness runs every seeder twice and asserts row counts are stable.
- Each seeder runs in a transaction by default; `transaction: false` must be justified in a comment (e.g. very large reference tables).

---

A seeder may also declare **which connections it writes to** (`SED-011`):

```ts
export const LookupSeeder = defineSeeder({
  name: 'LookupSeeder',
  order: 10,
  idempotent: true,
  environments: ['development', 'staging', 'production'],
  production: true,
  connections: ['app'], // run `db:seed --connection=app`, or get SED_UNDECLARED_CONNECTION
  run: async ({ db }) => {
    /* … */
  },
});
```

The check runs against the **planned** seeders, before the first insert: rows written to the
wrong database are not undone by a later error, and a seeder skipped for its environment cannot
be the reason a run fails. Omitting `connections` means "any connection" — the honest default for
a seeder with no opinion.

## 7. Testing strategy

| Test type   | Setup                                                                           | Assertions                                                               |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Unit        | Mock driver                                                                     | SQL shape, config validation, codec wiring                               |
| Integration | Ephemeral Postgres (container or `PGlite` for fast paths where semantics match) | Real queries, transactions, savepoints, isolation levels                 |
| Migration   | Schema-migrate from empty → current; then apply one more pending                | Journal correctness, lock behavior, drift detection                      |
| Concurrency | N parallel `withTransaction` + rotation runner                                  | No deadlocks under retry; rotation resumes                               |
| Codec       | Encrypted column round-trip                                                     | Ciphertext differs per write; plaintext never in `pg_stat_activity` logs |

### `createTestDatabase()` (`DB-016`)

`@tsir/testing/database` exposes `createTestDatabase()`, which gives a suite its own
schema so suites can run in parallel and in any order. It is a **subpath** so the
harness root stays free of Drizzle: a test that only boots an app never loads the
database layer.

```ts
import { createTestDatabase } from '@tsir/testing/database';

const db = await createTestDatabase({
  suite: 'users-api', // folded into the generated schema name
  connect: (schema) => postgres(url, { max: 2, connection: { search_path: schema } }),
  setup: (database) => migrate(database), // runs once, and again after every reset()
});

await db.query('select * from users'); // rows only
await db.reset(); // drop schema → reconnect → recreate → setup
await db.close(); // drop schema, end the pool
```

- **The schema is per suite, not per test.** Truncating between tests leaves
  sequences, triggers and constraints behind, and it cannot run two suites at once.
- **`connect` is a factory, not a client.** `search_path` is a _connection_
  setting; mutating a pool the caller owns would race every other query on it, and
  prefixing statements would break parameterised SQL and transactions. The harness
  hands the generated schema name to the factory and never rewrites SQL — if the
  client is not pointed at the schema, the isolation is fiction.
- **Two databases in one suite** (`DB-022`) need two harnesses, not a registry: call
  `createTestDatabase({ connection: 'reporting', … })` again. The **schema** does the isolation;
  the **name** is what keeps the two apart in logs and failure messages.
- **`reset()` reconnects.** `close()` ends the pool, so a "closed then reused"
  client fails with `connection closed` on the very next query.
- **Names are generated and checked.** `tsir_test_<slug>_<8 hex>` keeps failure
  messages readable; `public`, `pg_*`, `information_schema` and `pg_temp` are
  refused before a single statement reaches the server, because the harness runs
  `DROP SCHEMA … CASCADE`.
- **`seed(names)` is not here yet.** It lands with `@tsir/seed` (`SED-*`); adding
  the parameter now would be an API promising a feature that does not exist.
- **One harness per connection.** `connect` builds the client for a named connection
  (`connect: (schema) => postgres(env('REPORTING_URL'), …)`), and a suite that spans two
  connections takes two harnesses — `createTestDatabase({ connection: 'reporting', … })` only
  labels the schema and the error messages, it does not reach into the application's registry
  (`DB-022`).

---

## 8. Failure modes

| Code                      | Cause                                                                              | Behavior                           |
| ------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------- |
| `DB_CONNECT_FAILED`       | Bad URL / DB down                                                                  | Boot fails with masked URL         |
| `DB_AUTH_FAILED`          | Credentials                                                                        | Boot fails; never prints password  |
| `DB_DRIVER_UNAVAILABLE`   | Driver can't run on target (e.g. `postgres-js` on Workers without `nodejs_compat`) | Boot fails with remediation        |
| `DB_TX_TIMEOUT`           | Statement timeout inside tx                                                        | Rollback, error surfaced to caller |
| `DB_TX_RETRY_EXHAUSTED`   | Serialization retries exhausted                                                    | Error with attempt log             |
| `DB_MIGRATION_DRIFT`      | Applied file edited                                                                | Hard fail, no apply                |
| `DB_MIGRATION_LOCKED`     | Another runner holds the lock                                                      | Wait or exit 0 depending on flags  |
| `DB_MIGRATION_FAILED`     | SQL error                                                                          | Stop, report file + statement      |
| `DB_ROLLBACK_DESTRUCTIVE` | Rollback with data loss without flag                                               | Refuse                             |
| `SED_ORDER_AMBIGUOUS`     | Two seeders share `order`                                                          | Boot fail                          |
| `SED_PRODUCTION_REFUSED`  | `db:seed` in production without declaration                                        | Refuse                             |

---

## 9. Security considerations

- Secrets (`DATABASE_URL`) are `Redacted`; logging shows `postgres://user:***@host/db` only.
- `logging: 'all'` never logs parameter values — not in development, not behind a flag.
  There is no `debug-params` level: a value that reaches a log has escaped the
  process, and "development only" is one misconfigured `APP_ENV` away from
  production (§ 2.3).
- RLS support: Tsir does not hide Postgres RLS; `withTransaction` accepts `{ role, appUserId }` to `SET LOCAL` session variables so policies work. Documented pattern, no ORM magic.
- Encrypted columns are declared separately (`06-vault.md`); the DB sees ciphertext only. Searchable encryption is explicitly out of scope.
- Migration actors are recorded (`tsir.user`, hostname) for audit.
- Connection strings in `tsir.js` are forbidden — config is env-only for secrets.

---

## 10. Open questions

| #   | Question                                                                                                                                                                                                                       | Blocks             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Q13 | `PGlite` for unit-level DB tests: accept the dialect mismatch risk to make CI fast, or always use real Postgres?                                                                                                               | Phase 3            |
| Q14 | ~~MySQL/MariaDB as an engine?~~ **Answered by [ADR-0020](../decisions/0020-mysql-engine.md)** (2026-10-28): yes, a third dialect, tracked as a Phase 3 extension by `DB-023` … `DB-026`. Open sub-questions are `Q49` … `Q51`. | answered           |
| Q15 | Multi-tenant schema-per-tenant support — expressive `searchPath` per scope, or documented as application-level?                                                                                                                | Phase 3            |
| Q49 | MariaDB divergences (JSON type, `CHECK` enforcement, `RETURNING` support, generated columns): which are supported, and which are documented as "MySQL 8 only"?                                                                 | `DB-024`           |
| Q50 | Does MySQL ship for Workers (Hyperdrive) at the same time as for Bun/Lambda, or is the edge path deferred until `DB-025`'s suite runs against a real Hyperdrive config?                                                        | `DB-023`           |
| Q51 | PlanetScale's serverless driver as a subpath (`@tsir/database/mysql/planetscale`), or application-supplied client only like every other transport?                                                                             | `DB-023`           |
| Q44 | Tenant **connections** (a connection whose config is resolved per request from a tenant registry): allowed through `defineConnection(name, config)` at boot, or entirely application-owned with `createDatabase()`?            | `DB-019` follow-up |
| Q45 | Do `migrate`/`db:seed` accept `--all-connections`, or does a multi-connection deploy always drive one unit per connection? § 5.2 assumes the latter; the flag is currently specified as `--connection` only.                   | `DB-021`           |

---

## 11. Task index

[`tasks/04-database.md`](../tasks/04-database.md) — `DB-001` … `DB-026`, `MIG-001` … `MIG-016`, `SED-001` … `SED-011`.

Infrastructure findings that belong to this module but are tracked centrally, because each one also
touches `@tsir/auth`, `@tsir/console` or the deploy emitters:
[`tasks/16-infrastructure-hardening.md`](../tasks/16-infrastructure-hardening.md) —

- `INF-001` — the Postgres `$1`/`$1` placeholder bug (`@tsir/auth`, but it is the reason the Postgres
  column of § 2 is `[PARTIAL]`);
- `INF-002` — `bun:sqlite`/`node:fs` in the package barrel, and the mutable global binding in
  `createDatabaseBootstrap`;
- `INF-003` — `createConnectionsFromConfig` for Postgres, request-scoped Hyperdrive, and the
  `[PLANNED]` MySQL subpath;
- `INF-010` / `INF-011` — driver-level dialect leakage in `@tsir/telemetry` and `@tsir/pennant`.

Substrate profiles and the hybrid story (Workers → RDS via Hyperdrive) are in
[`../architecture/17-infrastructure-philosophy.md`](../architecture/17-infrastructure-philosophy.md)
§ 12; this document owns the engine and connection semantics.
