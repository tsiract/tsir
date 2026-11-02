# Migrations & seeders runbook

Everything `tsir migrate`, `tsir migrate:status`, `tsir migrate:rollback`,
`tsir migrate:verify`, `tsir make:migration` and `tsir db:seed` do, and what to do
when one of them refuses.

The commands print `runbook: docs/migrations.md` before a production run; this is
the page that line points at.

---

## 1. The shape of a migration folder

```
drizzle/
├── meta/
│   └── _journal.json        # drizzle-kit's ordered list: idx, when, tag
├── 0000_init.sql            # the migration itself
├── 0000_init.down.sql       # optional: only `migrate:rollback` uses it
└── 0001_add_roles.sql
```

- The journal is the order. A file missing from it is not applied.
- The **key is `when`**, not the tag or the index — that is what
  `__drizzle_migrations` stores, and it is what makes an applied migration
  recognisable across a rename.
- `paths.migrations` in `tsir.js` points somewhere else if you do not want
  `drizzle/`.

Two columns of state live in the database:

| Table                   | Written by               | Holds                                                                        |
| ----------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `__drizzle_migrations`  | Drizzle's own convention | `hash`, `created_at` — the checksum and the `when` of each applied migration |
| `__tsir_migration_runs` | Tsir (`MIG-004`)         | `run_id`, `tag`, `checksum`, `host`, `actor`, `duration_ms`, `applied_at`    |

The second one exists because the first one answers "what ran" and not "who ran it
and how long it took". A migration that took four minutes in production is a fact
you want next time, and it is not recoverable from a timestamp pair.

## 1.1 Module journals and multiple connections

Modules can own their own Drizzle journals, separate from the project-wide journal:

```text
shop/
├── models/order.model.ts
├── seeders/order.seeder.ts
└── migrations/
    ├── 0000_create-orders.sql
    ├── meta/_journal.json
    ├── meta/0000_snapshot.json
    └── reporting/              # only for a non-default connection
        └── meta/_journal.json
```

For project-wide migrations, `paths.migrations` is a **string** (default `drizzle`).
The default connection uses that folder; a non-default connection uses a subfolder such as
`drizzle/reporting`. Module migrations use `<module>/migrations/` for the default
connection and `migrations/<connection>/` for another connection. Export a named `databases`
registry from the app entry before using `--connection`:

```sh
tsir migrate shop --connection reporting
tsir migrate:status shop --connection reporting
tsir db:seed --connection reporting --reference-data
```

Each module/connection journal has separate database bookkeeping tables; their stable names are
hashed from the module and connection names. The project-wide journal keeps its existing tables.
Keep module and connection names stable after deployment: renaming either changes the bookkeeping
identity and can cause previously applied work to appear pending. Use Tsir to apply module journals;
a plain `drizzle-kit migrate` uses different bookkeeping and must not be mixed with Tsir for them.
All journals for the same named connection use the same migration advisory lock on PostgreSQL.
D1 has no advisory lock: run only one migration process at a time. As always, PostgreSQL locking
is only verified when the client supports a pinned session.

There is **no automatic cross-module ordering, dependency discovery, or migrate-all command**.
Choose and enforce an order when modules have foreign keys or other dependencies. Roll back in
reverse dependency order. Avoid having multiple journals manage the same tables. Review each SQL
file and plan before applying it; a snapshot is not evidence that a live database matches it.

## 2. The per-migration transaction header

By default each migration is atomic: its statements and its journal row commit or
roll back together. On D1 that means one `batch()`; on Postgres, one transaction.

> **MySQL/MariaDB (planned, ADR-0020).** MySQL commits implicitly around DDL, so a
> migration that creates or alters a table can never be atomic. When that engine
> ships, such a file reports `atomic: false` even if it declares
> `-- tsir:transaction=on`, and the down file is the only way back.

Some statements cannot run inside a transaction at all — `CREATE INDEX
CONCURRENTLY` is the common one. Those files declare it:

```sql
-- tsir:transaction=off
create index concurrently "users_email_idx" on "users" ("email");
```

- The header must be the first line of the file.
- `tsir migrate` prints a warning and marks the migration `atomic: false` in its
  output, because a failure halfway through leaves the schema between two
  versions and the runbook step is then "inspect the schema", not "retry".
- `migrate:rollback` will not undo a non-atomic migration unless it has a `.down.sql`.

