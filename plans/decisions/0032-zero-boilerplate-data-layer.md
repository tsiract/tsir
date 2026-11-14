# 0032 — A zero-boilerplate data layer: bound Drizzle, typed models, and one DX rule for every capability

- **Status:** Accepted
- **Date:** 2026-11-14
- **Affects:** `@tsir/database`, every capability package, `tsir.js`, `@tsir/console` generators, `admin.product.com`
- **Amends:** [ADR-0019](./0019-multi-connection.md) (named connections) — unchanged in substance, given a default-resolution rule; [ADR-0027](./0027-capability-drivers.md) — the same resolution rule applies to all capabilities, not only the database

---

## Context

`@tsir/database` is correct and expensive to use. Every service in the admin app repeats the same
four lines to reach a table:

```ts
constructor(private readonly drizzle: DrizzleDb) {}

const keyRow = await this.drizzle.select({ id: i18nKeys.id }).from(i18nKeys).where(eq(i18nKeys.key, key));
```

That is the _best_ case. The awkward parts:

1. **`drizzle` is one connection.** `createDatabaseBootstrap` builds Drizzle for the default
   connection only. Reaching the second connection means constructing a second Drizzle instance by
   hand, and the type of that instance is the same type — so an argument can be "the other" database
   and nothing says so.
2. **Wiring is manual per DI entry.** `drizzleToken`, `dbToken`, `dbProvider`, `drizzleProvider`,
   `runtimeBindings` and `MIGRATIONS_DIR` are destructured in the app's `database.ts` and then
   re-declared in every module's provider list. A module that forgets one fails at request time.
3. **Drizzle rows are untyped at the boundary.** `InferSelectModel<typeof users>` is the correct
   type and every service re-derives it or reaches for `as`. A `select()` with a partial column set
   produces a different row type, which is right, and invisible.
4. **A second engine means a second schema.** `sqliteTable` vs `pgTable` is a rewrite, documented as
   a cliff in `05-database.md § 2`. `INF-010` fixed this for the framework's own tables by building
   them per engine; an application has no equivalent.

Meanwhile the same shape recurs in every capability. Cache, queue, storage, mail, broadcast, search,
sessions, flags and locks all take an `engine` or `driver` and must be told which one, and the
selection logic lives in each app's bootstrap instead of in the config that already names it. The
framework knows `tsir.js` says `database.connections.primary`, and still makes the caller say it
again.

## Decision

**Five changes, one rule: the default is resolved from config, the type states the choice, and a
driver that cannot honour the choice refuses at boot.**

### 1. `db` is a bound Drizzle, `db(name)` is any other connection

`createDatabaseBootstrap` returns one Drizzle instance per declared connection, all built from the
same driver, plus a callable:

```ts
export const { db, dbFor, dbToken, dbProvider } = createDatabaseBootstrap(config, options);

await db.select().from(users); // default connection
await dbFor('analytics').select().from(events); // named, same instance or built on first use
```

`db` is Drizzle — not a wrapper, not a query builder of ours. Every Drizzle method, every extension,
every `sql` template works unchanged. The addition is _which_ connection and _which_ schema, resolved
once instead of at each call site. `dbFor(name)` is typed against the connection names declared in
config, so `dbFor('nope')` is a type error.

The Drizzle instance is **memoised per connection**, for the reason `INF-010` documents: two Drizzle
instances over one driver are two column identities, and a join across them produces duplicate table
aliases.

### 2. Models are a declared table plus typed accessors — not an Active Record

A model is `defineModel(table, options)`. It carries the table, the row type, the insert type and
nothing mutable. Queries stay Drizzle; the model removes the ceremony of repeating the same
`where(eq(table.id, id))` in every service.

```ts
// modules/users/model.ts
import { defineModel } from '@tsir/database';
import { users } from '../../shared/schema.ts';

export const Users = defineModel(users, { timestamps: true, softDeletes: false });

export type User = typeof Users.$type; // InferSelectModel, named once
export type NewUser = typeof Users.$insert; // InferInsertModel, named once
```

```ts
await Users.find(id); // User | null
await Users.findOrFail(id); // User, throws DB_MODEL_NOT_FOUND
await Users.where({ email }); // User[] — a typed column record, not a string
await Users.create({ email, name }); // User, `timestamps` fills created_at/updated_at
await Users.update(id, { name }); // User, the updated row
await Users.delete(id); // boolean — rows changed, not "no error"
await Users.query(); // the raw Drizzle builder, still bound to the right connection
```

**The strictness is the point, and it is the opposite of Eloquent's.** Four rules, each one a class
of bug Eloquent lets through:

