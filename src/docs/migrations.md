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

## 1.1 Multiple connections

A project with more than one database connection has more than one migration folder:

```
drizzle/
├── app/                    # connection `app` — the default
│   ├── meta/_journal.json
│   └── 0000_init.sql
└── reporting/              # connection `reporting`
    ├── meta/_journal.json
    └── 0000_init.sql
```

`paths.migrations` in `tsir.js` is one folder for a single-connection project, or a
map keyed by connection name for a multi-connection one (ADR-0019). Every command
takes `--connection <name>` — default `database.default` — and prints the connection
it is about to change before it changes it:

```bash
tsir migrate --connection=reporting
tsir migrate:status --connection=reporting
tsir db:seed --connection=reporting --reference-data
```

The journal, the `__tsir_migration_runs` sidecar and the advisory lock key are all
per connection, so `app` and `reporting` can be migrated concurrently by different
units without contending for one lock. There is no implicit "migrate everything":
a multi-connection deploy runs one `migrate:<connection>` unit per connection
, because a replica that is behind must not block the
primary's release.

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

### `tsir make:migration <name>`

Wraps `drizzle-kit generate`, then lints what it produced: an empty file (drizzle-kit
writes one when the schema did not change), a missing trailing newline, or two
transaction headers. The name becomes the file tag, so it must be
`snake_case`-shaped — `AddUserRoles` and `add user roles` are rejected before
drizzle-kit runs.

### `tsir migrate [--dry-run] [--wait <ms>]`

Applies every pending migration in journal order.

- `--dry-run` reads the journal and the database and prints what _would_ run. It
  writes nothing, not even the journal table.
- `--wait` bounds how long a second runner waits for the advisory lock. With no
  `--wait`, a locked runner reports and exits `0`.
- Drift is checked **before** the first statement: if an applied migration changed
  on disk, nothing runs.

### `tsir migrate:status [--json]`

Prints applied, pending and drifted tags. Exits non-zero when anything drifted or
when applied rows have no file on disk (orphans) — a green status that only looks
at pending migrations is how drift reaches production.

### `tsir migrate:verify`

Applies the whole journal to a **throwaway, empty** database. This is the CI
command: if it fails, `0000 → head` no longer applies cleanly, and nobody finds out
during a deploy. A database that already has migrations in it is a usage error
(exit `3`), not a job to do.

### `tsir migrate:rollback --to <tag> [--allow-destructive] [--confirm <tag>]`

Undoes migrations newest-first until `--to` is the head, using `<tag>.down.sql`.

Three guards, all of them deliberate:

1. every migration being undone must have a `.down.sql` — Tsir will not invent one;
2. `--allow-destructive` must be passed explicitly;
3. `--confirm` must equal the **newest** tag being undone — typing it back is the
   difference between a considered action and a paste.

### `tsir db:seed [--class A,B] [--all] [--reference-data]`

Runs seeders exported from the application entry:

```ts
// src/app.ts
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