## 3. Commands

### `tsir make:migration <name> <module>`

From an application created by `tsir new`:

```sh
tsir make:module shop
tsir make:model order shop
bun add drizzle-orm@0.45.4
bun add -d drizzle-kit@0.31.11
tsir make:migration create-orders shop
```

The module must already exist. This runs `drizzle-kit generate` against
`shop/models/*.model.ts` and writes its SQL, snapshot and journal under
`shop/migrations/`. It does **not** connect to a database or apply SQL. The name is a
lowercase hyphen- or underscore-separated tag; Drizzle supplies the numeric prefix. Check the SQL,
snapshot and journal into version control together. An unchanged schema produces no new migration.

SQLite/D1 is the default. For a PostgreSQL model, use `--dialect postgres`. Select a module-local
schema file or glob with `--schema shop/models/order.model.ts`; use this when a module has
separate schemas for different databases or dialects. Keep the same complete schema scope for
subsequent generations of a journal: dropping files from the scope can generate destructive DROP
statements. Do not mix dialects or manage the same tables in multiple journals. Tsir checks the
existing journal's dialect but cannot infer your intended schema ownership.

To generate for a non-default named connection, add `--connection reporting`; the app must export
its connection registry. Use the same connection option when running the migration.

The legacy `tsir make:migration <name>` remains project-wide and delegates to the app's
`drizzle.config.ts` and `paths.migrations`. It does not infer a module. The project must configure
Drizzle's output to the same folder as `paths.migrations`. Tsir lints generated SQL for empty files,
missing trailing newlines and duplicate transaction headers.

### Run a module journal

After configuring and exporting the app's `database` or `databases` (see the
[database guide](./guides/database.md)), review the migration, then:

```sh
tsir migrate:status shop
tsir migrate shop --dry-run
tsir migrate shop
# On a separate, throwaway database only:
tsir migrate:verify shop
```

`migrate`, `migrate:status`, `migrate:verify` and `migrate:rollback` accept the module as their
positional argument. Omitting it selects the existing project-wide journal, not all modules.
`verify` checks that the **selected journal** has no applied rows; it does not prove that the
entire database is empty, so always supply a throwaway database yourself. Rollback still needs a
hand-written down file and explicit destructive confirmation:

```sh
tsir migrate:rollback shop --to empty --allow-destructive --confirm 0000_create-orders
```

### `tsir migrate [module] [--dry-run] [--wait <ms>]`

Applies every pending migration in journal order.

- `--dry-run` reads the journal and the database and prints what _would_ run. It
  writes nothing, not even the journal table.
- `--wait` bounds how long a second runner waits for the advisory lock. With no
  `--wait`, a locked runner reports and exits `0`.
- Drift is checked **before** the first statement: if an applied migration changed
  on disk, nothing runs.

### `tsir migrate:status [module] [--json]`

Prints applied, pending and drifted tags. Exits non-zero when anything drifted or
when applied rows have no file on disk (orphans) — a green status that only looks
at pending migrations is how drift reaches production.

### `tsir migrate:verify [module]`

Applies the selected journal to a **throwaway, empty** database. This is the CI
command: if it fails, `0000 → head` no longer applies cleanly. The command rejects a
selected journal that already has applied rows, but does not detect unrelated tables or
other journals. Ensure the database really is disposable before running it.

### `tsir migrate:rollback [module] --to <tag> [--allow-destructive] [--confirm <tag>]`

Undoes migrations newest-first until `--to` is the head, using `<tag>.down.sql`.

Three guards, all of them deliberate:

1. every migration being undone must have a `.down.sql` — Tsir will not invent one;
2. `--allow-destructive` must be passed explicitly;
3. `--confirm` must equal the **newest** tag being undone — typing it back is the
   difference between a considered action and a paste.

### Generate a module seeder

```sh
bun add '@tsir/seed@workspace:*'
tsir make:seeder order shop
```

This creates `shop/seeders/order.seeder.ts` exporting `OrderSeeder`, and a companion test that
fails until replaced. The seeder starts as a no-op: implement idempotent inserts and test them.
Import it in the app entry and export the `seeders` array; discovery is not automatic:

```ts
// Add to app.ts, alongside the app's existing database export.
import { OrderSeeder } from './shop/seeders/order.seeder.ts';
export const seeders = [OrderSeeder];
```

