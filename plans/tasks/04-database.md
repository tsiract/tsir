# Tasks — Database (Phase 3)

> Drizzle integration, D1-first drivers, non-interactive transaction model,
> migrations, seeders.

**Plan:** [`../05-database.md`](../modules/05-database.md) ·
**ADRs:** [0016](../decisions/0016-cloudflare-first-and-d1.md) (D1 default, Postgres selectable), [0019](../decisions/0019-multi-connection.md) (named connections), [0020](../decisions/0020-mysql-engine.md) (MySQL/MariaDB), 0007 (Drizzle journal), 0009 (Postgres transport, open)

> **Revised 2026-10-28.** This file predated ADR-0016 and described Postgres as
> the default with D1 explicitly unsupported. That is the opposite of the decision:
> **D1 is the default**, Postgres is a selectable engine, and the whole framework
> is written against D1's _non-interactive_ transaction baseline. The task list
> below is rewritten to match; the old rows are kept only where they still apply.

---

## Gate P3 review — 2026-10-28

Criteria from [`../01-roadmap.md § Phase 3`](../roadmap/01-roadmap.md). Each one is checked against the
repository, not against the plan.

| #   | Criterion                                                                                                       | Result                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Boots against local D1 **and** a real Postgres; health reports connectivity + latency                           | ✅ `database/src/boot.test.ts` (D1) · `database/src/postgres.integration.test.ts` health test (Postgres 17.11)                                                                                                                                                       |
| 2   | `withTransaction` nesting through savepoints, context propagation, leak detection                               | ✅ `transaction.test.ts` + integration nesting/leak tests                                                                                                                                                                                                            |
| 3   | `migrate`, `migrate:status`, `migrate:rollback` on Drizzle's journal, advisory lock excludes concurrent runners | ✅ MIG-013: 50 migrations, two concurrent runners, each applies exactly once — green against real Postgres. Lock is pinned (`DB-018`) and keyed per connection (`MIG-015`); `lockVerified: false` when the client cannot reserve, never a silent pass                |
| 4   | Seeders deterministic and idempotent where declared                                                             | ✅ fixed clock + seeded RNG; `assertIdempotent` runs a seeder twice and fails `SED_NOT_IDEMPOTENT` on drift                                                                                                                                                          |
| 5   | Integration suites against ephemeral D1 and ephemeral Postgres with parallel-safe isolation                     | ✅ `createTestDatabase` (`DB-016`) gives each suite its own schema; the Postgres suite runs in CI with a `postgres:17` service container and skips cleanly without `DATABASE_URL`                                                                                    |
| 6   | Named connections (ADR-0019) end to end                                                                         | ✅ `DB-019` registry + `pinned()` rename · `DB-020` per-connection requirements · `DB-021` lifecycle/health/`db.connection` dimension · `MIG-015` per-connection journals, lock key and `--connection` · `SED-011` seeder connection declarations · `DB-022` harness |
| 7   | MySQL/MariaDB is explicitly **not** a gate item                                                                 | ✅ ADR-0020; `DB-023` … `DB-026` and `MIG-016` remain `[ ]` by decision                                                                                                                                                                                              |

**Deferred by design, not by omission**

- `DB-010` is `[x]` as of 2026-10-28 — closed by `VLT-008` in Phase 4, exactly as this plan
  said it would be. The `@tsir/database` frontpage card stays `partial` for the other open
  rows (`DB-022` harness, `DB-025`/`DB-026` MySQL), not for the codec.
- `MIG-012` (`[x]` as of 2026-10-28) — closed by `DPL-021`: a journaled connection becomes a
  `migrate:<connection>` unit, emitted as a script with no exports (`dist/migrate/<name>/`),
  runnable once per deploy and structurally impossible to invoke on cold start.

**Measured at review time** (Postgres 17.11 on `127.0.0.1:55432`): `bun test` **648 pass / 0 fail
/ 1832 expect() / 46 files**; `make coverage` 9/9 packages ≥ 90 % (database 95.28 %, migrate
96.48 %, seed 99.78 %); `make check` green (425 exports, 59 doc files, `VLD-007`).

**Verdict:** Gate P3 **closed** 2026-10-28. Phase 4 (vault) is next.

---

