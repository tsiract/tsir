# ADR-0015 — Capability drivers: declared, statically imported, and honest about what they cannot do

- **Status:** Accepted — Q36–Q38 were the only open items, and [ADR-0027](./0027-capability-drivers.md) answers them
- **Date:** 2026-10-27
- **Affects:** `@tsir/cache`, `@tsir/queue`, `@tsir/mail`, `@tsir/notify`, `@tsir/storage`, `@tsir/schedule`, `@tsir/auth`, `src/tools/verify-dist.ts`, `@tsir/deploy`
- **Related:** ADR-0004 (one package, per-protocol entrypoints), ADR-0005 (separate deploy units), ADR-0012 (dependency policy), `15-capabilities.md`

---

## Context

Four Phase 7 modules (`cache`, `queue`, `mail`, `notify`) all need the same thing: one interface, N
implementations, chosen by configuration. Laravel solves this with `config/*.php` returning a driver
name, a factory that resolves it at runtime, and a `Databases\Connection` object per driver.

None of that transfers to Tsir's constraints:

- **Tree-shaking is mandatory** (ADR-0012). A runtime `switch (driver) { case 'redis': return import(...) }`
  is a bundle including every branch, or a dynamic import that no bundler can prove dead.
- **Three targets with different service catalogs.** Bun has no KV, Cloudflare has no SQS, Lambda has
  no Hyperdrive. A single global default is impossible without picking a winner and breaking the others.
- **Semantics differ by target, not just implementation.** Workers KV _is not_ a cache with slower
  writes; it is a store without read-your-writes and without atomic increments. Code that treats the
  two as interchangeable is code that will corrupt a counter in production.

## Decision

**1. A driver is a subpath export, statically imported.**

`@tsir/cache` is the port plus dependency-free drivers (`memory`, `null`).
`@tsir/cache/database` is the Postgres driver. `tsir.js` names a string; `tsir build` emits a
`drivers.gen.ts` with the concrete imports. No runtime driver map, ever — it is a bundle-size
liability and a supply-chain surface that configuration could add to silently.

**2. Every driver declares capabilities, and the framework enforces them.**

`readYourWrites`, `atomicIncrement`, `minTtlMs`, `sharedAcrossInstances`, `tags` — booleans and
numbers a boot check can compare against the application's declared needs, and that a call-time check
can throw on. **A driver that cannot honour an operation fails loudly. It never degrades silently.**

The reasoning is asymmetric on purpose: a cache that is occasionally stale is a performance bug; a
rate-limit counter that is occasionally wrong is a security bug. Only one of those can be traded.

**3. Defaults resolve in a fixed order, and the last two are environment-gated.**

```
tsir.js → deploy adapter (per target) → postgres (production) → memory/sync/log (development)
```

Development may resolve to a non-durable driver. Production may not: boot fails with
`CAP_DEV_DRIVER_IN_PRODUCTION` rather than starting an app whose cache forgets and whose jobs vanish.
`mail` has no portable production default at all — an accidentally-unsent email is a silent failure
with a human on the other end.

**4. Cloudflare services are the _target_ defaults for Workers, not the _framework_ defaults.**

|          | Workers default                                        | Framework default           |
| -------- | ------------------------------------------------------ | --------------------------- |
| database | Hyperdrive + `postgres.js` (ADR-0009)                  | `postgres.js` on Bun/Lambda |
| storage  | R2 (via the `s3` driver)                               | `s3`                        |
| queue    | Postgres (correctness) — Queues opt-in with the outbox | Postgres                    |
| cache    | Postgres                                               | Postgres                    |
| mail     | Email Sending when configured (beta)                   | explicit only               |

The distinction matters: a framework default that only works on one vendor's platform is not a
default, it is a lock-in with good marketing.

> **Amended by ADR-0009.** The Workers cell used to read "Hyperdrive + `pg`". The client is
> `postgres.js` on every target, supplied by the application; Hyperdrive remains the Workers
> _transport_ and is unchanged. `pg` lost on CommonJS, not on capability. "Cloudflare-first" is honoured as _best-in-class
> adapters and target-aware defaults_, which is the part that actually helps someone deploying there.

**5. Non-transactional queues require the outbox.**

Dispatching from inside a transaction is the whole reason Postgres is the queue default:

```ts
await db.transaction(async (tx) => {
  await tx.insert(orders).values(order);
  await queue.dispatch(SendReceipt, { orderId: order.id }); // same tx — atomic
});
```

`sqs` and `cloudflare-queues` break that (two independent writes: a job with no order, or an order
with no job). `tsir build` refuses them without `@tsir/events`, whose outbox restores the guarantee.

**6. A shared conformance kit decides when a driver is finished.**

`@tsir/testing/conformance` runs identical behaviour tests against every driver of a port,
including negative tests that a declared-unsupported operation throws. Capability claims are
tested, not commented.

## Consequences

- Adding a driver is a subpath, a capability record, and a conformance run — mechanical, reviewable,
  and it cannot land half-honest.
- `tsir.js` cannot enable a driver without a build step, which is a small ceremony that buys bundle
  determinism. `tsir dev` regenerates on config change.
- Capability descriptors become API surface: adding one to a port obliges every existing driver to
  declare it. That is the intended pressure — a new operation should be a deliberate decision per
  driver, not a default that silently means "probably".
- The Postgres queue default costs a drain mechanism on every target: a long-lived worker on Bun, a
  `scheduled` handler on Workers, an EventBridge schedule on Lambda. Real complexity, accepted
  because the alternative is a message queue that can disagree with the database.
- Redis is **not** a default anywhere and needs an ADR-0012 review if it is added (Q36). This will
  be unpopular and is still right for a framework whose baseline must work on Workers. ADR-0027
  settled the mechanics: a driver takes an **application-supplied client**, so the framework gains
  no dependency and `make deps` stays at two.

## Alternatives rejected

- **Cloudflare services as the framework-wide default.** Rejected: breaks Bun and Lambda on day one,
  and KV cannot back sessions, locks, or counters — three of the five things the cache is for.
- **A runtime driver registry (Laravel-style `extend()`).** Rejected: un-tree-shakeable and
  unverifiable; `verify-dist` could no longer prove that an app using `memory` does not ship Redis.
- **Thin adapters that "best-effort" unsupported operations.** Rejected: a silently non-atomic
  `increment` is worse than a crash, because nobody notices until the numbers are wrong.
- **One driver per target, hardcoded.** Rejected: it removes the ability to run Workers against R2
  while using Postgres for cache, which is a normal configuration.
- **`notify` as a driver-based module like the others.** Rejected: notifications are channels (a
  delivery _route_), and the driver question recurs _inside_ each channel. Laravel's split is correct
  and is copied deliberately.
