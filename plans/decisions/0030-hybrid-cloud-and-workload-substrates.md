# ADR-0030 — Hybrid cloud and workload substrates: five deployment profiles over seven runtime seams

- **Status:** Accepted
- **Date:** 2026-11-07
- **Affects:** `@tsir/http`, `@tsir/database`, `@tsir/queue`, `@tsir/storage`, `@tsir/link/ws`, `@tsir/broadcast`, `@tsir/deploy`, `@tsir/telemetry`, `@tsir/pennant`, `@tsir/console` (`deploy-build`), `tsir.js` schema, `src/tools/check-plans.ts`
- **Related:** [ADR-0005](./0005-deploy-topology-default.md) (separate units), [ADR-0009](./0009-postgres-transport.md) (Postgres transport), [ADR-0015](./0015-capability-drivers.md), [ADR-0016](./0016-cloudflare-first-and-d1.md) (Cloudflare-first and D1), [ADR-0019](./0019-multi-connection.md) (named connections), [ADR-0025](./0025-rooms-are-durable-object-shaped.md) (rooms), [ADR-0026](./0026-deploy-graph-is-an-artefact.md) (deploy graph), [ADR-0027](./0027-capability-drivers.md) (capability drivers)
- **Plan:** [`../architecture/17-infrastructure-philosophy.md`](../architecture/17-infrastructure-philosophy.md), [`../reviews/2026-11-07-infrastructure-agnosticism-audit.md`](../reviews/2026-11-07-infrastructure-agnosticism-audit.md), [`../tasks/16-infrastructure-hardening.md`](../tasks/16-infrastructure-hardening.md)

---

## Context

ADR-0016 settled one question: the database defaults to D1, and Postgres is selectable. That was
the right decision and it is not in question here. What it did **not** settle is the question every
Tsir user asks one release later:

> "I am on Workers. My nightly report takes 40 minutes, my queue needs SQS because my team already
> runs AWS, and my data outgrew D1. Do I fork the framework?"

The audit in [`../reviews/2026-11-07-infrastructure-agnosticism-audit.md`](../reviews/2026-11-07-infrastructure-agnosticism-audit.md)
answered with evidence, across all 33 `@tsir/*` packages and the flagship `admin.product.com`:

1. **The Web-standard core is genuinely portable.** `(Request) => Promise<Response>`, the router,
   the pipeline, `@tsir/pulse`, `@tsir/schedule` and the capability driver pattern have no
   substrate assumption that survives inspection. `[VERIFIED]`.
2. **The declared provider matrix is wider than the working one.** `createConnectionsFromConfig`
   throws `DB_DRIVER_UNAVAILABLE` for `postgres`; `@tsir/database/mysql` does not exist; the
   Postgres auth path emits `$1` twice in one `UPDATE` (`INF-001`, `INF-003`).
3. **Hybrid is actively refused.** `checkQueueConnections` rejects `sqs` whenever `cloudflare` is
   in `targets`, so the single most requested topology — Workers at the edge, SQS behind it —
   fails at build time (`INF-007`).
4. **The workload model has one shape.** Every emitted unit is `fetch`-shaped; `adapterTriggers()`
   drops `sns`, `eventbridge` and `manual` triggers, and there is no way to express "a process that
   runs for an hour" (`INF-005`, `INF-012`).
5. **Two real-time models exist and neither knows about the other** (`INF-009`).
6. **Background work has no correct primitive.** `RequestContext` has no `waitUntil`, so app code
   fires unawaited promises that Workers cancels and Lambda freezes (`INF-006`, `INF-016`).

The forces that must be balanced:

- **Cost.** A private-subnet AWS Lambda costs ~$33/month in NAT Gateway before it serves a
  request; Cloudflare's paid plan starts at $5/month with zero egress. A pre-revenue team cannot
  default to AWS (17 § 6.3).
- **Physics.** 128 MB, 10 ms CPU (Free), 6 outbound connections, 30 s `waitUntil`, 900 s Lambda
  timeout. Some workloads do not fit, and no abstraction makes them fit (17 § 8).
- **Native wins.** Durable Object hibernation at $0 idle, D1 `batch()` atomicity, Lambda's
  reserved concurrency. A lowest-common-denominator API loses all three.
- **The standing constraint from ADR-0012/ADR-0027:** no speculative abstractions, no new runtime
  dependency, and every driver proven by a conformance kit.

## Decision

Tsir adopts **five deployment profiles**, selected in `tsir.js`, over **seven runtime seams**. The
application module graph is identical in all five.

### 1. Five profiles

| Profile                             | HTTP            | Queue             | Database                | Cache       | Storage       | Real-time       | Long jobs         |
| ----------------------------------- | --------------- | ----------------- | ----------------------- | ----------- | ------------- | --------------- | ----------------- |
| **P1 — Cloudflare-first** (default) | Workers         | Cloudflare Queues | D1                      | KV          | R2            | Durable Objects | none              |
| **P2 — AWS-first**                  | Lambda + API GW | SQS               | RDS Postgres            | ElastiCache | S3            | APIGW WS        | Fargate task      |
| **P3 — Hybrid**                     | Workers         | SQS or CF Queues  | Postgres via Hyperdrive | KV + Redis  | R2 + S3       | DO + APIGW WS   | Fargate task      |
| **P4 — Self-hosted**                | Bun/Node        | database or Redis | self-hosted Postgres    | Redis       | MinIO or disk | dedicated WS    | same process      |
| **P5 — Dedicated worker infra**     | any             | any               | any                     | any         | any           | dedicated WS    | dedicated workers |