## Database (`@tsir/database`)

| ID       | Title                                                       | Status | Depends          | Acceptance criteria (summary)                                                                                                                                           |
| -------- | ----------------------------------------------------------- | ------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB-001` | Driver contract (`query`, `batch`, `transaction`, `health`) | `[x]`  | CTN-002          | Capabilities declared per driver; one file per driver                                                                                                                   |
| `DB-002` | Drizzle binding for D1 (`drizzle-orm/sqlite-proxy`)         | `[x]`  | DB-001           | `sqliteTable` query through the driver, typed rows                                                                                                                      |
| `DB-003` | Config schema (`driver`, `logging`, limits)                 | `[x]`  | CFG-001          | Invalid driver or pool max → boot error                                                                                                                                 |
| `DB-004` | `Database` contract + singleton provider + disposal         | `[x]`  | DB-001           | Shutdown drains in-flight work then closes; no leaked handles                                                                                                           |
| `DB-005` | `batch([...])` atomic multi-statement write                 | `[x]`  | DB-002           | N statements → one transaction on D1, one round trip                                                                                                                    |
| `DB-006` | `interactiveTx` capability gate                             | `[x]`  | DB-001           | `transaction()` on D1 → `DB_TX_INTERACTIVE_UNSUPPORTED`, never a silent BEGIN                                                                                           |
| `DB-007` | `requires: { interactiveTx: true }` boot check              | `[x]`  | DB-006           | Declaring it on D1 fails at boot with the fix, not at request time                                                                                                      |
| `DB-008` | Health check (`SELECT 1` + driver counters)                 | `[x]`  | DB-001           | Exposed to readiness; degraded state does not crash the process                                                                                                         |
| `DB-009` | Query logging with redaction                                | `[x]`  | DB-001           | `logging: 'all'` prints placeholders + parameter types only                                                                                                             |
| `DB-010` | Codec integration point (`codec.ts`) for vault              | `[x]`  | DB-002           | `encryptedText` column round-trips (with VLT-008)                                                                                                                       |
| `DB-011` | Optimistic concurrency helper (`WHERE version = ?`)         | `[x]`  | DB-002           | Lost-update test: two writers, one wins, one retries once                                                                                                               |
| `DB-012` | Postgres driver (`postgres.js`) + transport rules           | `[x]`  | DB-001           | Works on Bun; `max: 1` enforced on Lambda per deploy target                                                                                                             |
| `DB-013` | Postgres interactive transactions + savepoints              | `[x]`  | DB-012           | Retry only on `40001`/`40P01` and only when `idempotent: true`                                                                                                          |
| `DB-014` | Hyperdrive transport for Workers-Postgres                   | `[x]`  | DB-012           | Binding passed through, never a connection string in the Worker                                                                                                         |
| `DB-015` | Capability probe + `DB_DRIVER_UNAVAILABLE`                  | `[x]`  | DB-001           | Choosing an engine the target cannot reach fails with the reason                                                                                                        |
| `DB-016` | `createTestDatabase` harness (per-suite isolation)          | `[x]`  | DB-002           | Parallel suites do not interfere                                                                                                                                        |
| `DB-017` | Documented guarantees: TS vs runtime vs DB constraint       | `[x]`  | DB-001           | `05-database.md § 2` table matches what the code actually enforces                                                                                                      |
| `DB-018` | `Database.pinned()`: pinned connection (`reserve()`)        | `[x]`  | DB-001           | Session-scoped state (advisory locks) and the work share one connection                                                                                                 |
| `DB-019` | Connection registry: `database.connections` + `default`     | `[x]`  | DB-018           | `db.connection('typo')` → `DB_UNKNOWN_CONNECTION`; names are a literal type; `DB-018`'s pin is renamed `pinned()`                                                       |
| `DB-020` | Per-connection capabilities + boot requirements             | `[x]`  | DB-019           | `requires: { database: { connection, interactiveTx } }` fails at boot with both names                                                                                   |
| `DB-021` | Per-connection lifecycle, health, observability             | `[x]`  | DB-019           | Drain all connections under one deadline; health per connection with `required`; every log/span carries `db.connection`                                                 |
| `DB-022` | Multi-connection test harness                               | `[x]`  | DB-019           | `createTestDatabase({ connection })`; a two-connection suite needs no registry                                                                                          |
| `DB-023` | MySQL driver adapter (`@tsir/database/mysql`)               | `[ ]`  | DB-001, ADR-0020 | App-supplied `mysql2` pool, `query()` not `execute()`; capabilities per transport (serverless HTTP has no transactions)                                                 |
| `DB-024` | MySQL refusals and codec rules                              | `[ ]`  | DB-023           | `searchPath`, schema-qualified names and `RETURNING` helpers fail loudly; `jsonStrings: true` enforced                                                                  |
| `DB-025` | MySQL/MariaDB integration suite in CI                       | `[ ]`  | DB-023, MIG-016  | `mariadb:11` service: migrate from zero, drift, rollback, `GET_LOCK` concurrency                                                                                        |
| `DB-026` | `tsir bootstrap` detection + MySQL docs                     | `[ ]`  | DB-023           | `mysql://` URL scaffolds a `mysql` connection; § 2.9 divergence table stays current                                                                                     |
| `DB-027` | Pessimistic locking (`lockForUpdate`)                       | `[ ]`  | DB-012, DB-018   | `select().forUpdate()` inside a transaction on Postgres; refused on D1 (no row-level locks) with `DB_LOCK_UNSUPPORTED`; a held lock blocks other `forUpdate` reads      |
| `DB-028` | Pagination (`paginate`)                                     | `[ ]`  | DB-002           | `paginate(page, perPage)` returns `{ data, total, page, perPage, lastPage }`; cursor pagination as `paginateCursor(cursor, perPage)`; works with Drizzle query builders |

