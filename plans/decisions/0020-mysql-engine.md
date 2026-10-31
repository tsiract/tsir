# ADR-0020 — MySQL and MariaDB: a third dialect, a fourth set of semantics

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related:** [ADR-0016](./0016-cloudflare-first-and-d1.md) (D1 default), [ADR-0009](./0009-postgres-transport.md) (app-supplied client), [ADR-0012](./0012-dependency-policy.md) (dependency policy), [ADR-0019](./0019-multi-connection.md) (named connections), [ADR-0007](./0007-migrations-over-drizzle.md) (Drizzle journal)

## Context

ADR-0016 fixed the engine set at two — D1 by default, Postgres as the escape hatch — and
`Q14` recorded "no MySQL until a caller justifies it; revisit only with an ADR". The
justification is now explicit: a large share of the applications this framework targets
already have a MySQL or MariaDB database, and "rewrite your schema to Postgres first" is
not an adoption path. That gap is worth closing.

Two facts changed since ADR-0016 was written, and both matter:

1. **Workers can now reach MySQL.** Cloudflare Hyperdrive reached general availability for
   MySQL in 2026 — MySQL 5.7–8.x, MariaDB, Aurora MySQL, PlanetScale, self-hosted — so a
   Worker is no longer limited to D1 or a Postgres endpoint
   ([supported databases][hyperdrive-db], [Hyperdrive MySQL][hyperdrive-mysql]).
2. **Drizzle already supports the dialect.** `drizzle-orm/mysql2`, `dialect: 'mysql'` in
   drizzle-kit, `mysqlTable` schemas, and the same `__drizzle_migrations` bookkeeping table
   ([Drizzle MySQL][drizzle-mysql], [drizzle-kit migrate][drizzle-migrate]). Nothing in
   ADR-0007 — "Drizzle's journal stays authoritative" — is dialect-specific.

So the question is not _whether_ the dialect can exist. It is what a third engine costs in a
framework whose safety rails were designed around the other two, and where the honest
boundaries are. Three of those costs are load-bearing enough that "add an enum member" would
have been wrong:

- **MySQL commits implicitly before and after DDL** ([implicit commit][mysql-implicit-commit]).
  A migration that creates a table can never be rolled back, whatever the transaction header
  says. The runner must say so rather than report `atomic: true` over a statement that already
  committed half the file.
- **Hyperdrive does not support protocol-level prepared statements or multi-statement queries**
  ([Hyperdrive MySQL limitations][hyperdrive-db]). The client must therefore use mysql2's
  text protocol (`query`), not `execute`, and must never be configured with
  `multipleStatements: true`.
- **MySQL advisory locks are server-scoped, not database-scoped, and names are capped at 64
  characters** ([locking functions][mysql-locks]). The lock key that works for Postgres
  (`applicationName` hash) can collide between two applications on one server.

## Decision

### 1. `mysql` is a third engine; MariaDB is not a fourth

`DatabaseEngine = 'd1' | 'postgres' | 'mysql'`. MariaDB speaks the MySQL protocol and is
served by the MySQL dialect, so it is **not** a separate engine and not a separate driver: it
is the same driver with a support level, documented as "MySQL-compatible, tested against
MariaDB 11 in CI". Where MariaDB diverges (JSON handling, `CHECK` enforcement, `RETURNING`
support, generated columns), the divergence is recorded in `05-database.md § 2.9` and covered
by a test, not discovered by a user (`Q49`).

Adding the value is the _small_ part of this ADR. The rest is the semantics the value drags
with it.

### 2. The client is supplied by the application, exactly as for Postgres

`@tsir/database/mysql` ships an **adapter**, not a bundled client. It accepts a structural
`MysqlClientLike` — `query`, `execute`, `getConnection`, `end` — and the application passes a
`mysql2` pool (`mysql2/promise`), a Hyperdrive-bound pool in a Worker, or a PlanetScale
serverless client. The reasons are ADR-0009's, unchanged:

- `mysql2` is CommonJS with a Node-shaped surface; bundling it would be an exception to
  ADR-0012 that every future dependency could cite.
- Drizzle's own MySQL integration takes a user-supplied `mysql2` connection
  ([Drizzle MySQL][drizzle-mysql]), so bundling would put Tsir in a different position from
  the ORM it wraps.
- Hyperdrive requires `mysql2@>=3.13.0` and `nodejs_compat`, which is a _deployment_ fact
  about the application, not something the framework can silently satisfy
  ([Hyperdrive + Drizzle][hyperdrive-drizzle]).

### 3. Capabilities belong to the transport, not to the engine

This is the ADR-0019 split applied to a new engine, and it is why the registry was built
generic over the engine in the first place:

