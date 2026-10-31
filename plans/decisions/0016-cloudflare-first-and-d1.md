# ADR-0016 — Cloudflare-first defaults, and where D1 actually fits

- **Status:** **Accepted** (2026-10-27) — D1 default, Postgres as a selectable driver
- **Date:** 2026-10-27
- **Affects:** `@tsir/database`, `@tsir/cache`, `@tsir/queue`, `@tsir/migrate`, `@tsir/deploy`, `Makefile`, `src/tools/dev.ts`, testing strategy
- **Related:** ADR-0009 (Postgres driver per target, unwritten), ADR-0015 (capability drivers), `05-database.md`, `15-capabilities.md`

---

## Context

The maintainer's proposal: _use D1 as the database, cache and queue, default everything to Cloudflare
services, and run locally under Wrangler._

The instinct behind it is right — one vendor, one local simulator, one bill, no Redis to operate. It
also directly contradicts a standing requirement: **"PostgreSQL-first"**, and `05-database.md`'s
explicit **"D1 is not supported"**. That contradiction is the actual decision to make. So: what does
D1 actually give us, and where does it break?

## 1. Findings

### 1.1 D1 is SQLite, not Postgres

Drizzle reaches D1 through a SQLite dialect: `sqliteTable`, not `pgTable`. Everything Postgres-shaped
in the existing plans changes or disappears — native `uuid`, arrays, `jsonb`, enums, `numeric`
precision, `timestamptz`, and every extension (`pgvector`, `PostGIS`, `pg_trgm`). `06-vault.md`'s
column types and `05-database.md`'s "TS vs runtime vs DB-constraint" table are both written against
Postgres semantics.

This is not a driver swap. It is a different engine with a different type system.

### 1.2 D1 has no interactive transactions