Notes on the items not yet `[x]`:

- `MIG-012` was the one deploy-shaped row here, and it closed with `DPL-021` (2026-10-28):
  the emitted script calls the same `migrate()` the CLI does, so the idempotence and
  lock-verified behaviour the concurrency test proves is what runs in a deploy.
- `DB-023`…`DB-026` and `MIG-016` are the MySQL block and they all depend on the same missing adapter:
  `@tsir/database/mysql` does not exist. They are **not** independently schedulable, and the Postgres
  correctness work in [`16-infrastructure-hardening.md`](./16-infrastructure-hardening.md)
  (`INF-001`, `INF-003`) must land first — a MySQL adapter written before the `$1`/`?` placeholder
  discipline is proven would reproduce the same class of bug with a different placeholder.
- `DB-018` was not in the original list; it exists because `MIG-003` is unsound
  without it. `pg_try_advisory_lock` is session-scoped, so on a pooled client the
  lock and the DDL can land on different connections — a lock that excludes
  nothing. `Database.connection()` pins one connection via `reserve()`, `migrate`
  and `rollback` run inside it, and when a client cannot reserve the run reports
  `lockVerified: false` and the CLI warns instead of pretending.
- `DB-023` … `DB-026` and `MIG-016` implement [ADR-0020](../decisions/0020-mysql-engine.md)
  (MySQL/MariaDB). They are a **Phase 3 extension**: Gate P3 still closes on D1 + Postgres,
  because a gate that waits on a third engine delays the two already promised. The expensive
  part is the honesty, not the dialect: MySQL commits DDL implicitly, so a migration that
  creates a table is never atomic and the result must say `atomic: false` rather than inherit
  the header's claim.
- `DB-019` … `DB-022` implement [ADR-0019](../decisions/0019-multi-connection.md) (named
  connections, 2026-10-28). `DB-019` **renames** `DB-018`'s `Database.connection(fn)` to
  `Database.pinned(fn)` — `connection(name)` is now the registry selector — which touches
  `migrate`, `rollback` and two integration tests; there are no released consumers, so it is a
  mechanical change inside `DB-019` rather than a separate breaking-change task. The registry type
  must stay generic over the engine (`ConnectionConfig<E>`), so a `mysql` entry can exist without
  this task encoding today's two-value union into the public surface (`Q14`).
- `MIG-015` shipped as: `migrationFolder(root, connection, …)` puts every non-default
  connection in its own folder (`migrations/<name>`), the advisory lock key hashes
  `${application}:${connection}` so two connections never exclude each other, every
  result carries `connection`, and `migrate` / `migrate:status` / `migrate:verify` /
  `migrate:rollback` / `db:seed` accept `--connection` (refused with exit 2 when the
  entry exports no registry). Still open, under `SED-011`: a seeder declaring _which_
  connections it may touch.