| Transport                         | Engine | `interactiveTx` | `pinnedConnection`   | `batch` (atomic)          |
| --------------------------------- | ------ | --------------- | -------------------- | ------------------------- |
| `mysql2` pool (Bun, Lambda)       | mysql  | ✅              | ✅ (`getConnection`) | ✅ via transaction        |
| `mysql2` over Hyperdrive (Worker) | mysql  | ✅              | ✅                   | ✅ via transaction        |
| PlanetScale serverless (HTTP)     | mysql  | ❌              | ❌                   | ❌ statement-by-statement |
| D1 binding                        | d1     | ❌              | ❌                   | ✅ native `batch()`       |

"MySQL has transactions" is true and useless: the serverless HTTP transport does not, and a
framework that assumes one capability set per engine will hand a PlanetScale user an
`interactiveTx` that throws at request time. The driver declares; boot checks; nothing is
inferred from the engine name.

### 4. `batch()` is a transaction on MySQL, and says so

MySQL has no multi-statement atomic primitive of its own. `batch([...])` is therefore
implemented as `BEGIN … COMMIT`, which _is_ atomic — so the capability stays `true` and the
semantics match D1's native `batch()`. On a transport without transactions (PlanetScale
serverless) the capability is `false`, `batch()` throws `DB_BATCH_UNSUPPORTED`, and the
caller is told to use a transaction or a different connection.

Two round trips instead of one is a performance note, not a correctness one; the framework
says "atomic", and atomic is what the caller gets.

### 5. DDL is never atomic on MySQL, and the runner reports it

`CREATE`, `ALTER`, `DROP`, `RENAME` and `TRUNCATE` cause an implicit commit before and after
execution ([implicit commit][mysql-implicit-commit]). Consequences, all of which the applier
must express:

- `MigrateResult.applied[].atomic` is **`false`** for any file whose statements include DDL,
  even when the file declares `-- tsir:transaction=on`. The header is not a lie detector; the
  engine's behaviour wins, and the report says what actually happened.
- The runner **warns** when a DDL-bearing file declares `transaction=on`: the declaration
  cannot be honoured, and the operator should know before a partial apply, not after.
- The pre-flight text (`MIG-011`) gains a MySQL-specific line: "this migration contains DDL;
  MySQL commits it implicitly, so a failure leaves the schema half-applied".
- The rollback guidance is unchanged and now load-bearing: a down file is the _only_ recovery
  path for a MySQL DDL migration, because there is no transaction to roll back.

The DDL detector is deliberately shallow — leading keywords of each statement — because a
parser that pretends to understand MySQL DDL is a worse failure than a false positive that
prints one extra warning.

### 6. Advisory locks: `GET_LOCK`, scoped to the server, keyed with the database name

`MIG-003`'s `pg_try_advisory_lock` has an exact analogue: `GET_LOCK(name, 0)` /
`RELEASE_LOCK(name)` ([locking functions][mysql-locks]). Both are session-scoped, so the
`DB-018` pinned scope is mandatory for the same reason, and `lockVerified` means the same
thing.

Two differences the implementation must carry:

- **The namespace is the server, not the database.** Two applications sharing one MySQL server
  share the lock namespace. The key therefore hashes `<applicationName>|<database>` — the
  database name comes from the connection, not from the operator's memory.
- **Names are capped at 64 characters.** The key is `tsir:<16 hex of the FNV-1a hash>`, not a
  raw application name: a long, human-readable name would be silently truncated by the server
  and two applications would collide on the truncation.

`GET_LOCK(name, 0)` is the non-blocking form; the bounded-wait loop stays in the framework
(one round trip per attempt), so the timeout semantics are identical to Postgres and testable
without a server.

### 7. Journal, sidecar and placeholders are unchanged

ADR-0007 holds across dialects: `meta/_journal.json`, `__drizzle_migrations`
(`id`, `hash`, `created_at`), identity by `when`, drift by `sha256`. What changes is SQL
syntax, not policy:

| Concern      | Postgres                       | MySQL                                                    |
| ------------ | ------------------------------ | -------------------------------------------------------- |
| Placeholder  | `$1`                           | `?`                                                      |
| Journal DDL  | `"id" serial primary key`      | `` `id` int auto_increment primary key ``                |
| Identifier   | `"double quoted"`              | `` `backticked` ``                                       |
| `created_at` | `bigint`                       | `bigint` (mysql2 returns it as a string, not a `bigint`) |
| Lock         | `pg_try_advisory_lock(bigint)` | `GET_LOCK('tsir:…', 0)`                                  |

