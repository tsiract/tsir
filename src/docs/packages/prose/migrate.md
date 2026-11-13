## Example

The migration runner reads a folder of migration files and a journal, and records each file's checksum
when it is applied. The checksum is what stops an applied migration from being edited later. This
example shows the two pure helpers that do that work. Running migrations needs a database, which
`tsir migrate` provides.

```ts
import { checksum, splitStatements } from '@tsir/migrate';

const sql = 'create table users (id integer primary key);\ncreate index users_id on users (id);';

console.log(splitStatements(sql).length, checksum(sql).slice(0, 12));
```

## Failure modes

- `DB_MIGRATION_ENGINE_UNSUPPORTED`: the connection's engine is neither `d1`, `postgres` nor
  `sqlite` — today that means `mysql`, whose migrations are not written yet. Refused before the
  journal is touched, because the alternative is failing on the first insert with some migrations
  already applied.
- `DB_MIGRATION_FAILED`: a statement in a migration failed. If the migration runs in a transaction, the
  transaction was rolled back, so fix the SQL and run the migration again. If `tsir:transaction=off` is
  set, earlier statements may have been applied, so inspect the schema before re-running.
- `DB_MIGRATION_EMPTY`: a migration file contains no statements. Delete the file and its journal entry,
  or write the SQL it was meant to hold.
- `DB_MIGRATION_DRIFT`: an applied migration has changed on disk. Its checksum no longer matches the
  journal. Restore the original file, and add a new migration for the change.
- `DB_MIGRATION_LOCK_UNSUPPORTED`: the engine has no advisory locks, so concurrent runners cannot be
  excluded. Run migrations from exactly one place.
- `DB_ROLLBACK_UNKNOWN_TARGET`: the rollback target is not in the journal. The message lists the known
  tags.
- `DB_ROLLBACK_UNSAFE`: a migration has no down file, so it cannot be reversed. Write a
  `<tag>.down.sql` beside it.
- `DB_ROLLBACK_DESTRUCTIVE`: the rollback would destroy data. It runs only with `--allow-destructive`
  and a `--confirm` that repeats the name of the newest migration being undone.

## Security notes

A migration file is SQL that runs with the database's full rights, so it is reviewed like code. The
checksum makes an edit to an applied migration visible, and drift stops the runner. A destructive
rollback needs two deliberate flags, and the second must name the migration it undoes. Keep migration
runs out of request handlers, and run them from one place.