- `DB-021` is `[x]` (verified 2026-10-28, row was stale): `createConnections()` closes
  `default` first, `health()` reports each connection independently, every log event
  carries `db.connection`, and the shutdown budget is **one deadline for the whole
  registry** — each connection is handed `deadline - now`, so three wedged clients
  cannot turn 5 s into 15 s (`connections.test.ts`, the `budgets` case).
- `DB-010` is `[x]`, closed by `VLT-008` on 2026-10-28. The seam is `codec.ts`
  (async `encodeRow`/`decodeRow`, column identity bound into the codec call);
  `@tsir/vault/drizzle`'s `encryptedText()` marks a Drizzle text column and
  `encryptedColumnsOf()` turns it into `CodedColumn`s. The round-trip is proven
  end-to-end against a real Postgres in `encrypted-column.integration.test.ts`
  (insert → `tsir:v1:` envelope on disk → `decodeRow` → plaintext), including the
  NULL passthrough and the moved-ciphertext refusal. `CodedColumn` gained an
  optional `key` for the one real mismatch: a schema property `taxId` over a column
  `tax_id`. There is still no crypto in `@tsir/database` (`05-database.md § 2.5`);
  `vault` is now a declared dependency of `database`, never the reverse.
- `DB-022` is `[x]` (verified 2026-10-28, row was stale): `createTestDatabase({ connection })`
  names the database it builds, so a suite holding two connections can tell their logs and
  spans apart without constructing a registry (`database.test.ts`,
  "each harness answers to its own connection name").
- `DB-016` ships as `createTestDatabase()` in `@tsir/testing/database` (`05-database.md § 7`).
  `@tsir/testing` may import `@tsir/database` — added to the boundary table with no
  cycle, since `database` never imports the harness. The client stays
  application-supplied: `connect(schema)` is a factory because `search_path` is a
  connection setting, and the harness refuses to rewrite SQL to fake it. `seed()`
  waits for `SED-*`.

## Migrations (`@tsir/migrate`)

| ID        | Title                                            | Status | Depends         | Acceptance criteria (summary)                                                                                                      |
| --------- | ------------------------------------------------ | ------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `MIG-001` | `make:migration` wrapping `drizzle-kit generate` | `[x]`  | DB-002          | File naming + template linted                                                                                                      |
| `MIG-002` | `migrate` applies pending in journal order       | `[x]`  | MIG-001         | Idempotent second run applies nothing                                                                                              |
| `MIG-003` | Advisory lock prevents concurrent runners        | `[x]`  | MIG-002         | Two runners → one applies, other reports in-progress                                                                               |
| `MIG-004` | `__tsir_migration_runs` audit sidecar            | `[x]`  | MIG-002         | Records id, host, actor, duration, checksum                                                                                        |
| `MIG-005` | `migrate:status` (applied/pending/drift)         | `[x]`  | MIG-002         | Exit code non-zero on drift                                                                                                        |
| `MIG-006` | Per-migration transaction policy header          | `[x]`  | MIG-002         | `-- tsir:transaction=off` honoured; warning printed                                                                                |
| `MIG-007` | Failure handling: stop, report, non-zero exit    | `[x]`  | MIG-002         | Partial applier never continues silently                                                                                           |
| `MIG-008` | Checksum drift detection (`DB_MIGRATION_DRIFT`)  | `[x]`  | MIG-005         | Edited applied migration → hard fail                                                                                               |
| `MIG-009` | `migrate:rollback --to` with destructive guard   | `[x]`  | MIG-002         | Requires `--allow-destructive` + typed name                                                                                        |
| `MIG-010` | `migrate:verify` CI command (empty → current)    | `[x]`  | MIG-002         | Runs against ephemeral DB in CI                                                                                                    |
| `MIG-011` | Lock-impact + backup pre-flight guidance output  | `[x]`  | MIG-002         | Printed on every production run                                                                                                    |
| `MIG-012` | Migrate unit in deploy graph (separate topology) | `[x]`  | DPL-004         | One unit per connection with a journal; invokes migrate once                                                                       |
| `MIG-013` | Concurrency test: two runners, 50 migrations     | `[x]`  | MIG-003         | Exactly-once application                                                                                                           |
| `MIG-014` | Migration docs + runbook                         | `[x]`  | —               | Docs page linked from CLI output                                                                                                   |
| `MIG-015` | Per-connection journals + `--connection`         | `[x]`  | MIG-002, DB-019 | Journal, sidecar and lock key are per connection; `paths.migrations` accepts a map; every command prints the connection it changes |
| `MIG-016` | MySQL dialect in the applier                     | `[ ]`  | MIG-002, DB-023 | `?` placeholders, MySQL journal/sidecar DDL, `GET_LOCK` keyed by app+database, DDL files report `atomic: false`                    |