| Rule                                                                                       | What it prevents                                                                                            |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| A field name is a **key of the table's columns**, checked at compile time                  | `where('emial', x)` — a typo Eloquent turns into a runtime error, or worse, a query that matches everything |
| A row is the **table's inferred type**, never `any` and never an index signature           | `user.anything` compiling and being `undefined` at runtime                                                  |
| A relation returns a **declared type**, and `with()` types the result from what it fetched | the N+1 that silently returns `undefined` because the relation was never loaded                             |
| A write takes **`InferInsertModel` minus generated columns**                               | assigning to `id` or overwriting `created_at`, which Eloquent permits and then surprises you about          |

No model is a subclass. `Users` is a frozen object of functions; a service holds it, not inherits it.
Composition is what makes the types predictable — an inheritance chain is where Eloquent's
`Model` → `Authenticatable` → `User` confusion comes from, and TypeScript cannot narrow a mutable
prototype.

`timestamps` and `softDeletes` are **declared, not assumed**: `timestamps: true` requires the table
to have `createdAt`/`updatedAt` columns and fails to compile if it does not. That is the ADR's
strictness in one sentence — a convention that is checked is a feature, a convention that is
assumed is a bug with good marketing.

### 3. One resolution rule for every capability

Every capability package already takes a `driver`/`engine` and a `placeholder`/`connection` option.
The rule becomes uniform:

```ts
// tsir.js — the only place the choice is written
export default {
  database: { default: 'primary', connections: { primary: { driver: 'd1', binding: 'DB' } } },
  cache: { default: 'kv', stores: { kv: { driver: 'cloudflare-kv' } } },
  queue: { default: 'jobs', connections: { jobs: { driver: 'cloudflare-queues' } } },
};
```

```ts
// every capability, one call, no options object
const cache = bootstrap.cache; // the default store, from config
const queue = bootstrap.queueFor('jobs'); // any other, same rule as dbFor
```

A capability that resolves no driver **refuses at construction**, naming the config key. It never
falls back to `memory`, which is the failure mode the standing acceptance bar already forbids for
mail and notify.

### 4. DI does the combining

`createDatabaseBootstrap` (renamed `createAppServices`, keeping the old export as an alias) returns
one provider record per capability, already wired. A module lists what it uses; the container
resolves it:

```ts
// modules/users/routes.ts
classProvider(usersServiceToken, UsersService, [usersModelProvider, cacheProvider, loggerProvider]);
```

No `drizzleToken` vs `drizzleProvider` distinction in user code. A capability a module did not list
is not injectable — the container refuses it at boot, not at the first request that needed it.

### 5. A duplicate schema is generated, not written twice

`tsir schema:duplicate --to postgres` emits a `pgTable` module from an existing `sqliteTable`
module, and `--check` fails when the generated module drifts. The framework already does this for
its own tables (`telemetryTables(engine)`); this gives an application the same mechanism without a
second description language. The two modules must agree on column names and nullability, and a test
asserts it — the `INF-010` proof, reused.

**Deliberately not decided here:** whether `defineModel` can also run against the generated Postgres
schema without the caller changing imports. It should (one model, two tables, selected by the
resolved connection's engine), and that is `DX-004` — a separate task because it decides how much
`defineModel` knows about engines.

## Consequences

**Positive**

- The common path is `await Users.find(id)`, and the common path is the typed path.
- Switching a connection is editing `tsir.js`, not re-wiring a constructor.
- One resolution rule instead of eleven; a capability that no one configured fails loudly at boot.
- Models that cannot express the bugs Eloquent's do.

**Negative / costs**

- `db` becomes a live binding, not a value — a Drizzle call before the binding arrives must fail the
  same way `db.query` already does (the deferred-driver contract, `bootstrap.test.ts`).
- `defineModel` is a new public surface with a compatibility promise. It must stay on top of Drizzle
  types and never re-declare them, or the two will drift.
- The generator for `schema:duplicate` is the first thing in the framework that rewrites an
  application's source. It writes a new file and refuses to touch an existing one (`CLI-009`'s rule),
  and `--check` is what keeps it honest.

## Alternatives considered

| Alternative                                            | Why rejected                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| An Active Record `Model` class with instance methods   | Mutable prototype, `save()` on a stale row, lazy loading — the three things that make Eloquent hard to type and predict   |
| A query builder of our own                             | Reimplements Drizzle badly; the framework's whole position (`05-database.md § 1`) is that Drizzle owns query building     |
| Prisma-style generated client                          | A second schema description language, a codegen step in the dev loop, and a build artifact to keep in sync                |
| Repositories with hand-written methods per table       | The ceremony this ADR exists to remove; `Users.find` is the same interface with the boilerplate factored out              |
| Keep per-capability bootstraps and document the wiring | The docs are already the longest part of every capability page, and the failure is a request-time error, not a boot error |
| A `memory` fallback when nothing is configured         | Already forbidden: a guard nothing passes is not a guard, and a silent in-memory queue loses jobs with no error to find   |