`bind()` already keys on the engine; `mysql` joins `d1` on `?`. The `created_at` row is the
one place the coercion guard earns its keep: mysql2 hands `bigint` back as a **string**, and
`when` is the join key — a silent `NaN` there would report every migration as pending.

### 8. What is refused rather than emulated

- **`searchPath`** — a MySQL "schema" is a database, and switching databases per statement is
  a different connection. A `mysql` connection declaring `searchPath` fails at boot
  (`CFG_UNSUPPORTED_CONNECTION_OPTION`) instead of silently ignoring it.
- **Schema-qualified table names** (`TableNames.schema`) — refused for `mysql` for the same
  reason. Cross-database queries are a connection choice (ADR-0019), which is where they
  belong.
- **`RETURNING`-shaped APIs** — `insert(...).returning(...)` is Postgres-only in Drizzle's
  MySQL dialect; Tsir does not emulate it with `LAST_INSERT_ID()` guesses. Where Tsir offers a
  helper that assumes `RETURNING` (the optimistic-concurrency update), the helper reports
  `DB_UNSUPPORTED_ENGINE` on MySQL rather than returning a possibly-stale row count.
- **Single-statement-only mode** — `multipleStatements: true` is refused in the adapter's
  connection options, because Hyperdrive does not support multi-statement queries and because
  a migration runner that can send several statements is a SQL-injection amplifier.

### 9. `JSON` is a string at the codec boundary

mysql2 returns `JSON` columns as parsed objects by default. The codec seam (`DB-010`) must
remain the only place a payload is decoded, so the adapter requires `jsonStrings: true`:
columns arrive as text, codecs decode, and the rollback path does not have to un-parse an
object that was already half-parsed. This is the same rule as `13-observability.md` and
`05-database.md § 2.5`: no implicit parse of unknown payloads.

### 10. Where this sits in the roadmap

MySQL is a **Phase 3 extension**, not a gate item. Gate P3 stays D1 + Postgres, because a gate
that waits on a third engine delays the two that are already promised. The tasks below
(`DB-023` … `DB-026`, `MIG-016`) are `[ ]`, and CI gains a MariaDB service only when `DB-025`
lands — an integration suite nobody runs is a claim, not a test.

## Consequences

**Positive**

- Adoption stops requiring an engine migration. A team with an existing MySQL database gets
  migrations, seeders, capability checks and the same migration safety rails.
- The ADR-0019 registry is validated by its second consumer: nothing in it assumed two
  engines, and this ADR is the test of that claim.
- Workers + Hyperdrive + MySQL becomes a supported topology, which D1 alone could not offer
  (no D1 from Lambda, no Postgres-adjacent vendor lock).

**Negative / costs**

- A fourth capability matrix to keep honest, and a transport (PlanetScale serverless) that
  silently lacks transactions if someone forgets to check.
- `atomic: false` on every DDL migration is a real ergonomic loss — the honest report makes
  routine schema changes look dangerous, because on MySQL they are.
- CI grows a database service; the integration job's runtime roughly doubles.
- Documentation surface: `05-database.md`, `src/docs/migrations.md` and the CLI help all gain an
  engine axis.

## Alternatives rejected

| Alternative                                       | Why not                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Support MySQL by "just adding an enum value"      | Hides the implicit-commit and lock-namespace differences until production. The ADR exists because the semantics, not the type, are the work. |
| Bundle `mysql2` in `@tsir/database`               | Violates ADR-0012 for exactly the reason ADR-0009 rejected bundling `pg`; also diverges from Drizzle's own contract.                         |
| Treat MariaDB as a separate engine                | Same protocol, same dialect, one CI target. A second enum value would imply differences that mostly do not exist.                            |
| Emulate `RETURNING` with `LAST_INSERT_ID()`       | Returns a plausible lie under concurrency and replication lag. Refusing is cheaper than being wrong once.                                    |
| Use `execute()` (binary protocol) over Hyperdrive | Hyperdrive does not support protocol-level prepared statements; `query()` is the supported path.                                             |
| Route MySQL through a generic SQL abstraction     | That is the Eloquent-style layer ADR-0016 already rejected; Drizzle owns SQL generation, per dialect.                                        |

[hyperdrive-db]: https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/
[hyperdrive-mysql]: https://developers.cloudflare.com/changelog/post/2026-08-07-hyperdrive-mysql-ga/
[hyperdrive-drizzle]: https://developers.cloudflare.com/hyperdrive/examples/connect-to-mysql/mysql-drivers-and-libraries/drizzle-orm/
[drizzle-mysql]: https://orm.drizzle.team/docs/get-started/mysql-new
[drizzle-migrate]: https://orm.drizzle.team/docs/mysql/drizzle-kit-migrate
[mysql-implicit-commit]: https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html
[mysql-locks]: https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html
