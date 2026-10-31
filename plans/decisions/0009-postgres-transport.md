# ADR-0009 — One Postgres client, supplied by the application; the framework owns the driver

- **Status:** Accepted
- **Date:** 2026-10-28
- **Affects:** `@tsir/database` (`./postgres`, `./postgres/drizzle`), `@tsir/deploy`, `src/tools/check-deps.ts`, `src/tools/verify-dist.ts`
- **Related:** ADR-0012 (dependency policy), ADR-0015 (capability drivers), ADR-0016 (D1 default, Postgres selectable), `05-database.md § 2`, `08-deploy.md § 4`

---

## Context

ADR-0016 made D1 the default and Postgres the escape hatch. That leaves one
question open in two places (`05-database.md` § 2, Q "Postgres driver detail per
target"):

1. **Which client?** The ecosystem candidates are `pg` (node-postgres, ubiquitous,
   CommonJS, three transitive dependencies) and `postgres.js` (one file per
   target, ESM, zero dependencies, ships an official `workerd` build).
2. **Who installs it?** The framework, or the application?

The second question is the one that decides the first, and it is a question about
**where configuration ends up**, not about taste.

Constraints that apply:

- ADR-0012 rule 2: a runtime dependency must ship native ESM. `pg` is CommonJS
  only — it would fail the policy check on the day it is added, correctly.
- ADR-0012 rule 3: it must declare `sideEffects`. `postgres.js` **does not**
  declare the field, even though it has no side-effectful imports. Adding it
  would fail the policy check for a real reason (the bundler cannot prove
  purity), not a technicality.
- ADR-0015 § 3: the framework must be able to prove with a bundle probe that an
  app using D1 does not ship Postgres. A client that is _imported_ by our own
  package makes that proof depend on tree-shaking someone else's module.
- A Worker reaches Postgres only through Hyperdrive, and a Hyperdrive binding is
  a **connection string at request time**, not at build time. Whatever the client
  is, the _transport rule_ is the same.

## Decision

**1. The application installs the client; `@tsir/database` depends on none.**

`@tsir/database/postgres` exposes `createPostgresDriver({ client })`, where
`client` is typed structurally (`PgClientLike`: `unsafe(sql, params)`, optional
`begin`/`end`). The application creates it:

```ts
import postgres from 'postgres';
import { createPostgresDriver, createDatabase } from '@tsir/database';
import { createPgDrizzle } from '@tsir/database/postgres/drizzle';

const client = postgres(env.DATABASE_URL, poolOptions('bun'));
const database = createDatabase({ driver: createPostgresDriver({ client }) });
const db = createPgDrizzle(database);
```

This is Drizzle's own model (`drizzle-orm/postgres-js` does not depend on
`postgres`; it is a peer). It keeps `@tsir/database` at **two runtime
dependencies** — `zod` via `@tsir/validate`, `drizzle-orm` — and it means the
dependency policy's "no undeclared purity" rule stays intact instead of gaining
an exception for the one package that could not be checked.

**2. `postgres.js` is the supported client, and is a dev dependency only.**

It is used in `type-tests/` to prove the structural type accepts the real
client, never imported by shipped code. `pg` is not supported: CommonJS cannot
be tree-shaken, and a Postgres app on Workers would pay for the whole of it.

**3. Pool size is a deploy-target fact, not a config preference.**

| Target             | Client connections               | Why                                                                                            |
| ------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Bun (server)       | `database.pool.max` (default 10) | One process, one pool; the number is a real tuning knob                                        |
| AWS Lambda         | **forced to 1**                  | Concurrency is the pool: 200 instances × 10 connections is 2 000 connections against RDS Proxy |
| Cloudflare Workers | **forced to 5** on Hyperdrive    | Hyperdrive pools upstream; a Worker that opens many connections fights the pooler it was given |

`poolOptions(target, config)` returns the client options for that target, and
the driver refuses a client whose options would exceed the target's ceiling
(DB-012). A Lambda function that asks for `max: 20` gets one connection and a
boot log line saying so — silently opening 20 would be the expensive failure.

**4. Hyperdrive is a connection source, never a committed string.**

On Workers the connection string arrives in `env.HYPERDRIVE.connectionString`
from the binding. `hyperdriveConnection(binding)` validates and returns it; the
config schema refuses a literal `postgres://` URL when the target is Workers,
because that URL cannot exist there and shipping one means either a secret in the
bundle or a placeholder that fails at 3 a.m. (DB-014).

**5. Drizzle reaches Postgres through the same proxy dialect as D1.**

`drizzle-orm/postgres-js` would take the raw client — a second path to the
database that bypasses drain counting, capability checks and redaction, which is
exactly what `05-database.md § 2.2` forbids for D1. `drizzle-orm/pg-proxy` binds
to `Database` instead, so the invariant holds on both engines and one test proves
it for both.

Consequence worth stating plainly: **Drizzle's `.transaction()` throws on
`pg-proxy`** (`Transactions are not supported by the Postgres Proxy driver`).
That is acceptable because transactions belong to `Database.interactiveTx()`
(DB-013), where the same `Database` interface is scoped to a real transaction —
and a Drizzle instance bound to that scoped `Database` works inside it. The ORM
does not get to own the transaction; the capability does.

## Consequences

- Adding Postgres support changes the dependency list by **zero** runtime
  dependencies. The bundle probe proves it: `db-app` (D1) contains no Postgres
  dialect, `pg-app` contains no SQLite dialect.
- An application on Postgres must add one package and four lines of wiring. That
  is visible in the docs and in the example, and it is the same ceremony Drizzle
  users already perform.
- The framework cannot patch a client bug by bumping a lockfile; it can only
  require a version. Accepted: the alternative is owning a TCP driver.
- `poolOptions()` encodes target-specific knowledge (`max: 1` on Lambda) that a
  user cannot accidentally override to something destructive.
- We give up `pg`'s extension ecosystem (LISTEN/NOTIFY clients, pg-native). The
  plan already rejects LISTEN/NOTIFY as a queue primitive (`15-capabilities.md`
  § 4.2), so nothing of value is lost.

## Alternatives rejected

- **Bundle `postgres.js` as a runtime dependency.** Rejected: it does not declare
  `sideEffects`, so ADR-0012 rule 3 would need an exception. An exception invented
  for the convenience of one package is how a policy becomes a suggestion.
- **Bundle `pg`.** Rejected: CommonJS-only (fails rule 2), three transitive
  dependencies, and no `workerd` build — a Workers app would need `nodejs_compat`
  and still pay for the whole of it.
- **A framework-owned minimal wire-protocol client.** Rejected: that is a driver
  implementation with a security surface (auth, TLS, copy protocol), which is
  exactly what ADR-0012 says not to re-implement.
- **`drizzle-orm/postgres-js` with the raw client.** Rejected for the same reason
  as `drizzle-orm/d1`: a second path to the database that the framework cannot
  count, check, or redact.
- **Per-target config values for transport (`hyperdrive`, `postgres-js`,
  `neon-http`).** Rejected in `05-database.md § 3`: a target cannot provide a
  transport it does not have, so configuration that names one is a configuration
  that can be wrong.