Then run `tsir db:seed --class OrderSeeder` after configuring the app's database. A seeder without
an explicit module is still generated under `seeders/` for compatibility. Use `--order 10` to
control ordering; duplicate orders are refused. `--reference` marks intentional reference data,
and production additionally requires `--reference-data` at execution time.

### `tsir db:seed [--class A,B] [--all] [--reference-data]`

Runs seeders exported from the application entry:

```ts
// app.ts
export const seeders = [RolesSeeder, UsersSeeder];
```

- Seeders run in `order`; ties are an error before anything is inserted, not a
  coin flip.
- `--class` selects by name; an unknown name lists what is available.
- Development fixtures never run in production. `db:seed` refuses production
  outright unless `--reference-data` is passed **and** the seeder declares
  `production: true`.
- A seeder runs in a transaction when the engine has one. On D1 it does not, and
  the output says `atomic: false` rather than implying otherwise.

## 4. Concurrency: the advisory lock is a session, not a flag

Postgres excludes a second runner with `pg_try_advisory_lock`, keyed off the
application name. That lock is **session-scoped**, so it only protects anything if
the migration statements run on the _same connection_ that took it.

> **MySQL/MariaDB (planned, ADR-0020).** `GET_LOCK` replaces the Postgres function.
> Its namespace is the _server_, not the database, so the key will include the
> database name — two applications on one MySQL server must not share a lock.

`@tsir/migrate` pins that connection (`Database.pinned()`, `DB-018`) whenever
the driver can reserve one. If it cannot — a client without `reserve()` — the run
still applies migrations, but `migrate` reports `lockVerified: false` and the CLI
prints:

```
! the advisory lock was not pinned to one connection, so concurrent runners were not excluded
```

Treat that warning as a defect in the deployment, not as noise: two deploys racing
each other will both see "not applied" and both run the DDL.

D1 has no advisory lock at all. `lockSupported: false` says so, and the mitigation
is procedural: run migrations from exactly one place (the migrate unit, `MIG-012`).

## 5. Deploy sequence

1. `tsir migrate:status` in CI against a restored copy, or `migrate:verify` against
   an empty database. Both are cheap; both catch a broken journal.
2. Snapshot / PITR window verified (MIG-011 prints this checklist on a production
   run and refuses to pretend it is decoration).
3. Deploy the migrate unit — the code path that runs `migrate()` exactly once,
   before the application version that needs the new schema.
4. Deploy the application.
5. Seed reference data separately (`db:seed --reference-data`) when the release is
   a data release. Never as part of step 3.

Rollbacks are the same list in reverse, with the guard from § 3: a down migration
that was written when the migration landed, not one invented under pressure.

## 6. Troubleshooting

| Symptom                            | Cause                                                       | Fix                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DB_MIGRATION_DRIFT`               | an applied file changed on disk                             | revert the file, or write a new migration that corrects it                                                      |
| `DB_MIGRATION_FAILED`              | a statement failed                                          | the error names the statement index; the transaction was rolled back unless the file set `tsir:transaction=off` |
| `migrate` exits 0 and does nothing | another runner holds the lock                               | expected with `--wait`; check `__tsir_migration_runs` for who is running                                        |
| `migrate:verify` exits 3           | the target database is not empty                            | point `DATABASE_URL` at a throwaway database                                                                    |
| `DB_ROLLBACK_UNSAFE`               | a migration has no `.down.sql`                              | write it, or roll forward with a new migration                                                                  |
| `SED_PRODUCTION_REFUSED`           | seeding production without `--reference-data`               | reference data only; development fixtures stop at staging                                                       |
| `SED_NOT_IDEMPOTENT`               | a seeder declared `idempotent: true` and changed row counts | use an upsert (`onConflictDoNothing`) or drop the claim                                                         |
| `DB_CONNECTION_PIN_UNSUPPORTED`    | the client cannot reserve a connection                      | pass a client built by `postgres.js`, or Bun's `SQL`                                                            |

## 7. Testing migrations

`@tsir/migrate` runs every migration inside a transaction where the engine allows
it, so an integration test can apply the journal, assert, and roll back without
cleaning up. The suites in this repository do exactly that against a real server
(`make test-integration`, which skips cleanly when `DATABASE_URL` is unset) and
against a fake driver in the unit tests.