`BEGIN`, `COMMIT`, `ROLLBACK` and `SAVEPOINT` are rejected outright. D1's only atomicity primitive is
`batch([...])`: statements execute sequentially, non-concurrently, and the whole list commits or
rolls back as one unit. Drizzle's `db.transaction()` throws on D1; `db.batch()` is the replacement.
([D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[drizzle#2463](https://github.com/drizzle-team/drizzle-orm/issues/2463))

The constraint is structural: Cloudflare wraps each query or batch in its own transaction because
SQLite permits only one open write transaction at a time, so a long-lived `BEGIN…COMMIT` held by an
arbitrary Worker would lock the whole database.

**Consequence:** any design that reads, decides in JavaScript, then writes inside one transaction is
impossible on D1. `batch()` requires every statement to be known _before_ execution, so a statement
cannot depend on an earlier statement's result.

### 1.3 D1 is single-threaded per database, capped at 10 GB

> "Each individual D1 database is inherently single-threaded, and processes queries one at a time."
> ~1,000 queries/second if each takes 1 ms; ~10/second if each takes 100 ms.
> ([Limits](https://developers.cloudflare.com/d1/platform/limits/))

10 GB per database is a hard cap that **cannot be raised** on any plan; 50,000 databases per account
is the documented scaling axis. Also: 100 bound parameters per query, 100 KB per statement, 2 MB per
row, 1,000 queries per invocation, 30 s per query.

Read replication exists but is **beta**, works only through the Sessions API over a Worker binding
(not REST), and all writes still go to the single primary.

### 1.4 D1 is a better cache than Workers KV

Directly relevant to ADR-0015, which ruled out KV as a cache default. D1 does not have KV's
disqualifying properties:

| Property                 | KV               | D1                                           |
| ------------------------ | ---------------- | -------------------------------------------- |
| Atomic `v = v + 1`       | **No**           | **Yes** — `UPDATE … RETURNING`               |
| Writes per key/second    | **1**, then 429  | No such limit (bandwidth-bound)              |
| Read-your-writes         | No (60 s)        | Yes on primary; ≤ baseline with Sessions API |
| TTL                      | Native, min 60 s | Manual (`expires_at` + sweep)                |
| Contention with app data | None             | **Shares the single query slot**             |

So `cache.driver: 'd1'` is legitimate — and materially better than `cloudflare-kv`. The risk is not
correctness, it is **throughput**: a cache table in the same D1 database as application data
competes for the one-query-at-a-time slot. A separate `CACHE` D1 database avoids that and costs
nothing (50,000 databases per account).

### 1.5 D1 cannot be a queue — but the missing piece is not a dispatcher you write

The maintainer's concern is correct: a queue needs something to _run_ the work. On Cloudflare that
thing already exists — **Cloudflare Queues**, whose consumer is a `queue(batch, env, ctx)` handler
the platform invokes. There is no poller to build.

What D1 cannot do is make the enqueue **atomic with the business write**, because there are no
transactions. That guarantee is recovered by the **transactional outbox**, and it works because
`batch()` is atomic:

```ts
// ONE round trip, ONE transaction: the order and its outbox row land together,
// or neither does.
await env.DB.batch([
  env.DB.prepare('INSERT INTO orders (id, total) VALUES (?, ?)').bind(id, total),
  env.DB.prepare('INSERT INTO outbox (id, job, payload) VALUES (?, ?, ?)').bind(
    jobId,
    'SendReceipt',
    payload,
  ),
]);
```

A pump — a `scheduled` handler, or the request path — moves outbox rows into Queues and marks them
sent. Queues is **at-least-once with no ordering guarantee**, so consumers must be idempotent:
delivery of the business effect is still the consumer's responsibility.

**This is why `@tsir/events` (already scoped to Phase 7 with an outbox) stops being optional on D1.**
On Postgres the database queue gives the guarantee for free; on D1 the outbox is the only way to get
it, and there is no fallback that keeps the guarantee.

### 1.6 "Locally under Wrangler" changes the runtime, not just the tooling

`wrangler dev` runs **workerd** via Miniflare. It faithfully simulates D1, Queues, KV, R2 and Durable
Objects against on-disk state in `.wrangler/state`. It is not Bun, and Bun cannot load a D1 binding.

Two consequences:

- **`bun test` cannot exercise D1, Queues or R2.** Cloudflare's answer is
  [`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/)
  (V1 of the former `@cloudflare/vitest-pool-workers`, now deprecated), which runs tests _inside_
  workerd with real migrations applied. That is **Vitest**, not `bun test`.
- **"Bun-native tooling" is reduced in scope.** Bun remains package manager, script runner, and unit
  test runner for runtime-neutral packages — which is most of the framework. The 129 existing tests
  are runtime-neutral and unaffected, because `verify-dist` already proves the core bundles for a
  Workers target at 37.9 KiB.

### 1.7 D1 is not reachable from Bun or Lambda at production latency

D1 is a Worker binding. There is a REST query API, but it is an administrative surface, not a
production query path, and it lacks the Sessions API. A Bun or Lambda deployment therefore **cannot
use D1** as its database. "Default everything to Cloudflare" is coherent only if Workers is the
primary target.

## 2. What that means for each module

| Module        | Verdict on Cloudflare-first                 | Detail                                                                                         |
| ------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **database**  | Possible, but it is an engine change        | D1/SQLite; loses interactive transactions and every Postgres-only type and extension           |
| **cache**     | **Yes — better than the current plan**      | D1 beats KV on semantics; use a separate `CACHE` database to dodge the single query slot       |
| **queue**     | **Queues for transport, D1 for the outbox** | Atomic enqueue via `batch()`; pump to Queues; at-least-once, no ordering, consumers idempotent |
| **mail**      | Yes                                         | Email Sending binding (public beta, Workers Paid)                                              |
| **storage**   | Yes                                         | R2 via the `s3` driver                                                                         |
| **local dev** | Yes, but it is workerd                      | Wrangler + Miniflare; Vitest for binding tests                                                 |

The queue answer is the clearest win, and it is the one the maintainer already suspected: **you were
right that a queue needs a dispatcher — Cloudflare Queues is the dispatcher, and D1 is the outbox.**

## 3. The real cost, stated plainly

| Cost                               | Magnitude                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| Postgres-only types and extensions | Gone on the default path — no `pgvector`, `jsonb`, arrays, enums                                   |
| Interactive transactions           | Gone. Every multi-step write becomes a `batch()` with pre-computed statements, or a Durable Object |
| Scale ceiling                      | 10 GB hard, single-threaded. Past that, manual sharding across databases                           |
| Interactive read-then-write        | Requires optimistic concurrency (`WHERE version = ?`) or a Durable Object                          |
| Test runner                        | Workerd-based tests are Vitest, not `bun test`                                                     |
| Bun/Lambda                         | D1 unavailable — Workers becomes the primary target, others need a different engine                |

The `WHERE version = ?` point deserves emphasis: **every read-modify-write in the framework must
become optimistic** on D1. That is not a week of edits in `@tsir/database`; it is a constraint that
leaks into every module that writes (`auth` sessions, `vault` key rotation, `schedule` locks,
`policy`). ADR-0015's capability model was built for exactly this — but it means `interactiveTx:
false` is a capability that _most of Phase 7_ has to be designed around, not a footnote.

## 4. Decision — accepted 2026-10-27

**D1 is the default engine. Postgres stays first-class as a selectable driver. Local development
follows the deploy target.**

1. **Default stack = Cloudflare.** `tsir new` with no flags scaffolds a Workers app with D1, a
   separate `CACHE` D1 database, Cloudflare Queues, R2, and Email Sending.
2. **The engine is a driver, Laravel-style.** `tsir.js` `database.driver` selects `d1` (default) or
   `postgres`. Adding an engine is a subpath export plus a capability record (ADR-0015).
3. **A database driver selects a Drizzle _dialect_, not an abstraction.** D1 → `sqliteTable`,
   Postgres → `pgTable`. Moving an app between engines is a schema rewrite plus a data migration,
   **documented as a cliff** in `05-database.md`. An Eloquent-style schema layer that hid the
   difference would mean reimplementing Drizzle, which the brief forbids.
4. **Local dev and testing follow the target.** Workers apps run under Wrangler/workerd; Bun-target
   apps run under Bun. Anything touching a binding is tested under Vitest inside workerd with real
   migrations; runtime-neutral packages (container, config, validate, router compile) keep `bun test`.
5. **`interactiveTx: false` is the baseline, not an edge case.** Framework code assumes no interactive
   transactions by default: multi-statement writes use `batch()`, read-modify-write uses optimistic
   concurrency (`WHERE version = ?`) or a Durable Object. `interactiveTx: true` is the _upgrade_.
6. **The transactional outbox is mandatory on the default path.** Cloudflare Queues cannot be
   enqueued inside a transaction because there is no transaction; the outbox row is written in the
   same `batch()` as the business row and a pump moves it to Queues. `@tsir/events` stops being
   optional for any app that queues.
7. **Cache defaults to a separate D1 database.** Not KV — see § 1.4 — and not the application
   database, to keep the cache off the application's single query slot.

### Why not a single schema for both engines

Considered and rejected: Laravel's `config/database.php` can swap MySQL for Postgres because Eloquent
builds SQL at runtime from a model definition. Drizzle does not build SQL from a model — it builds it
from a _schema written in the target dialect_. Producing one schema that compiles to both would be a
new ORM layer, which is exactly the reimplementation the brief rules out. So the driver chooses the
dialect, and the schema is written once, in the chosen dialect.

## 5. Consequences

- **"PostgreSQL-first" is retired as the default** and survives as "Postgres is fully supported".
  `00-foundation.md`, `05-database.md`, `01-roadmap.md` and the frontpage all say otherwise today and
  are amended with this ADR.
- **ADR-0009 narrows**: it is no longer "which Postgres driver per target" as an open question about
  the Workers default — D1 is the Workers default, and ADR-0009 covers the Postgres path only.
- **Phase 3 changes shape.** The Phase 3 gate ("boots against a real Postgres container") becomes
  "boots against local Miniflare D1 _and_ a Postgres container", because both drivers ship.
- **Phase 7 changes shape.** Every write path must be designed for no-interactive-transactions first.
  `vault` key rotation, `auth` sessions, `schedule` locks and `policy` all need the optimistic-
  concurrency pattern, not a transaction. This is a large, real cost and it is accepted deliberately.
- **The 10 GB ceiling is a documented product limit**, with "one database per tenant/entity" as the
  documented scale-out, matching Cloudflare's own guidance.
- `verify-dist` gains a `d1-app` probe with a real budget, so the default path's bundle cost is a
  measured number rather than an assumption.
- `Makefile` `dev` becomes target-aware: Wrangler for Workers apps, `bun --watch` otherwise.

## 6. Alternatives rejected

- **Postgres everywhere; D1 unsupported.** Rejected by the maintainer: it gives Cloudflare users a
  Workers target whose only database is an external Postgres they must operate themselves.
- **D1 only; Postgres demoted to a documentation footnote.** Rejected: the driver model is the point.
  Losing Postgres would remove the only escape hatch from a 10 GB single-threaded engine.
- **One schema, both dialects.** Rejected per § 4 — it is a reimplementation of Drizzle.
- **Emulating interactive transactions over `batch()`.** Rejected: `batch()` cannot express a
  statement that depends on a previous result. The alternatives are two round trips (not atomic) or
  an in-memory buffering layer that silently changes semantics.
- **Wrangler as the local runner for every target.** Rejected: workerd cannot load `bun:sqlite`, or
  reach a Postgres socket for a Bun-target app.
