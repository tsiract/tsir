# Models, Drizzle queries and migrations

After [installation](../installation.md), add the package to your app with
`bun add '@tsir/database@workspace:*'`.

## Why there is no `Model.find()`

Tsir deliberately does **not** provide an Active Record base class. There is no `Model.find()`,
no static query methods on your model, and no magic connection resolution. Instead, a "model" in
Tsir is two things:

1. A **Drizzle schema** — the typed table definition (columns, types, constraints).
2. **Application-owned query functions** — plain functions that take a `Database` and run queries.

This is closer to how Laravel uses Eloquent *scopes* and *repositories* than to Active Record:
your schema describes the table, and you write explicit functions for the queries your app needs.
The benefit is that queries are testable (pass a mock `Database`), traceable (no hidden static
state), and never silently pick up the wrong connection.

`@tsir/database` owns the drivers, lifecycle, and capability checks; Drizzle builds the typed
SQL. You add `drizzle-orm` to your application before using it directly. The project schema
recognizes `mysql`, but a MySQL driver and Drizzle integration are not yet shipped. Packages are
pre-alpha and not published; see [installation](../installation.md).

## Generate a model

From your application directory:

```sh
tsir make:module shop
tsir make:model order shop
bun add drizzle-orm@0.45.4
```

This creates `shop/models/order.model.ts` and an intentionally failing
`order.model.test.ts`. The schema exports `order`, `Order`, and `NewOrder`; its initial SQLite
(or D1) table is named `shop_order` with a text primary key. Edit the columns and replace the
pending test. `tsir make:model user-settings shop --dialect postgres` instead generates
`user-settings.model.ts` using `drizzle-orm/pg-core` and table `shop_user_settings`. The default
is `--dialect sqlite`; MySQL is not supported. Names are not automatically pluralized. The module
must exist; generate it explicitly first. `--dry-run` shows paths and `--force` overwrites the
model and test. Model generation does not connect to a database, generate or apply migrations, or
register anything automatically. Add an engine-specific driver and migration separately.

## Define a model and repository (D1 / SQLite)

This complete module declares a schema and query functions. The caller supplies an already-created
`Database` bound to a real D1 binding. The snippet is typechecked and loaded by the documentation
suite; it does not claim to connect to a live D1 database.

```ts verify
import { createDrizzle, type Database } from '@tsir/database';
import { eq } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
});
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export function usersRepository(database: Database) {
  const db = createDrizzle(database, { schema: { users } });
  return {
    all: () => db.select().from(users).orderBy(users.id),
    byId: (id: number) => db.select().from(users).where(eq(users.id, id)).limit(1),
    create: (user: NewUser) => db.insert(users).values(user).run(),
    rename: (id: number, name: string) =>
      db.update(users).set({ name }).where(eq(users.id, id)).run(),
    remove: (id: number) => db.delete(users).where(eq(users.id, id)).run(),
  };
}
```

Bind in the composition root with `createDatabase({ driver: createD1Driver({ binding }) })`;
`binding` is the platform's D1 database, not a URL. Pass the repository to your application
service/controller through explicit providers. Close the database on shutdown. Parameterize SQL;
never concatenate untrusted strings. Query-builder results use schema column names; raw proxy SQL
returns positional rows.

## PostgreSQL and transactions

Use an application-supplied `postgres.js`-compatible client with `createPostgresDriver` from
`@tsir/database/postgres`, and `createPgDrizzle` from `@tsir/database/postgres/drizzle`. Define
PostgreSQL tables with `pgTable` from `drizzle-orm/pg-core`; SQLite schemas are not automatically
converted. For Postgres interactive work use `database.interactiveTx(async tx => { const db =
createPgDrizzle(tx); /* queries */ })`. Do not use Drizzle proxy `db.transaction()` there.

D1 does **not** support interactive transactions. Use `db.batch([...])` for an atomic group of
known Drizzle statements, or optimistic concurrency where the write depends on a read. Batch and
transaction behavior must be tested for each engine; no cross-connection transaction is implied.
Drizzle may wrap errors: use `errorCode` or `rootCause` from `@tsir/database`.

## Apply schema changes

A schema definition alone does not create a table. For a module-local journal, install
`drizzle-kit` in your app and generate a migration:

```sh
bun add -d drizzle-kit@0.31.11
tsir make:migration create-orders shop
tsir migrate:status shop
tsir migrate shop --dry-run
```

Generation defaults to SQLite/D1 and the module's `*.model.ts` files. PostgreSQL requires
`--dialect postgres`; `--schema` selects a module-local file or glob. Review the generated SQL,
configure and export the app's database, back up production data, and follow the
[migration and seeder runbook](../migrations.md) before `tsir migrate shop`. Module journals are
independent: there is no automatic cross-module order. The runbook explains named connections,
rollback, schema ownership and the intentionally failing generated seeder tests. See the
[database reference](../packages/database.md).