P1 stays the default because it is the cheapest correct starting point, not because it is
universal. P3 is first-class: the framework must not refuse a hybrid topology.

### 2. Seven seams, and no more

`HTTP` (S1), `request lifecycle` (S2), `background job` (S3), `long-running worker` (S4),
`scheduled task` (S5), `real-time` (S6), `persistence` (S7). A substrate name may appear only at a
seam, and only in `tsir.js`. Cache is a capability driver, not a seam; workflow orchestration is
deliberately **not** a seam yet (`Q61`).

S4 (long-running worker) and the parts of S2/S3/S6 that are missing are the actual new surface this
ADR authorises: a worker unit kind, `waitUntil` + per-request `env`, a per-item queue ack, and one
room contract with two transports.

### 3. Portability is a property of the seam, not of the type signature

A provider is "supported" only when (a) it has a driver or emitter, (b) the driver passes the
shared conformance kit, and (c) the workload has a documented placement in 17 § 8. Everything else
is labelled `[PLANNED]` or `[PROPOSED]`. A TypeScript interface is not evidence.

### 4. Status labels are mandatory in infrastructure prose

Every infrastructure capability carries one of `[VERIFIED]`, `[PARTIAL]`, `[PLANNED]`,
`[PROPOSED]`, `[LIMITATION]`, `[PROVIDER-SPECIFIC]`. Declared-but-broken is `[PARTIAL]`, never
"supported".

### 5. Hybrid rules

- A queue connection names its own driver; it is not inferred from the HTTP target. This is the
  rule that makes H1 legal.
- Cross-cloud side effects go through the `@tsir/events` outbox. There is no distributed
  transaction.
- Each secret has one owner and one store. Mirroring is a rotation bug.
- `traceparent` crosses the cloud boundary; `@tsir/pulse` is the sink on both sides.

### 6. Substrates that are provider-specific stay provider-specific

Durable Object class definitions, Wrangler bindings, SAM/GCF template shape, Workers AI and D1
`batch()`-vs-`transaction()` are **not** abstracted. They are labelled `[PROVIDER-SPECIFIC]` and
documented as such. Native capability outranks symmetry.

### 7. What this ADR does not do

It does not migrate anything, does not remove a Cloudflare integration, does not add a runtime
dependency, does not change an application-facing API, and does not deploy anything. It is a
planning decision plus the task ledger that makes it true.

## Consequences

**Positive**

- The question "can I use SQS from Workers?" has a documented answer and a testable acceptance
  criterion (`INF-007`), instead of a build-time rejection.
- Cost guidance is explicit and falsifiable: P1 first, P2 when the invoice justifies it (17 § 6.3).
- Workloads that do not fit an isolate have a home (P5, S4) instead of forcing a second project.
- The five profiles become a single table in `tsir.js`, which means `deploy:check` can validate a
  profile rather than four independent settings that can disagree.
- Every portability claim carries a label and a governing task, so "supported" stops being an
  opinion.

**Negative / accepted costs**

- **Two real-time transports must be maintained** (DO and APIGW WS). Accepted because a single
  lowest-common-denominator socket API would lose hibernation (ADR-0025's argument, reused).
- **A profile becomes a supported surface with its own matrix**, so a change to P2 can break P3.
  Mitigated by the seam rule and by conformance kits rather than by more documentation.
- **Hybrid costs the user two secret stores and two observability sinks.** Documented as a cost,
  not hidden.
- **P2 will still be ~$33/month more than P1 at zero traffic.** ADR-0016's economic argument is
  restated here rather than reversed.
- **S4 adds a unit kind**, which touches `@tsir/deploy`, the graph artefact (ADR-0026) and
  `deploy:build`. That is the largest single change this ADR authorises.

**Neutral**

- ADR-0016 remains in force and is narrowed, not replaced: D1 is still the default engine and
  Postgres is still the escape hatch. What changes is _where_ the escape hatch leads — a working
  P2/P3 profile rather than a config that throws.

## Alternatives

1. **Stay Cloudflare-only and document the exits.** Rejected: the framework already declares AWS
   in `tsir.js`, in `@tsir/deploy`, and in three `@tsir/*` drivers. A declared-but-refused surface
   is worse than no surface, and the audit shows it is refused in code (`INF-007`).
2. **One lowest-common-denominator abstraction over every substrate.** Rejected: it would forbid
   DO hibernation, D1 batching, Lambda reserved concurrency and Step Functions' semantics — the
   exact capabilities that make each platform worth using (17 § 2.2, tier 3).
3. **Ship every driver at once.** Rejected by ADR-0012 and ADR-0027: Redis, MySQL, DynamoDB,
   workflow and Workers AI drivers stay `[PLANNED]`/`[PROPOSED]` until a workload demands them and
   a conformance run exists.
4. **Do nothing, keep ADR-0016 as the whole story.** Rejected: the audit found silent data loss
   (`INF-004`), a broken Postgres auth path (`INF-001`), a bundling landmine (`INF-002`) and a
   cancelled-background-work bug (`INF-006`) that together make even the Cloudflare-only profile
   unreliable.
5. **Put the worker kind in `@tsir/console` instead of `@tsir/deploy`.** Rejected: the deploy graph
   is a committed artefact (ADR-0026), and a unit kind that the graph cannot see is a unit that
   cannot be diffed or validated. Carried forward as `Q60` because the runner might still belong
   in `@tsir/queue`.