---

## Seeders (`@tsir/seed`)

| ID        | Title                                                             | Status | Depends         | Acceptance criteria (summary)                                                                                                                                     |
| --------- | ----------------------------------------------------------------- | ------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SED-001` | `Seeder` contract (`name`, `order`, `idempotent`, `environments`) | `[x]`  | DB-002          | Type errors on missing members                                                                                                                                    |
| `SED-002` | Runner: ordering, tie detection (`SED_ORDER_AMBIGUOUS`)           | `[x]`  | SED-001         | Ties fail before any insert                                                                                                                                       |
| `SED-003` | Deterministic context (`Clock`, `Random`)                         | `[x]`  | SED-001         | Two runs produce identical rows                                                                                                                                   |
| `SED-004` | Idempotency test harness (run twice, counts stable)               | `[x]`  | SED-002         | Fails for non-idempotent seeders                                                                                                                                  |
| `SED-005` | Transaction per seeder (opt-out justified)                        | `[x]`  | SED-002         | Failure rolls back the seeder only                                                                                                                                |
| `SED-006` | Environment gating + production refusal                           | `[x]`  | SED-001         | `APP_ENV=production` → `SED_PRODUCTION_REFUSED`                                                                                                                   |
| `SED-007` | `--class` selection and `--all`                                   | `[x]`  | SED-002         | Selecting unknown class → clear error                                                                                                                             |
| `SED-008` | Fixture helpers (builders with overrides)                         | `[x]`  | SED-003         | Fixtures are typed and reusable in tests                                                                                                                          |
| `SED-009` | Reference-data vs development-fixture separation                  | `[x]`  | SED-006         | `production: true` only for reference seeders                                                                                                                     |
| `SED-010` | ~~`make seed` target wiring~~                                     | `[x]`  | SED-002         | **Withdrawn by ADR-0031** — seeding is an application verb, so it is `tsir db:seed` in the distribution, not a root target. The wiring it asked for exists there. |
| `SED-011` | `--connection` scoping on seeders                                 | `[x]`  | SED-002, DB-019 | Seeder declares `connections`; undeclared target is refused before the first insert; `ctx.db` is the bound handle                                                 |

---

## Gate P3 checklist

- [x] Real Postgres integration suite green in CI with service container.
      `make test-integration` → 17 tests across `database`, `migrate`, `seed`
      against PostgreSQL 17.6; the `integration` job in `.github/workflows/ci.yml`
      runs the same command with `--require`.
- [x] Transaction nesting, retries, and leak detection tested.
      `database/src/transaction.test.ts` (retry only on `40001`/`40P01` and only
      when `idempotent: true`, savepoint nesting, depth cap, read-only refusal on
      D1) plus the nested-savepoint case against a real server.
- [x] Migration locking proven by concurrency test.
      `MIG-013`: 50 migrations, two runners with separate pools → union of applied
      tags is exactly 50 with no duplicates, and `__drizzle_migrations` holds 50
      rows. Green against PostgreSQL 17.6.
- [x] Seeders deterministic and idempotent (harness enforced).
      `assertIdempotent()` runs a seeder twice and compares row counts
      (`SED_NOT_IDEMPOTENT`); `runSeeders` injects `Clock`/`Random`.
- [x] `db:seed` refuses production without declaration.
      `SED_PRODUCTION_REFUSED` before the first insert; console test covers
      `APP_ENV=production` with and without `--reference-data`.
