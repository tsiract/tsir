# ADR-0027 — Capability drivers: subpath manifests, app-supplied clients, per-store registries

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related:** [ADR-0012](./0012-dependency-policy.md) (dependency policy), [ADR-0019](./0019-multi-connection.md) (named registries), [ADR-0009](./0009-postgres-transport.md) (app-supplied client), [ADR-0022](./0022-subpath-dependency-scope.md) (subpath dependency scope), [ADR-0016](./0016-cloudflare-first-and-d1.md) (Cloudflare first), [`15-capabilities.md`](../modules/15-capabilities.md) § 2.2, § 9

## Context

Phase 7 introduces the optional modules — cache, queue, events, schedule, mail, notify,
storage — each driver-based. `15-capabilities.md` answered the mechanism (ports, subpath
drivers, declared capabilities, per-store registries) but left three packaging questions
open, and its own rule says no Phase 7 task may be opened until they are answered:

- **Q36** — is `redis`/`ioredis` allowlisted on Bun and Lambda, or unsupported until asked for?
- **Q37** — does a driver ship as `@tsir/cache/redis` (subpath) or `@tsir/cache-redis`?
- **Q38** — on Lambda, is a `database` queue connection accepted with its scheduled-poll cost,
  or is `sqs` + outbox forced?

The repository already answers structurally similar questions elsewhere, and the answers
constrain these: ADR-0012 allows runtime dependencies only after review, ADR-0022 puts a
driver behind a subpath so its dependency is only loaded when the subpath is imported, and
ADR-0009 has `@tsir/database` take an **app-supplied client** rather than bundling `pg`.

## Decision

**1. A driver takes an app-supplied client; a capability package takes no runtime dependency
(Q36).**

`@tsir/cache/redis` exports a driver that accepts a `RedisLike` — the handful of methods it
uses (`get`, `set` with `PX`, `del`, `incrBy`, `scan`-free `unlink` by tag set). The
application passes its own client, exactly as it passes its own `pg` client today. Same for
`@tsir/cache/postgres`-shaped drivers, `@tsir/storage`'s S3 client, and any mail transport.

Consequences, stated plainly:

- `ioredis` is **not** allowlisted, and neither is any other client. The framework gains no
  dependency it cannot test without a service.
- The seam is the cost: a method the driver needs and the client lacks is a startup error
  (`CAP_DRIVER_MISSING` with the missing method named), not a runtime surprise.
- A driver that genuinely cannot work that way — one that needs a client _and_ nontrivial
  logic we would otherwise reimplement — graduates to a separate manifest, per ADR-0022.

**2. Drivers ship as subpaths of their capability package, and graduate to their own package
only when they carry a dependency (Q37).**

`@tsir/cache`, `@tsir/cache/memory`, `@tsir/cache/null`, `@tsir/cache/redis`,
`@tsir/cache/cloudflare-kv`, `@tsir/cache/database`. The rule for graduating is mechanical:
**if the subpath would need a dependency in `package.json`, it becomes a package.** A
dependency-free subpath costs nothing to import and keeps one version to pin; a package per
driver multiplies manifests and release notes for no benefit.

**3. On Lambda, `sqs` is the default queue backend; `database` is allowed with an explicit
opt-in and a build warning (Q38).**

The resolution order (§ 3.2) prefers a driver the target owns. A `database` connection on
Lambda means a scheduled poller — an EventBridge rule invoking a worker every N seconds,
billed whether or not there is work, with a latency floor and no back-pressure. That is a
reasonable trade for a small project and an unreasonable one to inherit silently, so:

- `queue.connections.<name>.driver: 'database'` on a Lambda target requires
  `allowScheduledPoll: true` on that connection;
- without it, `deploy:build` fails on the target rather than emitting a poller nobody asked for
  (`CAP_UNSUPPORTED_OPERATION`, naming the connection, the target and the flag);
- the outbox stays mandatory for every non-transactional backend (§ 4.2).

**4. Registries validate at boot and open lazily (Q46, answered here rather than deferred).**

`createCaches({ stores })` checks names, the `default`, the production guard and every
declared `requires` block **without opening a connection** — capabilities are static, so the
check needs no I/O. Backends open on first resolution and are memoised; `cache.probe()` is the
explicit "open everything and round-trip a key" call for a health endpoint. A project with a
dozen stores does not open a dozen connections to boot.

The default store is the one exception: it resolves eagerly, because a broken default should
fail at boot and not at the first request that happened not to name a store.

**5. A counter is a codec form, not a raw string.**

`increment` has to read _and_ write inside the driver's critical section (one
`UPDATE … RETURNING`, one `Map` mutation) and still leave something `get` can decode. So
`Codec` carries an optional `counter: { read, write }`, drivers receive it, and a codec
without one makes `increment` a `CAP_UNSUPPORTED_OPERATION` — a counter you can increment but
cannot read is not a counter.

## Consequences

- `make deps` stays at two runtime dependencies for the whole framework.
- Every driver is testable without a service: the conformance kit (`@tsir/cache/conformance`)
  is data, and a fake backend satisfies it.
- Two `@tsir/cache` stores on one driver still emit one import in `drivers.gen.ts` (`CAP-003`).
- A future driver that needs a real dependency is a new package, and this ADR's rule 2 is what
  says so — no debate required at that point.
