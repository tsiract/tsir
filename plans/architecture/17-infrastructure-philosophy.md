# 17 — Infrastructure philosophy: Cloudflare-first, AWS-compatible, hybrid by design

> The promise this document makes: **a Tsir application picks a substrate — it does not
> inherit one.** Cloudflare is the default because it is the cheapest way to run the first
> thousand users; AWS is supported because it is where the next hundred thousand usually live;
> a hybrid of the two must be describable in `tsir.js` without forking a package. Portability is
> a property of the **seams**, not of the type signatures.
>
> Everything below is written against the code in `src/framework/` at `0.0.0`. Where the code
> and this document disagree, the code is wrong — that is what
> [`../tasks/16-infrastructure-hardening.md`](../tasks/16-infrastructure-hardening.md) exists for.

This document owns the cross-cutting infrastructure position. It is read together with:

- [`../reviews/2026-11-07-infrastructure-agnosticism-audit.md`](../reviews/2026-11-07-infrastructure-agnosticism-audit.md)
  — the source-code audit that produced `INF-001`…`INF-016`, and the evidence for every status
  label used here.
- [`../decisions/0030-hybrid-cloud-and-workload-substrates.md`](../decisions/0030-hybrid-cloud-and-workload-substrates.md)
  — the ADR that ratifies the decisions in § 2, § 9 and § 13.
- [`../decisions/0016-cloudflare-first-and-d1.md`](../decisions/0016-cloudflare-first-and-d1.md)
  — the earlier, database-scoped version of the same instinct.
- [`../modules/08-deploy.md`](../modules/08-deploy.md) — the emitters and unit graph.
- [`../modules/15-capabilities.md`](../modules/15-capabilities.md) — the driver contracts.

---

## 1. The thesis in one page

Three claims, each falsifiable, each with a cost.

**Claim 1 — Cloudflare-first is an economic decision, not a technical one.** The Workers paid
plan starts at $5/month and includes 10 million requests, 30 million CPU-milliseconds and zero
egress. There is no comparable entry point on AWS: a single NAT Gateway costs ~$33/month before
a byte of traffic, and RDS has no always-free tier since the 2025 free-plan change. For a
two-person team with no revenue, Cloudflare is the only serious default. What it is _not_ is a
runtime that can host every workload — § 8 is the list of things that must leave.

**Claim 2 — AWS compatibility has to mean something narrower than "we could port it".** A
TypeScript interface that compiles is not portability; `database/src/from-config.ts` currently
throws `DB_DRIVER_UNAVAILABLE` for `postgres` and `session-database.ts` emits `$1` twice in an
`UPDATE`, so the Postgres path is _declared_ and _broken_ (`INF-001`, `INF-003`). Compatibility
therefore means: the declared provider has a driver, the driver has a conformance test, and the
workload has a documented placement. Everything else is a plan, and is labelled `[PLANNED]`.

**Claim 3 — hybrid is first-class or it is a fork.** The realistic Tsir deployment in 2027 is
not "all Cloudflare" or "all AWS"; it is Workers at the edge for HTTP, SQS + Lambda for the
queue the edge cannot drain, and Postgres on RDS because the data outgrew D1. Today
`checkQueueConnections` **rejects** `sqs` whenever `cloudflare` is in `targets` — the framework
refuses the exact topology most users will want (`INF-007`). That is the definition of hybrid
being second-class, and fixing it is the point of this document.

### 1.1 What changes, and what does not

| Changes                                                  | Does not change                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| The declared substrate set (5 deployment profiles, § 13) | `(Request) => Promise<Response>` as the HTTP contract (ADR-0002)    |
| The number of runtime seams (7, § 9)                     | The dependency DAG and package boundaries (`02-monorepo.md`)        |
| The portability rules (8, § 2.1)                         | Capability drivers as a closed set (ADR-0015, ADR-0027)             |
| The queue and real-time driver matrix (§ 10, § 11)       | D1 as the default database, Postgres as the escape hatch (ADR-0016) |
| The number of deployment profiles (5, § 13)              | `separate` deploy units as the topology default (ADR-0005)          |

---

## 2. What "provider-agnostic" may and may not mean

The failure mode this section prevents is **false portability**: a `CacheDriver` interface, five
implementations, and no test that runs the same assertion against all five. Tsir's existing
conformance kits (`@tsir/cache`, `@tsir/queue`, `@tsir/storage`, `@tsir/mail`, `@tsir/notify`,
`@tsir/auth`) are the mechanism that makes a claim checkable — the rule below is that a driver
without a conformance run is not a driver, it is a file.

### 2.1 The eight portability rules

| #    | Rule                                                                                                                                                                                          | Enforced by                                    | Status       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------ |
| PR-1 | **Core contracts are Web-standard.** `Request`, `Response`, `ReadableStream`, `crypto.subtle`, `AbortSignal`, `URL`. No `node:` or `bun:` import may reach a core barrel.                     | `check-boundaries`, `make deps`, bundle probes | `[VERIFIED]` |
| PR-2 | **A provider-specific capability lives behind a port, or is documented as provider-specific.** Silence is not an option: `[PROVIDER-SPECIFIC]` is a status, not a defeat.                     | this document § 16, review checklist           | `[PARTIAL]`  |
| PR-3 | **Every driver runs the shared conformance kit.** A new driver ships with a green conformance run in the same PR.                                                                             | `src/framework/*/src/conformance.ts` + CI      | `[VERIFIED]` |
| PR-4 | **No portability tax on the happy path.** A Cloudflare-first app must not pay for an abstraction it does not use — subpath entrypoints and tree-shaking keep the cost at zero.                | `make surface`, `verify-dist` byte budgets     | `[VERIFIED]` |
| PR-5 | **Native capability outranks symmetry.** If Durable Objects solve real-time and nothing else does, use Durable Objects; do not invent a lowest-common-denominator API that loses hibernation. | ADR-0025, § 11                                 | `[VERIFIED]` |
| PR-6 | **Config declares substrate intent; code never sniffs the host to pick behaviour.** `detectTarget()` is for diagnostics and error text, not for branching business logic.                     | `INF-012`                                      | `[PARTIAL]`  |
| PR-7 | **A missing driver fails at boot with an actionable error**, never at the first request. No silent fallback to `memory`.                                                                      | `ERR` task family, `DB_DRIVER_UNAVAILABLE`     | `[PARTIAL]`  |
| PR-8 | **Requests are the only portable lifecycle assumption.** Anything that needs state between requests needs a named substrate (§ 8), not a module-level variable.                               | `INF-002`, `INF-006`                           | `[PARTIAL]`  |

### 2.2 Three tiers of portability

The word "agnostic" hides a spectrum. Tsir commits to tier 2 and refuses tier 3.

| Tier                             | Meaning                                                                                              | Tsir position                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Tier 1 — deployable anywhere** | Same artifact, any host, no config change. True of a container image and little else.                | Not promised. A Workers bundle is not a Lambda bundle at the byte level.                                                   |
| **Tier 2 — portable by seam**    | Same **application code**, a different **driver** or **adapter** per substrate, chosen in `tsir.js`. | **This is the promise.** § 9 defines the seven seams it rests on.                                                          |
| **Tier 3 — runtime-transparent** | Code cannot tell which substrate it runs on.                                                         | Explicitly rejected: it would forbid DO hibernation, D1 batching, Lambda reserved concurrency, and every other native win. |

---

## 3. Cloudflare-first

### 3.1 The declared first-class surface

Nine primitives are treated as **first-class**: they are the default in `tsir.js` presets, they
have a driver or adapter inside `src/framework/`, and a Cloudflare-first app can use all of them
without writing vendor glue.

| Primitive           | Tsir surface                             | Driver / adapter                                 | Status                                                                 |
| ------------------- | ---------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| **Workers**         | `@tsir/http` + `@tsir/deploy/cloudflare` | `fetch` handler + Wrangler emitter               | `[VERIFIED]` (bundle), `[LIMITATION]` (no deploy evidence, § 7)        |
| **Pages**           | static assets (`src/apps/frontpage`)     | Wrangler `assets` block                          | `[VERIFIED]`                                                           |
| **D1**              | `@tsir/database` (`d1.ts`)               | `drizzle-orm/d1`                                 | `[VERIFIED]` (no interactive tx — ADR-0016)                            |
| **KV**              | `@tsir/cache` (`cloudflare-kv`)          | binding passed by the app                        | `[VERIFIED]` (eventual consistency ~60 s)                              |
| **R2**              | `@tsir/storage` (`s3` by endpoint)       | SigV4 over `fetch`                               | `[PARTIAL]` — no native `R2Bucket` driver, ACL header bug (`INF-008`)  |
| **Durable Objects** | `@tsir/link/ws` rooms (ADR-0025)         | shape only; binding supplied by deploy           | `[PARTIAL]` — no emitter, no bridge from `@tsir/broadcast` (`INF-009`) |
| **Queues**          | `@tsir/queue` (`cloudflare-queues`)      | consumer + producer in `@tsir/deploy/cloudflare` | `[PARTIAL]` — batch ack loses messages (`INF-004`)                     |
| **Workflows**       | none                                     | —                                                | `[PLANNED]` — no workflow seam exists (§ 9.6)                          |
| **Cron Triggers**   | `@tsir/schedule` (`tick`)                | `[[triggers]]` crons in Wrangler                 | `[VERIFIED]`                                                           |
| **Workers AI**      | none                                     | —                                                | `[PROPOSED]` — binding pass-through only, no port                      |

### 3.2 What Cloudflare-first buys, concretely

1. **$0 egress.** R2 and Workers do not bill bandwidth. For an app whose cost curve is images and
   video, this single property can be the difference between $5/month and $400/month.
2. **One local simulator.** `wrangler dev` runs Workers, D1, KV, R2, Queues and DO together.
   There is no equivalent single-binary local stack on AWS (`sam local` covers Lambda + API
   Gateway only, and DynamoDB Local is a separate process).
3. **No idle cost.** Nothing bills while no request arrives. The AWS equivalents that do
   (NAT Gateway, ALB, RDS instance, ElastiCache node) are the four line items a bootstrapped
   team cannot pay.
4. **Atomicity of the deploy.** One artifact, one CLI, one rollback. `wrangler rollback` is a
   single command, and the emitted bundle is byte-identical to what was tested.

### 3.3 Where Cloudflare-first stops

Stated as constraints, not complaints — § 8 is the placement answer.

| Constraint                                                             | Consequence                                                                      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 128 MB memory per isolate                                              | No in-memory datasets, no image transcoding, no browser automation               |
| 10 ms CPU (Free) / 30 s default, 5 min max CPU per HTTP request (Paid) | PBKDF2 at 210k iterations crowds the Free tier (`INF-013`); no report generators |
| 6 concurrent outbound connections per request                          | Fan-out over 6 upstreams must go through a queue, not `Promise.all`              |
| No listening sockets                                                   | A WebSocket server must be a Durable Object, not a request handler               |
| No filesystem, no native binaries                                      | `ffmpeg`, `sharp`, `chromium` need Containers or a VM (`INF-015`)                |
| D1 has no interactive transactions                                     | `drizzle.transaction()` is a bug on D1, `batch()` is the primitive (ADR-0016)    |
| D1 single-writer per database                                          | Write throughput is one writer + read replicas; high-write tables need Postgres  |
| Queues `delaySeconds` ≤ 24 h, retention ≤ 14 d                         | Long-delay scheduling needs `@tsir/schedule` or Step Functions                   |

---

## 4. AWS compatibility

### 4.1 The declared compatibility surface

Eleven AWS services are in scope. "In scope" means a documented mapping, not necessarily a
shipped driver — the status column is the honest part.

| AWS service        | Tsir surface                                          | Status                                                                                          |
| ------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Lambda**         | `@tsir/deploy` Lambda emitter (`sam.ts`, `lambda.ts`) | `[VERIFIED]` (bundle), `[PARTIAL]` (SNS/EB/StepTask triggers dropped — `INF-005`)               |
| **API Gateway**    | `AWS::Serverless::HttpApi` in the SAM template        | `[PARTIAL]` — WebSocket route is invalid SAM (`INF-005`)                                        |
| **SQS**            | `@tsir/queue` (`sqs`)                                 | `[PARTIAL]` — no SigV4 `fetch` client; needs the SDK or a custom signer                         |
| **SNS**            | `@OnSns` decorator → trigger                          | `[PARTIAL]` — trigger declared, not bundled (`INF-005`)                                         |
| **EventBridge**    | `@OnEventBridge` decorator → trigger                  | `[PARTIAL]` — invalid `EventPattern` YAML (`INF-005`)                                           |
| **Step Functions** | none                                                  | `[PLANNED]` — no workflow seam (§ 9.6)                                                          |
| **S3**             | `@tsir/storage` (`s3`)                                | `[PARTIAL]` — ACL header rejected under `BucketOwnerEnforced` (`INF-008`)                       |
| **DynamoDB**       | none                                                  | `[PROPOSED]` — not a `@tsir/database` dialect; KV-shaped use is `@tsir/cache`                   |
| **RDS (Postgres)** | `@tsir/database/postgres`                             | `[PARTIAL]` — driver works, config path throws (`INF-003`), auth SQL bug (`INF-001`)            |
| **ElastiCache**    | `@tsir/cache` (`redis` driver, app-supplied client)   | `[VERIFIED]` on Bun/Lambda; `[LIMITATION]` on Workers without a `fetch`-based client (ADR-0027) |
| **App Runner**     | none                                                  | `[PROPOSED]` — covered by the container profile (§ 13, P5)                                      |

### 4.2 What "AWS-compatible" must mean for this codebase

Three acceptance conditions, and the third is the one that is currently missing:

1. **A declared service has a driver or an emitter**, and the emitter's output is validated
   (`make deploy-check` plus the SAM schema).
2. **The driver runs the conformance kit** against a real service in a CI job, or against a
   documented emulator. `LocalStack` is acceptable for SQS/SNS/S3 at the level of the
   conformance suite; it is not acceptable as evidence of a working deploy.
3. **No AWS SDK on the Workers path.** `@tsir/deploy/internal.ts` hardcodes
   `@aws-sdk/client-sns` and `@aws-sdk/client-lambda`, which cannot be bundled into a Workers
   isolate. Signature V4 over `fetch` is ~120 lines and already proven in `@tsir/storage`
   (`INF-007`). The SDK is allowed in the Lambda-side emitter, never in a runtime barrel.

---

## 5. First-class hybrid

### 5.1 The four hybrids that must work

A hybrid is not one topology. These four are the ones real teams build, listed with the blocker
that currently prevents each.

| #   | Hybrid                                         | Why it is built                                      | Blocked by                                                                                                                |
| --- | ---------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| H1  | **Workers HTTP → SQS queue**                   | Edge latency + a queue the edge cannot drain in 30 s | `checkQueueConnections` rejects `sqs` when `cloudflare` is a target (`INF-007`)                                           |
| H2  | **Workers HTTP → RDS Postgres via Hyperdrive** | D1 write ceiling or Postgres-only features           | `createConnectionsFromConfig` throws for `postgres`; eager boot-time pooling breaks request-scoped Hyperdrive (`INF-003`) |
| H3  | **Cloudflare Cron → Lambda job**               | Full Node runtime for a nightly batch                | No cross-cloud trigger kind; `manual` triggers dropped in `adapterTriggers()` (`INF-005`)                                 |
| H4  | **Lambda HTTP → D1 (via Cloudflare API)**      | AWS-first shop with edge data                        | Not designed for; D1 HTTP API is a `[LIMITATION]` (extra hop, 30 s statement cap)                                         |

H1, H2 and H3 are engineering work with known shape. H4 is listed to be explicit that it is
**not** a supported topology — the supported direction is Cloudflare at the edge.

### 5.2 What hybrid costs

- **Two secret stores.** `@tsir/deploy` separates Wrangler secrets from SAM parameters
  (`[VERIFIED]`); a hybrid doubles the surface and needs one owner per secret.
- **Two observability sinks.** `@tsir/pulse` is provider-independent, so this is a config
  problem, not a code problem — but the correlation id must cross the cloud boundary
  (`traceparent`, `[VERIFIED]`).
- **No distributed transaction.** The outbox pattern (`@tsir/events` writer, `[VERIFIED]`) is the
  only correct answer; it is not optional in a hybrid.
- **Two clocks.** Cron is UTC on both platforms; `DPL_CRON_NOT_UTC` already refuses a local-time
  schedule at build time (`[VERIFIED]`).

---

## 6. Free, free-tier, trial and paid

The distinction that matters for a bootstrapped team is not the price list, it is **what happens
when you exceed it**. Four classes:

| Class         | Definition                                              | Failure when exceeded                                | Example                                              |
| ------------- | ------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| **Free**      | No payment method, no expiry, no credit card.           | Hard stop, usually with an error the app must handle | Cloudflare Free plan, GitHub Actions minutes         |
| **Free tier** | Monthly allowance inside a paid account; card required. | Automatic overage billing                            | SQS 1 M requests/month, R2 10 GB-month               |
| **Trial**     | Time-boxed credits.                                     | Total stop at expiry, sometimes with data deletion   | AWS Free Plan ($100 + $100 / 6 months), Fly.io trial |
| **Paid**      | Pure usage or subscription, no allowance.               | Bill                                                 | NAT Gateway, RDS, ElastiCache, App Runner            |

> **The rule for this repository:** a capability may be described as usable on the Free plan only
> if a test or a measured run exists on the Free plan. `INF-013` is the counter-example — PBKDF2
> at 210k iterations is fine on Paid and risks `Error 1102` on Free.

### 6.1 Cloudflare (Oct 2026)

| Service         | Free / Free-tier allowance                                                          | Paid entry point                                                  | Beyond-allowance price                             |
| --------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| Workers         | 100 k req/day, 10 ms CPU/req, 50 subrequests, 5 crons, 200 k log lines/day (3 d)    | $5/mo: 10 M req + 30 M CPU-ms, 10 k subrequests, 30 s default CPU | +$0.30/M req, +$0.02/M CPU-ms, $0 egress           |
| D1              | 10 DBs, 500 MB/DB (5 GB total), 5 M row reads/day, 100 k writes/day, 50 queries/inv | 100 k DBs (+$0.10/DB), 10 GB/DB, 25 B reads, 50 M writes/mo       | +$0.001/M reads, +$1.00/M writes, $0.75/GB-mo      |
| KV              | 1 GB, 100 k reads/day, 1 k writes/day                                               | 10 M reads, 1 M writes, 1 GB included                             | +$0.50/M reads, +$5.00/M writes, $0.50/GB-mo       |
| R2              | 10 GB-month, 1 M Class A, 10 M Class B, **$0 egress**                               | $0.015/GB-mo, $4.50/M Class A, $0.36/M Class B                    | Infrequent access $0.01/GB-mo + $0.01/GB retrieval |
| Queues          | 10 k operations/day, 24 h retention                                                 | 1 M ops/mo (+$0.40/M per 64 KB chunk)                             | ~3 ops/message ⇒ ≈$1.20/M messages                 |
| Durable Objects | SQLite-backed: 100 k req/day, 13 k GB-s/day, 5 GB (1 GB/object)                     | 1 M req/mo ($0.15/M), 400 k GB-s/mo ($12.50/M GB-s)               | $0 outbound WS messages; $0 idle with hibernation  |
| Workflows       | 3 k steps/day, 1 GB-month                                                           | 500 k steps/mo                                                    | +$0.80/100 k steps, +$0.20/GB-mo                   |
| Hyperdrive      | 100 k queries/day                                                                   | unlimited, no extra charge                                        | —                                                  |
| Containers      | none                                                                                | 25 GiB-h + 375 vCPU-min/mo included                               | $0.0000025/GiB-s, $0.000020/vCPU-s, 1 TB egress    |
| Workers AI      | 10 k Neurons/day                                                                    | —                                                                 | +$0.011/1 k Neurons                                |

### 6.2 AWS (2026, post-July-2025 free-plan change)

| Service        | Free / Free-tier allowance                           | Price beyond                                                       |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| Lambda         | 1 M requests + 400 k GB-s/month (Always Free)        | +$0.20/M requests, $0.0000166667/GB-s (x86), $0.0000133334 (ARM)   |
| API Gateway    | none for HTTP/REST/WS beyond a 12-month grant        | HTTP $1.00/M, REST $3.50/M, WS $1.00/M messages + $0.25/M conn-min |
| SQS            | 1 M requests/month                                   | +$0.40/M                                                           |
| SNS            | 1 M publishes + 100 k HTTP deliveries/month          | usage-based                                                        |
| EventBridge    | 14 M custom events/month                             | +$1.00/M                                                           |
| Step Functions | 4 k standard transitions/month                       | $25/M standard, $1/M express                                       |
| S3             | none (12-month 5 GB grant only)                      | $0.023/GB-mo + $0.09/GB egress after 100 GB/mo                     |
| DynamoDB       | 25 GB + 25 RCU/WCU provisioned                       | on-demand request pricing                                          |
| RDS            | **none** — no Always Free tier since the 2025 change | instance-hours + storage + I/O                                     |
| ElastiCache    | none                                                 | node-hours                                                         |
| App Runner     | none                                                 | $0.064/vCPU-h + $0.007/GB-h while active                           |
| NAT Gateway    | none — ~$33/month **plus** $0.045/GB processed       | per-hour + per-GB                                                  |

### 6.3 The TCO scenarios that decide the default

Three honest scenarios, computed from the tables above, excluding labour.

| Scenario                                                                                           | Cloudflare-first (P1)                            | AWS-first (P2)                                                                    | Verdict                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **S1** — hobby: 100 k req/mo, 200 MB data, 5 GB egress                                             | **$0**                                           | ~$34 (NAT GW) + RDS or DynamoDB + S3                                              | Cloudflare wins by an order of magnitude             |
| **S2** — small SaaS: 5 M req/mo, 3 GB D1, 100 GB egress, 2 M queue messages                        | **~$5**                                          | ~$60–90 (ALB $18, 2× RDS t4g.micro ~$25, S3 egress ~$9, NAT if VPC-attached ~$33) | Cloudflare wins ~10×                                 |
| **S3** — growth: 80 M req/mo, 40 GB Postgres, 2 TB egress, 40 M queue messages, 1 always-on worker | **~$60** (Workers $26 + Postgres elsewhere + R2) | **~$180** (ALB, RDS, SQS, egress, 1 Fargate task)                                 | Cloudflare still cheaper, but the gap narrows to ~3× |

The conclusion that matters: **the AWS-first profile costs ~$33/month before it serves a single
request** because a private-subnet Lambda needs a NAT Gateway (or VPC endpoints, which are not
free either). A project that is not yet covering its own domain name should not be on P2.

### 6.4 Lock-in and migration difficulty

Scored per primitive: **1 = portable by config**, **2 = portable with a rewrite of the data
access layer**, **3 = effectively a rewrite**.

| Primitive                      | Lock-in score | Migration cost, in practice                                                                    |
| ------------------------------ | ------------- | ---------------------------------------------------------------------------------------------- |
| Workers (HTTP)                 | 1             | Same handler runs on Bun and Lambda today (`@tsir/http` is Web-standard)                       |
| KV                             | 1             | `@tsir/cache` port; Upstash/Redis is a driver swap                                             |
| R2                             | 1             | S3-compatible API both ways; ACL header is the only defect (`INF-008`)                         |
| Queues                         | 1             | `@tsir/queue` port + conformance kit                                                           |
| D1                             | 1–2           | SQLite → Postgres is a **schema** migration, not a driver swap (ADR-0016); data volume decides |
| Durable Objects                | 2             | Room semantics survive (ADR-0025); the coordination substrate is genuinely different           |
| Hyperdrive                     | 1             | It is a pooler; AWS-side equivalent is RDS Proxy, also a pooler                                |
| Workflows / Step Functions     | 3             | No shared model exists; whichever is used first will shape the code                            |
| Workers AI                     | 3             | Model, tokenizer and API shape are vendor-specific by nature                                   |
| Cloudflare Access / Zero Trust | 2             | Auth is `@tsir/auth`'s job; the vendor layer is a config block                                 |

### 6.5 Where "free" is a trap

- **Cloudflare KV writes: 1,000/day on Free.** A per-request cache write exhausts this by
  mid-morning. Cache writes must be load-bearing decisions, not defaults.
- **D1: 100 k writes/day on Free.** A queue worker that writes one row per message burns it in
  100 k messages. The `database` queue driver on D1 is therefore a Free-tier anti-pattern.
- **Queues: 10 k operations/day on Free**, and a message costs ~3 operations. That is ~3,300
  messages/day — a real workload ceiling, not a rounding error.
- **Bytes: 6 concurrent outbound connections per Worker request.** Six parallel `fetch` calls are
  fine; `Promise.all` over 50 is not, regardless of plan.
- **AWS "Always Free" does not include the network plumbing.** NAT Gateway, ALB, and data
  transfer are paid from byte one.

---

## 7. Runtime and execution physics: Workers vs Lambda vs Containers

The comparison that matters is not features, it is **what the platform does to your process**.

### 7.1 Execution model

| Dimension                 | Cloudflare Workers                                                       | AWS Lambda                                                | Containers / VMs (Fargate, Cloud Run, Fly, Hetzner)   |
| ------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------- |
| Isolation unit            | V8 isolate (no OS process)                                               | microVM (Firecracker) + a Node/Bun process                | Full container/VM, own kernel namespace               |
| Cold start                | ~0–5 ms (isolate reuse, no JIT cost)                                     | 100–900 ms Node/Bun; ~1 s+ for large bundles/images       | 0 ms if always-on; 1–30 s if scaled to zero           |
| Memory                    | 128 MB per isolate, fixed                                                | 128 MB–10,240 MB in 1 MB steps                            | Whatever you pay for                                  |
| CPU                       | 10 ms/req (Free), 30 s default / 5 min max (Paid); 15 min for Cron/Queue | Proportional to memory: 1 vCPU at 1,769 MB; up to ~6 vCPU | Allocated cores; dedicated                            |
| Wall clock                | Unbounded while the client is connected; CPU-metered                     | Hard 900 s timeout                                        | Unbounded                                             |
| Filesystem                | none                                                                     | 512 MB–10 GB `/tmp`, ephemeral                            | Persistent disk / volume                              |
| Listening sockets         | none                                                                     | none                                                      | yes                                                   |
| Outbound concurrency      | 6 concurrent connections per request                                     | thousands (NAT-limited)                                   | thousands                                             |
| Outbound TCP              | `connect()` via `cloudflare:sockets`                                     | full                                                      | full                                                  |
| WebSockets (inbound)      | yes, via Durable Objects / `WebSocketPair`                               | **no** (API Gateway WS is a separate service)             | yes                                                   |
| Background after response | `waitUntil`, 30 s budget                                                 | nothing after handler returns; use `InvokeAsync`/queue    | the process keeps running                             |
| Scheduled execution       | Cron Triggers (5 on Free)                                                | EventBridge Scheduler / rules                             | cron in-container or an external scheduler            |
| Batch size / payload      | request body to 100 MB (platform-dependent)                              | 6 MB sync, 200 MB streamed, 1 MB async                    | unlimited                                             |
| Env vars                  | bindings + vars (no 4 KB SQS-style limit)                                | 4 KB total                                                | anything                                              |
| Native binaries           | no                                                                       | yes (in a layer or an image)                              | yes                                                   |
| Billing unit              | requests + CPU-ms                                                        | requests + GB-s (memory × time)                           | instance-hours (+ vCPU-s on Cloud Run/Container Apps) |

### 7.2 The four numbers that decide architecture

1. **6 concurrent outbound connections.** Not a documentation footnote — a hard ceiling per
   Workers request. Fan-out belongs in a queue.
2. **30 s `waitUntil`.** Any "fire and forget" longer than that must be a queue message, or it is
   a silent data-loss bug (`INF-006`).
3. **900 s Lambda timeout.** Reports, transcodes and crawls above 15 minutes cannot be a Lambda
   invocation, full stop.
4. **1,769 MB = 1 vCPU on Lambda.** Node's PBKDF2 on Lambda at 128 MB is ~10× slower than at
   1,769 MB. The Workers PBKDF2 problem (`INF-013`) and the Lambda CPU problem are the same
   problem: **hashing cost is a function of the substrate's CPU allocation.**

### 7.3 Consequences recorded for this codebase

| Consequence                                                             | Where it lands                                           |
| ----------------------------------------------------------------------- | -------------------------------------------------------- |
| `RequestContext` needs `waitUntil` and a per-request `env` carrier      | `INF-006`, `INF-001` in `16-infrastructure-hardening.md` |
| Background work must be a queue message, never an unawaited promise     | `INF-006`, app audit of `admin.product.com` (`INF-016`)  |
| Password hashing needs an iteration-count policy per substrate          | `INF-013`                                                |
| A "long-running worker" target is a real deploy unit, not a Lambda      | § 9.3, `INF-012`                                         |
| Cloudflare bundle budget must track platform reality, not a stale 1 MiB | `INF-014`                                                |

---

## 8. Workloads that do not fit a short-lived runtime

Columns: **CF** = native Cloudflare, **AWS** = native AWS serverless, **MQ** = managed queue or
workflow, **CTR** = containers/VMs, **SH** = self-hosted worker on your own box, **HYB** =
hybrid. ✅ fits, ⚠️ fits with a documented ceiling, ❌ does not fit.

| Workload                                          | CF  | AWS | MQ  | CTR | SH  | HYB | The honest note                                                                                       |
| ------------------------------------------------- | --- | --- | --- | --- | --- | --- | ----------------------------------------------------------------------------------------------------- |
| Request/response API                              | ✅  | ✅  | ❌  | ✅  | ✅  | ✅  | The only row where every substrate is genuinely good                                                  |
| Short background job (< 15 min, CPU-light)        | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | CF Queues consumer: 15 min wall, 5 min CPU (`[VERIFIED]` once `INF-004` is fixed)                     |
| Long-running batch / ETL (> 15 min)               | ❌  | ⚠️  | ✅  | ✅  | ✅  | ✅  | Lambda caps at 900 s; Workflows has unbounded step wall time but per-step CPU limits                  |
| WebSocket fan-out to thousands                    | ✅  | ⚠️  | ❌  | ✅  | ✅  | ✅  | DO is the best cheap option; APIGW WS caps connections at 2 h and 10 min idle                         |
| Persistent real-time session with in-memory state | ⚠️  | ⚠️  | ❌  | ✅  | ✅  | ✅  | DO gives you a stateful object; anything bigger is a container                                        |
| Large file upload (GB-scale)                      | ⚠️  | ⚠️  | ❌  | ✅  | ✅  | ✅  | Workers can stream, but no filesystem and a 6-connection cap; presigned PUT is the answer (`INF-008`) |
| Video/audio transcoding                           | ❌  | ❌  | ⚠️  | ✅  | ✅  | ✅  | `ffmpeg` needs a binary. Cloudflare Containers, Fargate, or a Hetzner box                             |
| CPU-intensive compute (PDF, zip, image)           | ❌  | ⚠️  | ❌  | ✅  | ✅  | ✅  | Workers CPU caps make this a guaranteed `1102`; Lambda at ≥ 1,769 MB or a container                   |
| Continuous polling / sync loop                    | ❌  | ❌  | ⚠️  | ✅  | ✅  | ✅  | Needs a process that lives longer than one request; Cron at 1-minute granularity is the CF ceiling    |
| Scheduled nightly report                          | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | Cron Trigger + queue; the report generation goes to MQ or CTR                                         |
| Stateful worker with warm caches                  | ❌  | ⚠️  | ❌  | ✅  | ✅  | ✅  | A Lambda "warm" container is luck, not a guarantee; a container is a guarantee                        |
| Outbound fan-out to > 6 upstreams                 | ⚠️  | ✅  | ✅  | ✅  | ✅  | ✅  | Workers cap is per-request; split across queue messages                                               |
| Long-lived DB connection pool                     | ❌  | ⚠️  | ❌  | ✅  | ✅  | ✅  | Hyperdrive/RDS Proxy exist precisely because both serverless substrates cannot pool (`INF-003`)       |
| Browser automation / scraping                     | ❌  | ❌  | ⚠️  | ✅  | ✅  | ✅  | Needs Chromium; Cloudflare Browser Rendering is a separate product, not a Tsir driver (`[PROPOSED]`)  |
| ML inference (large model)                        | ⚠️  | ⚠️  | ❌  | ✅  | ✅  | ✅  | Workers AI is `[PROPOSED]`, vendor-locked, and CPU/time-boxed                                         |
| Multi-step saga with human approval               | ⚠️  | ✅  | ✅  | ✅  | ✅  | ✅  | CF Workflows / Step Functions; no Tsir seam yet (§ 9.6)                                               |

**The placement rule that follows:** _a workload enters the Workers runtime only if it completes
inside the CPU budget of a single request; otherwise it enters a queue message, and a queue
message is drained by whichever substrate the profile in § 13 names._

---

## 9. The seven runtime seams

A **seam** is the only place where a substrate name is allowed to appear in application-visible
config. Seven, and no more — every additional seam is a permanent abstraction tax.

| #   | Seam                    | Contract today                                                     | Substrates                                                 | Status                                                  |
| --- | ----------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------- |
| S1  | **HTTP**                | `(Request) => Promise<Response>` + `@tsir/http` pipeline           | Workers, Lambda (API GW v2), Bun/Node, containers          | `[VERIFIED]`                                            |
| S2  | **Request lifecycle**   | `RequestContext` (`env`, `clientIp`, `waitUntil`)                  | per runtime adapter                                        | `[PARTIAL]` — `waitUntil` missing (`INF-006`)           |
| S3  | **Background job**      | `@tsir/queue` port + 5 drivers                                     | memory, sync, database, CF Queues, SQS                     | `[PARTIAL]` (`INF-004`)                                 |
| S4  | **Long-running worker** | none                                                               | container/VM worker process                                | `[PLANNED]` (`INF-012`)                                 |
| S5  | **Scheduled task**      | `@tsir/schedule` registry + `tick` + lock port                     | CF Cron, EventBridge Scheduler, in-process ticker          | `[VERIFIED]`                                            |
| S6  | **Real-time**           | room contract (ADR-0025) + `@tsir/broadcast`                       | Durable Objects, APIGW WS, dedicated WS server, containers | `[PARTIAL]` (`INF-009`)                                 |
| S7  | **Persistence**         | `@tsir/database` (dialect + connection), `@tsir/storage` disk port | D1, Postgres, MySQL `[PLANNED]`, S3/R2/MinIO, local disk   | `[PARTIAL]` (`INF-001`–`INF-003`, `INF-008`, `INF-010`) |

### 9.1 Why not an eighth seam for cache

`@tsir/cache` is a **capability driver**, not a runtime seam (§ 10's axis is identical). It needs
no deploy-graph knowledge: the app supplies the binding or the client, exactly as ADR-0027 says.
Adding a seam would mean the deploy planner had to know about Redis.

### 9.2 Why S2 is a seam and not a utility

`waitUntil` and `env` are the two things a Web-standard handler cannot express. Without them,
"background" work is an unawaited promise, which on Workers is cancelled when the response
completes and on Lambda is frozen mid-flight when the handler resolves. `INF-006` is P1 because
every app that logs asynchronously (including the flagship admin app, `INF-016`) is silently
losing work today.

### 9.3 Why S4 does not exist yet, and why it must

A Cloudflare Queue consumer has a 15-minute wall clock and a 5-minute CPU budget. A nightly
report, a transcoding job and a sync loop all exceed it. Without S4 the answer for those is "write
a second project", which is precisely the coupling this document is meant to remove. S4's shape
is small: a `worker` deploy unit kind, a Bun/Node entry module, and a `drainLoop()` around the
same `@tsir/queue` port — not a new scheduler, not a new driver.

### 9.4 Why S6 is a contract, not a driver

Rooms are shaped like Durable Objects (ADR-0025) because nothing else gives hibernating
fan-out at that price. The seam is therefore "a room is an addressable object with a socket
attach + broadcast surface", and each substrate supplies its own transport:
DO for Workers, a `ws` server for Node containers, APIGW WS + DynamoDB for AWS. `INF-009` is
that the two current implementations (`link/src/rooms.ts` and `broadcast/src/websocket.ts`) do
not share the contract, and one of them leaks subscriptions.

### 9.5 Why S7 is one seam and not three

Database, cache and storage are different engines but the same decision — "which named
connection does this call use". ADR-0019 already puts all three behind named connections; making
them three seams would triple the config surface for one conceptual choice.

### 9.6 Workflow orchestration is deliberately not a seam yet

CF Workflows, Step Functions, Temporal and a DB-backed saga table have no shared vocabulary
(steps vs transitions vs activities). Building the seam before there are two real implementations
would produce an API that fits none of them. Status: `[PROPOSED]`, questions `Q61` and `Q62`.

### 9.7 What we deliberately do not abstract

| Not abstracted                    | Why                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Durable Object class definitions  | The DO API _is_ the capability; wrapping it loses hibernation, alarms and RPC (ADR-0025) |
| Wrangler `wrangler.toml` bindings | Generated, validated and diffed (`ADR-0026`); a neutral format would be a second dialect |
| SAM/GCD template shape            | Provider-native by definition; validated against the provider's schema                   |
| `Workers AI` model calls          | Vendor-specific by nature; a `[PROVIDER-SPECIFIC]` label is more honest than a fake port |
| D1 `batch()` vs `transaction()`   | The difference is the engine's transactionality, not an implementation detail (ADR-0016) |

---

## 10. Queue and background-job architecture

### 10.1 The comparison axes

Twelve axes, chosen because each one has bitten a real system: dispatch model, serialisation,
retry policy, backoff, dead-letter, timeout, visibility/locking, idempotency, concurrency,
delayed/scheduled messages, scaling, observability, graceful shutdown.

### 10.2 The matrix

| Axis                 | Cloudflare Queues                               | AWS SQS (standard)                              | Redis (BullMQ-style)                      | DB-backed (`@tsir/queue/database`)         | Self-hosted broker (NATS JetStream, RabbitMQ)      |
| -------------------- | ----------------------------------------------- | ----------------------------------------------- | ----------------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| Dispatch             | push to consumer (HTTP `queue` handler) or pull | pull (`ReceiveMessage`) / Lambda event source   | pull by a worker process                  | pull with `SKIP LOCKED` / D1 batch         | push (RabbitMQ) / pull (JetStream)                 |
| Serialisation        | JSON body, 128 KB message                       | JSON/binary, 256 KB                             | any (usual: JSON), memory-bound           | table row + JSON payload                   | any, broker-sized                                  |
| Retry                | `retry()` / `retryAll()` with `delaySeconds`    | redrive policy, `ApproximateReceiveCount`       | per-job `attempts` + custom backoff       | attempts column, worker-driven             | redelivery + DLQ policy                            |
| Backoff              | fixed delay per retry; no exponential built in  | fixed delay; no exponential built in            | exponential/fibonacci, jittered, built in | worker-defined                             | redelivery backoff, queue-level                    |
| Dead-letter          | manual: a DLQ queue + explicit send             | native DLQ after `maxReceiveCount`              | native failed set + retention             | a `failed` status column                   | native DLX / advisory                              |
| Timeout              | 15 min wall, 5 min CPU per invocation           | visibility timeout ≤ 12 h                       | `lockDuration`, renewed by a heartbeat    | `leaseMs` — **no heartbeat renewal today** | consumer ack timeout                               |
| Visibility / locking | per-message lease + `ack`                       | per-message visibility timeout                  | per-job lock with renewal                 | row lease (`lock_until`)                   | broker-managed                                     |
| Idempotency          | caller's responsibility (at-least-once)         | caller's responsibility                         | `jobId` dedupe + `removeOnComplete`       | unique key + row state                     | caller's responsibility (JetStream: `Nats-Msg-Id`) |
| Concurrency          | 250 concurrent pushes/queue (platform)          | unbounded consumers; `maxConcurrency` on Lambda | worker concurrency setting                | poller count                               | prefetch window                                    |
| Delayed / scheduled  | `delaySeconds` ≤ 24 h                           | `DelaySeconds` ≤ 15 min                         | delayed set, arbitrary                    | `available_at` column, arbitrary           | scheduled delivery, arbitrary                      |
| Scaling              | automatic, platform-managed                     | automatic; Lambda event source scales           | you scale the worker pool                 | you scale the poller / DB writer           | you scale consumers                                |
| Observability        | Workers Logs + Queue metrics; no DLQ dashboard  | CloudWatch `Approximate*` metrics               | Bull Board-style UI from the job store    | a SQL query                                | broker metrics / exporter                          |
| Graceful shutdown    | batch-based; `retryAll()` is the safety net     | visibility timeout returns unacked messages     | `worker.close()` drains in-flight         | lease expiry re-queues                     | `SIGTERM` + drain                                  |

### 10.3 What `@tsir/queue` actually does today

| Driver                     | Status       | Gaps                                                                                                                                                    |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory`                   | `[VERIFIED]` | Single process; test double only                                                                                                                        |
| `sync`                     | `[VERIFIED]` | Runs inline; a test and boot-time convenience, never production                                                                                         |
| `database`                 | `[VERIFIED]` | Postgres `SKIP LOCKED` path is sound; **static `leaseMs` with no heartbeat** means a slow job is re-delivered                                           |
| `cloudflare-queues`        | `[PARTIAL]`  | Whole-batch `ackAll`/`retryAll` plus a `batchSize: 1` drain silently drops the rest of the batch (`INF-004`)                                            |
| `sqs`                      | `[PARTIAL]`  | Needs the AWS SDK for SigV4; no `fetch`-based signer (`INF-007`)                                                                                        |
| Redis                      | `[PLANNED]`  | No driver **on the queue port**; an app-supplied client is the ADR-0027-compatible path. The **cache** port's Redis driver ships and passes conformance |
| Workflows / Step Functions | `[PLANNED]`  | Different shape (steps, not messages); § 9.6                                                                                                            |

### 10.4 Decision rules

1. **Default to `cloudflare-queues` in P1, `sqs` in P2, `database` in P4.** No app should ship a
   broker it has to operate before it has users.
2. **A job longer than 24 h of delay cannot be a queue message.** Use `@tsir/schedule` (Cron) or a
   workflow.
3. **At-least-once is the only guarantee available across all five substrates.** Handlers must be
   idempotent; `@tsir/events`' outbox writer exists for exactly this reason.
4. **Every queue gets a DLQ, on every substrate**, even where the platform does not enforce one.
   Cloudflare has no native DLQ — the driver must implement one as a second queue.
5. **Graceful shutdown is a driver responsibility.** `worker.stop()` must stop accepting, finish
   in-flight, and release leases; the shutdown order is recorded in `@tsir/core`'s lifecycle.

---

## 11. WebSocket and real-time architecture

### 11.1 The comparison

| Axis                        | Cloudflare Durable Objects                          | API Gateway WebSockets                             | Dedicated Node/Bun WS server             | Containers (Fargate/Cloud Run)              | Self-hosted processes            |
| --------------------------- | --------------------------------------------------- | -------------------------------------------------- | ---------------------------------------- | ------------------------------------------- | -------------------------------- |
| Persistence                 | Hibernation: WebSocket stays open at $0 while idle  | 2 h max connection, 10 min idle timeout            | Unlimited while the process lives        | Unlimited while the task lives              | Unlimited                        |
| Ownership                   | One object per room/actor; single-threaded          | One connection id per socket; a Lambda per message | One process owns its sockets             | One task owns its sockets                   | One process owns its sockets     |
| Scaling                     | Automatic placement; ~1 k req/s per object          | Automatic; connection state must go to DynamoDB    | Manual: sticky rooms or a shared pub/sub | Horizontal with a shared pub/sub            | Manual                           |
| State                       | In-object, durable (SQLite/KV), survives eviction   | None — every message is a new invocation           | In-process memory                        | In-process memory                           | In-process memory                |
| Broadcast                   | Native, in-object, `$0` outbound messages           | Requires `PostToConnection` loop, $1.00/M messages | Native fan-out in-process                | Native in-process + a broker for cross-task | Native in-process + a broker     |
| Reconnection                | Client-driven; alarms + `setWebSocketAutoResponse`  | Client-driven; no server-side session              | Client-driven                            | Client-driven                               | Client-driven                    |
| Heartbeat                   | DO auto-ping (free)                                 | Protocol ping; idle timeout 10 min                 | `ws.ping()` in-process                   | `ws.ping()`                                 | `ws.ping()`                      |
| Auth                        | At upgrade, in the Worker; `Sec-WebSocket-Protocol` | `$connect` route authorizer                        | At upgrade                               | At upgrade                                  | At upgrade                       |
| Authz per message           | In-object check                                     | Every message re-invokes — check again             | In-process                               | In-process                                  | In-process                       |
| Cleanup                     | `webSocketClose`/`webSocketError` handlers          | `$disconnect` route; unreliable on abrupt drops    | `close` event                            | `close` event                               | `close` event                    |
| Delivery guarantee          | Ordered per socket, at-most-once                    | Ordered per connection, at-most-once               | Ordered per socket, at-most-once         | Ordered per socket, at-most-once            | Ordered per socket, at-most-once |
| Cross-instance coordination | In-object (no cross-DO chat without a hub)          | DynamoDB as the registry                           | Needs Redis/pub-sub                      | Needs Redis/pub-sub                         | Needs Redis/pub-sub              |
| Cost shape                  | $0 idle (hibernation), $0 outbound messages         | $1.00/M messages + $0.25/M connection-minutes      | Instance-hours                           | Task-hours                                  | Server-hours                     |

### 11.2 The bridge architecture

Two packages exist and they do not share a model. The target is **one contract, two
transports**, and the contract is already written down in ADR-0025.

```
                       application code
                              │
                ┌─────────────┴──────────────┐
                │  Room contract (ADR-0025)  │   attach(socket) · broadcast(msg) · presence
                └─────────────┬──────────────┘
                              │
        ┌─────────────────────┼──────────────────────┐
        │                     │                      │
  @tsir/link/ws         @tsir/broadcast        adapter: AWS
  Durable-Object shape  in-process + fanout    APIGW WS + DynamoDB registry
  (@tsir/deploy emits   (app-supplied Redis
   the DO class)         or Pusher client)
```

Rules that make the bridge honest:

1. **`@tsir/link/ws` owns the contract; `@tsir/broadcast` becomes a subscriber.** Today the two
   are parallel implementations, and `broadcast/src/websocket.ts` discards the disposer returned
   by `broadcaster.subscribe()` on close — a leak that repeats per connection (`INF-009`).
2. **Presence is not process-local.** A `Set` in one isolate is invisible to every other isolate.
   Presence must be a room-owned value (DO storage) or a shared store (Redis). Status:
   `[PARTIAL]` — the in-memory implementation stays, documented as single-instance only.
3. **Fan-out across rooms needs a hub or a broker.** Two DOs cannot see each other's sockets
   without a hub DO or a Redis pub/sub hop; this must be stated in the room docs rather than
   discovered in production.
4. **No APIGW WebSocket emitter until the SAM template is valid.** `sam.ts` currently attaches
   WebSocket routes to `AWS::Serverless::HttpApi`, which does not support them (`INF-005`).

### 11.3 Lifecycle, stated as a contract

| Phase        | Requirement                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| Authenticate | At upgrade only. Reject with 401 before the socket is accepted; never accept-then-close.                   |
| Admit        | Room membership is checked once and re-checked on every privileged message.                                |
| Heartbeat    | Server-side ping at ≤ 30 s; a socket that misses two pings is closed and cleaned up.                       |
| Deliver      | Ordered per socket, at-most-once. A sender is never promised that a message was received.                  |
| Disconnect   | Cleanup runs on `close`, on `error`, **and** on lease/alarm expiry — the third case is the one that leaks. |
| Reconnect    | Client-driven with backoff; the server keeps no per-client session state across sockets.                   |
| Shutdown     | `SIGTERM` → stop accepting, let in-flight broadcasts finish, close sockets with 1001.                      |

---

## 12. Multiple configurable connections

ADR-0019 established named connections for database, cache and queue. This section records the
**runtime** truth, because ADR-0019 is a design decision, not a guarantee.

### 12.1 The model

```
tsir.js  ──►  connections: { default: 'primary', stores: { primary: {...}, analytics: {...} } }
                                     │
                        @tsir/database  Connections  ──►  use('analytics') per call
```

- **Named and default.** Exactly one connection per capability is `default`; every call site may
  name another. A missing name is a boot error, not a lazy `undefined` (`PR-7`).
- **Selection is explicit.** No ambient "current connection" — that is a global service locator by
  another name (`plans/README.md` § 6, rule 1).
- **Secrets come from the environment, never from the config file.** `@tsir/config` redacts and
  reports all issues at once; `tsir.js` carries names and shapes.
- **Validation is at boot.** An unknown driver, a missing binding, or a connection that cannot
  resolve its secret fails before the first request.
- **Observability is per connection.** `@tsir/pulse` attributes logs, metrics and spans by
  connection name; a slow `analytics` query must not look like a slow `primary` query.

### 12.2 Lifecycle per runtime

| Runtime                         | Correct lifecycle                                                                                                    | Today                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Bun / Node (P4)                 | Eager pool at boot, closed on shutdown                                                                               | `[VERIFIED]` — `@tsir/database/postgres` pool rules (ADR-0009)                         |
| Workers + D1                    | A binding, not a connection: no pool, no close                                                                       | `[VERIFIED]`                                                                           |
| Workers + Hyperdrive + Postgres | **Request-scoped**: `env.HYPERDRIVE.connectionString` changes per request, and a socket must not outlive the request | `[PARTIAL]` — `createConnectionsFromConfig` builds drivers eagerly at boot (`INF-003`) |
| Lambda + RDS                    | Per-invocation client, reused across warm invocations, never closed explicitly                                       | `[PARTIAL]` — same eager-boot path                                                     |
| Hybrid (Workers → RDS)          | Hyperdrive in front; the Worker never sees a TCP socket                                                              | `[PARTIAL]` — blocked by `INF-003`                                                     |

### 12.3 Failover and health checks — the truth table

**There is no automatic failover anywhere in the framework today.** This table is the honest
statement of what happens when a connection dies, and what an app must build for itself.

| Capability | Health check            | Failover | Behaviour on primary failure                                        | Status         |
| ---------- | ----------------------- | -------- | ------------------------------------------------------------------- | -------------- |
| database   | `SELECT 1` at boot only | none     | Requests fail with the driver's error; no retry, no replica routing | `[LIMITATION]` |
| cache      | none                    | none     | Driver error surfaces to the caller; no bypass to memory            | `[LIMITATION]` |
| queue      | none                    | none     | Producer throws; consumer retries per driver policy                 | `[LIMITATION]` |
| storage    | none                    | none     | `s3Driver` surfaces the HTTP status                                 | `[LIMITATION]` |

Read replicas exist in Postgres and in D1, and **Tsir does not route reads to them** —
that is `[PROPOSED]` work (`Q63`), not a current capability. Any doc or error message implying
otherwise is wrong.

### 12.4 Interoperability — what "multiple connections" does and does not buy

| Pair                                  | Interoperable? | What it actually means                                                                      |
| ------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| D1 ↔ D1 (two databases)               | ✅             | Two dialects of the same engine; `ATTACH` is not used, so no cross-DB transaction           |
| Postgres ↔ Postgres (two servers)     | ✅             | Independent pools; no cross-server transaction, no foreign data wrapper                     |
| D1 ↔ Postgres                         | ❌             | Different dialect **and** different type system; this is a migration, not a config          |
| Postgres ↔ MySQL                      | ❌             | Dialect drift; MySQL is `[PLANNED]` anyway (`INF-003`)                                      |
| S3 ↔ R2 ↔ MinIO                       | ✅ (mostly)    | Same API; ACL headers and multipart details differ (`INF-008`)                              |
| CF Queues ↔ SQS                       | ✅ at the port | Same `@tsir/queue` contract; **a message enqueued on one is not consumable from the other** |
| Memory cache ↔ Redis                  | ✅ at the port | Same `CacheDriver` contract; no shared keyspace                                             |
| Sessions on D1 ↔ sessions on Postgres | ⚠️             | Schema-compatible, but a session written on one is invisible to the other                   |

The distinction that matters: **port-level interoperability is not data-level interoperability.**
A queue driver swap lets the app talk to a different broker; it does not move the messages.

---

## 13. Deployment profiles

Five profiles. Each is a `tsir.js` preset plus a documented substrate list; none of them requires
a different application module structure.

| Profile                         | HTTP                         | Queue                    | Database                                | Cache       | Storage          | Real-time              | Long jobs         | Status                                                   |
| ------------------------------- | ---------------------------- | ------------------------ | --------------------------------------- | ----------- | ---------------- | ---------------------- | ----------------- | -------------------------------------------------------- |
| **P1 — Cloudflare-first**       | Workers                      | Cloudflare Queues        | D1                                      | KV          | R2               | Durable Objects        | none (§ 8)        | `[PARTIAL]` — `INF-004`, `INF-006`, `INF-008`, `INF-009` |
| **P2 — AWS-first**              | Lambda + API GW              | SQS                      | RDS Postgres (or DynamoDB `[PROPOSED]`) | ElastiCache | S3               | APIGW WS (`[PARTIAL]`) | Fargate task      | `[PARTIAL]` — `INF-001`, `INF-003`, `INF-005`, `INF-007` |
| **P3 — Hybrid**                 | Workers at the edge          | SQS or CF Queues         | Postgres via Hyperdrive                 | KV + Redis  | R2 (origin) + S3 | DO + APIGW WS          | Fargate task      | `[PROPOSED]` — blocked by `INF-007` and `INF-003`        |
| **P4 — Self-hosted**            | Bun/Node (single box or k8s) | database-backed or Redis | self-hosted Postgres                    | Redis       | MinIO or disk    | dedicated WS server    | same process      | `[PARTIAL]` — `INF-002`, `INF-010`                       |
| **P5 — Dedicated worker infra** | any of the above             | any                      | any                                     | any         | any              | dedicated WS server    | dedicated workers | `[PLANNED]` — the S4 seam does not exist (`INF-012`)     |

### 13.1 What each profile costs to adopt

| Profile | `tsir.js` change                | Code change                                           | Migration risk                                         |
| ------- | ------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| P1      | none (it is the default)        | none                                                  | none for a new app                                     |
| P2      | `targets: ['aws']`              | none for HTTP; queue driver name; Postgres migrations | Medium — dialect change if coming from D1              |
| P3      | `targets: ['cloudflare','aws']` | none if `INF-007` is fixed                            | Medium — two secret stores, two observability sinks    |
| P4      | `targets: ['bun']`              | none if `INF-002` is fixed                            | Low for a Bun-first team, high for a Workers-first one |
| P5      | a second deploy unit            | a worker entry module (S4)                            | Low — it is additive                                   |

### 13.2 The profile rule

> **An application may move between profiles without editing a module.** If moving from P1 to P2
> requires touching `src/modules/`, the seam in § 9 is missing or broken, and that is a framework
> bug — not an application problem.

---

## 14. Alternatives comparison

Thirteen platforms and services that a Tsir team may reasonably evaluate, with the official
documentation each claim comes from. Prices are list prices as of Oct/Nov 2026 and are here to
show **shape**, not to be quoted.

| #   | Platform / service                                                        | Free / entry point                                                                   | Fits Tsir profile | Honest verdict                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Fly.io**                                                                | Trial credits; ~$5/mo for a 1 GB shared VM                                           | P4/P5             | Best "cheap persistent process" story; not serverless, so no Workers portability. [Pricing](https://fly.io/docs/about/pricing/)                                                                                                                                                                                     |
| 2   | **Google Cloud** (Cloud Run + Cloud SQL + Pub/Sub)                        | Always Free: 2 M requests, 180 k vCPU-s, 360 k GiB-s/month                           | P2/P4             | Strong container story and the best scale-to-zero economics; a `[PROPOSED]` emitter, no driver today. [Pricing](https://cloud.google.com/run/pricing)                                                                                                                                                               |
| 3   | **Azure** (Container Apps + Functions + Service Bus)                      | Container Apps: 180 k vCPU-s + 360 k GiB-s; Functions: 250 k executions + 100 k GB-s | P2/P4             | Viable, but Linux Consumption retires 2028-09-30; Flex Consumption is the forward path. [Pricing](https://azure.microsoft.com/pricing/details/container-apps/)                                                                                                                                                      |
| 4   | **Railway**                                                               | $5 trial, then a $1/mo Free tier and $5/mo Hobby                                     | P4                | The fastest way to run a Postgres + a Bun process; no edge presence. [Pricing](https://docs.railway.com/reference/pricing)                                                                                                                                                                                          |
| 5   | **Render**                                                                | Free 512 MB instance (sleeps after 15 min), Postgres expires at 30 d in Free         | P4                | Good DX, but the Free tier is a demo tier — sleeping and expiring data are not production. [Pricing](https://render.com/pricing)                                                                                                                                                                                    |
| 6   | **Hetzner Cloud**                                                         | ~€4/mo VPS with 20 TB egress included                                                | P4/P5             | The cheapest always-on compute in Europe by a wide margin; you operate it. [Pricing](https://www.hetzner.com/cloud/)                                                                                                                                                                                                |
| 7   | **Supabase**                                                              | Free 500 MB Postgres + Auth + Storage; project pauses after 7 days idle              | P2/P4             | Excellent Postgres ergonomics and an auth service `@tsir/auth` overlaps with; the pause-on-idle behaviour rules out Free for anything real. [Pricing](https://supabase.com/pricing)                                                                                                                                 |
| 8   | **Neon**                                                                  | Free 0.5–1 GB per project, 100 compute-hours                                         | P2/P4             | Branching is genuinely useful for migrations; scale-to-zero adds a cold connection. [Pricing](https://neon.tech/pricing)                                                                                                                                                                                            |
| 9   | **Upstash**                                                               | Redis Free: 500 k commands/month, pay-per-request                                    | any (cache)       | The right Redis for a serverless app **if you pass a `fetch`-based client**: `@tsir/cache`'s `redis` driver takes an app-supplied client, so an HTTP one works from an isolate and `ioredis` does not. [Pricing](https://upstash.com/pricing/redis)                                                                 |
| 10  | **Self-hosted PostgreSQL**                                                | Your server's cost                                                                   | P4                | Always the cheapest at volume and the highest operational cost at small volume; `@tsir/database/postgres` is the same driver either way. [Docs](https://www.postgresql.org/docs/)                                                                                                                                   |
| 11  | **Redis-compatible services** (Upstash, Valkey, ElastiCache, Memorystore) | Upstash Free; ElastiCache/Memorystore paid only                                      | any (cache)       | `@tsir/cache` already ships a `redis` driver (`[VERIFIED]`, 13 tests); the deciding factor is the Workers transport — no TCP without Hyperdrive-style plumbing, so a `fetch`-based client is the only one that runs in an isolate. The **queue** port has no Redis driver (`INF-017`). [Valkey](https://valkey.io/) |
| 12  | **OSS queue brokers** (NATS JetStream, RabbitMQ, BullMQ)                  | Self-hosted only                                                                     | P5                | The right answer for P5 and for any workload with a custom backoff policy; a driver is `[PLANNED]`. [NATS](https://docs.nats.io/) · [RabbitMQ](https://www.rabbitmq.com/docs) · [BullMQ](https://docs.bullmq.io/)                                                                                                   |
| 13  | **Container platforms** (Kubernetes, ECS Fargate, Nomad)                  | Fargate ~$0.04048/vCPU-h + $0.004445/GB-h; k8s control plane $0.10/h on EKS          | P5                | Where P5's worker units land when the team outgrows a single VPS. [Fargate pricing](https://aws.amazon.com/fargate/pricing/) · [EKS pricing](https://aws.amazon.com/eks/pricing/)                                                                                                                                   |

### 14.1 How to choose, in order

1. **No revenue yet?** P1. It is the default for a reason (§ 6.3, S1).
2. **Need a native binary or a > 15-minute job?** Keep HTTP wherever it is and add P5 for that
   job. Do not move the whole app.
3. **Need Postgres features (extensions, `jsonb`, `pgvector`)?** P2 or P3 — D1 cannot be made to
   have them (ADR-0016).
4. **Already have a Kubernetes team?** P4 on k8s; the framework's job is then just the app.
5. **Evaluating an unlisted platform?** The question to ask is one of § 9's seven seams: can it
   supply the substrate for that seam, and does it have a conformance run?

---

## 15. Critical limitations and recommendations

The full findings, with code locations, root causes and incremental fixes, are `INF-001`…`INF-016`
in [`../reviews/2026-11-07-infrastructure-agnosticism-audit.md`](../reviews/2026-11-07-infrastructure-agnosticism-audit.md)
§ 4. The register below is the **priority view** — what to fix, in what order, and what each fix
unlocks.

| Priority | Findings                                                                    | Unlocks                                                                                                                              | Sequencing note                                                           |
| -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| **P0**   | `INF-001`, `INF-002`, `INF-003`, `INF-004`, `INF-005`                       | A correct Postgres profile, a bundlable `@tsir/database`, a Hyperdrive-capable Worker, a non-lossy CF consumer, a valid AWS template | Before any user traffic; these are silent-data-loss and hard-failure bugs |
| **P1**   | `INF-006`, `INF-007`, `INF-008`, `INF-009`, `INF-010`, `INF-011`, `INF-012` | Edge-correct logging, H1/H3 hybrids, R2 parity, one real-time model, dialect-neutral telemetry & flags                               | One milestone; each is independently shippable                            |
| **P2**   | `INF-013`, `INF-014`, `INF-015`, `INF-016`                                  | Free-tier hashing safety, honest constants, native-binary attribution, an edge-native reference app                                  | Hardening pass; documentation-visible                                     |

### 15.1 The one recommendation that outranks the rest

**Make the Postgres path actually work (`INF-001` + `INF-003`).** Every portability claim in this
document depends on it. AWS-first (P2), hybrid (P3) and self-hosted (P4) all terminate in Postgres,
and today that path fails in three independent places: a `$1` placeholder bug in `@tsir/auth`, a
config loader that throws, and eager connection construction that cannot work behind Hyperdrive.
Until those are fixed, "provider-agnostic" is a claim about interfaces only — which is exactly
what the brief forbids us from asserting.

---

## 16. Capability status register

One row per infrastructure capability, with its label from the audit's six-status taxonomy
(`[VERIFIED]` / `[PARTIAL]` / `[PLANNED]` / `[PROPOSED]` / `[LIMITATION]` /
`[PROVIDER-SPECIFIC]`), the governing task, and the acceptance test that flips the label.

| Capability                            | Label                 | Governing task | Test that proves it                                                                                                                                                                                                                                            |
| ------------------------------------- | --------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web-standard HTTP pipeline            | `[VERIFIED]`          | —              | `contracts.test.ts`, `make verify-dist`                                                                                                                                                                                                                        |
| Bun / Workers / Lambda HTTP adapters  | `[VERIFIED]`          | —              | emitted-bundle request tests                                                                                                                                                                                                                                   |
| `waitUntil` + request-scoped `env`    | `[PLANNED]`           | `INF-006`      | a Workers-shaped test asserts the promise is registered and runs                                                                                                                                                                                               |
| D1 driver                             | `[VERIFIED]`          | —              | `@tsir/database` conformance + ADR-0016 batch semantics                                                                                                                                                                                                        |
| Postgres driver                       | `[PARTIAL]`           | `INF-001`      | PG integration suite runs session touch + key revoke                                                                                                                                                                                                           |
| Postgres via `tsir.js` config         | `[PLANNED]`           | `INF-003`      | `createConnectionsFromConfig` returns a working PG connection                                                                                                                                                                                                  |
| Hyperdrive, request-scoped            | `[PLANNED]`           | `INF-003`      | two simulated requests get two distinct connection strings                                                                                                                                                                                                     |
| MySQL                                 | `[PLANNED]`           | `INF-003`      | `@tsir/database/mysql` exists and passes the dialect suite                                                                                                                                                                                                     |
| `bootstrap.ts` without `bun:sqlite`   | `[PLANNED]`           | `INF-002`      | `verify-dist` Workers probe imports `@tsir/database` with no `bun:`                                                                                                                                                                                            |
| KV cache driver                       | `[VERIFIED]`          | —              | `@tsir/cache` conformance                                                                                                                                                                                                                                      |
| Redis cache driver                    | `[VERIFIED]`          | —              | `@tsir/cache` `redis` driver: app-supplied client, atomic `SET … PX`, 13 tests, capability flags enforced at startup. **Corrected 2026-11-08** — an earlier revision of this table called it `[PLANNED]`; the missing Redis driver is the **queue** one, below |
| Redis queue driver                    | `[PLANNED]`           | `INF-017`      | `@tsir/queue` has no `redis` driver; either a decision ADR or a conformance run against a Redis container                                                                                                                                                      |
| S3 / R2 / MinIO storage               | `[PARTIAL]`           | `INF-008`      | conformance without `x-amz-acl`; presigned PUT round-trip                                                                                                                                                                                                      |
| Native `R2Bucket` driver              | `[PROPOSED]`          | `INF-008`      | a miniflare R2 binding passes the storage conformance kit                                                                                                                                                                                                      |
| CF Queues driver                      | `[PARTIAL]`           | `INF-004`      | a 10-message batch with 3 failures acks exactly 7                                                                                                                                                                                                              |
| SQS driver without the AWS SDK        | `[PLANNED]`           | `INF-007`      | SigV4 `fetch` client passes the conformance kit against LocalStack                                                                                                                                                                                             |
| Cloudflare Queues consumer in a batch | `[VERIFIED]` (port)   | `INF-004`      | drain processes every message in `batch.messages`                                                                                                                                                                                                              |
| Cron / schedule tick                  | `[VERIFIED]`          | —              | `DPL_CRON_NOT_UTC` + 2 lock drivers                                                                                                                                                                                                                            |
| Durable-Object-shaped rooms           | `[PARTIAL]`           | `INF-009`      | room contract test runs against the DO-shaped and in-memory transports                                                                                                                                                                                         |
| `@tsir/broadcast` fan-out             | `[PARTIAL]`           | `INF-009`      | unsubscribe removes the listener; presence is not a `Set` in one isolate                                                                                                                                                                                       |
| APIGW WebSocket emitter               | `[PLANNED]`           | `INF-005`      | SAM template validates with a `WebSocketApi` resource                                                                                                                                                                                                          |
| SNS / EventBridge / StepTask triggers | `[VERIFIED]` (emit)   | `INF-005`      | `deploy-build.test.ts` builds `listener-app`, imports `index.mjs`, and dispatches an SNS, EventBridge and Step Task event to the decorated methods. **Corrected 2026-11-13** — was `[PLANNED]`; the emitter dropped all three until this pass                  |
| Workflow orchestration                | `[PROPOSED]`          | `INF-018`      | −                                                                                                                                                                                                                                                              |
| `@tsir/telemetry` on any dialect      | `[PARTIAL]`           | `INF-010`      | the same schema runs on D1 and PG; no `transaction()` on D1                                                                                                                                                                                                    |
| `@tsir/pennant` on any dialect        | `[PARTIAL]`           | `INF-011`      | `databaseStore` runs against PG and SQLite                                                                                                                                                                                                                     |
| PBKDF2 on Workers Free                | `[LIMITATION]`        | `INF-013`      | a measured CPU-ms number for 210k iterations, per plan                                                                                                                                                                                                         |
| `ffmpeg` / `sharp` / gRPC binaries    | `[LIMITATION]`        | `INF-015`      | build fails with a named capability error when the target cannot host it                                                                                                                                                                                       |
| Workers AI                            | `[PROVIDER-SPECIFIC]` | `INF-018`      | −                                                                                                                                                                                                                                                              |
| Durable Object class emission         | `[PROVIDER-SPECIFIC]` | `INF-005`      | Wrangler output contains the DO class + migration                                                                                                                                                                                                              |
| `admin.product.com` on the edge       | `[PARTIAL]`           | `INF-016`      | no `node:fs` at request time; `ctx.waitUntil` for the log write                                                                                                                                                                                                |

---

## 17. Failure modes

| Failure                                            | Why it happens                                                       | How it is reported                                        | What the caller can do                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Config names a driver that does not exist          | driver typo, or a `[PLANNED]` driver assumed shipped                 | boot error `DB_DRIVER_UNAVAILABLE` / `CAP_DRIVER_UNKNOWN` | pick a driver from § 10.3/§ 16; check the status label, not the type signature |
| App boots on Workers but imports `node:fs`         | a static import in a barrel (`INF-002`)                              | bundler error, or a runtime crash on first call           | use the documented subpath; `make verify-dist` reproduces it locally           |
| Background work silently disappears                | unawaited promise instead of `waitUntil`/a queue message (`INF-006`) | **not reported** — this is the dangerous one              | enqueue instead of `void`; add a test asserting the promise is registered      |
| Queue consumer loses messages in a batch           | whole-batch `ackAll`/`retryAll` (`INF-004`)                          | message count drops; no error                             | pin `batchSize: 1` until fixed; monitor processed-vs-received                  |
| Hybrid topology refused at build time              | `checkQueueConnections` conflates HTTP and queue targets (`INF-007`) | `deploy:check` error naming the queue connection          | use one target per queue connection, or wait for the fix                       |
| Postgres-only deployment fails on first write      | `$1`/`$1` placeholder bug (`INF-001`)                                | 42P02-style parameter error at runtime                    | stay on D1, or patch as documented in the INF entry                            |
| A WebSocket fan-out appears to work, then does not | two isolates, one in-memory presence `Set` (`INF-009`)               | no error — messages go to the wrong subset                | pin single-instance; use DO rooms for production                               |
| Free-tier CPU exhaustion                           | PBKDF2/time-boxed work on a 10 ms budget (`INF-013`)                 | `Error 1102` from Cloudflare                              | move auth to Paid, or lower iterations with a documented trade-off             |
| Cost surprise on AWS                               | NAT Gateway, ALB, egress (§ 6.2)                                     | the invoice                                               | use P1 or P4 until revenue justifies P2                                        |
| Migration between profiles needs code changes      | a missing seam (§ 9)                                                 | a diff touching `src/modules/`                            | treat it as a framework bug; file it against the seam, not the app             |

---

## 18. Security considerations

The trust boundaries this document introduces, and — equally important — the ones it does not.

- **A connection string is a credential.** `tsir.js` may name a connection; it must never hold the
  secret. `@tsir/config` reads from the environment, redacts on dump, and reports all issues at
  once rather than failing on the first.
- **Hybrid doubles the credential surface.** Two providers mean two secret stores (Wrangler
  secrets and SSM/Secrets Manager). Each secret needs one owner; a secret mirrored in both is a
  rotation bug waiting to happen.
- **A driver swap is a security review, not a config change.** `@tsir/storage`'s ACL behaviour
  differs between S3 (`BucketOwnerEnforced` rejects `x-amz-acl`) and R2 (rejects it outright):
  a swap can silently change object visibility (`INF-008`).
- **Free-tier ceilings are a denial-of-service vector.** A form post that triggers PBKDF2 at 210k
  iterations on a 10 ms CPU budget is a one-request outage; rate limiting is a security control,
  not a nicety (`INF-013`).
- **Real-time auth is per-message, not per-connection.** An authorisation decision made at upgrade
  time does not survive a role change. § 11.3 requires re-checking on privileged messages.
- **What this document does not defend against:** a compromised provider account (the blast radius
  is the whole profile, including the D1/R2 data), a malicious dependency inside an accepted driver,
  or a misconfigured `wrangler.toml` that exposes an internal binding. Those belong to
  [`../operations/14-security.md`](../operations/14-security.md).
- **No silent fallbacks is a security property.** Downgrading to `memory` when Redis is
  unreachable turns a cache into a correctness dependency and a queue into a data-loss bug; `PR-7`
  forbids it.

---

## 19. Open questions

| #   | Question                                                                                                                                                          | Decides                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Q60 | Should a `worker` deploy unit (S4) be a new `@tsir/deploy` unit kind, or a `@tsir/queue` "runner" target that any process can start?                              | Phase 6/8 — `INF-012`                                                            |
| Q61 | Does Tsir adopt one workflow abstraction (steps as data) or keep workflow orchestration out of the framework entirely and document CF Workflows / Step Functions? | [ADR-0030](../decisions/0030-hybrid-cloud-and-workload-substrates.md), `INF-018` |
| Q62 | Is a workflow step's state stored in `@tsir/database` (portable, slower) or in the vendor's native store (fast, locked in)?                                       | § 6.4 lock-in, `INF-018`                                                         |
| Q63 | Should read-replica routing be a first-class `Connections` feature (`use('read')`), or an application concern with a documented recipe?                           | `INF-003`, § 12.3                                                                |
| Q64 | Should `@tsir/queue` grow native DLQ + exponential backoff, or stay a thin port and delegate policy to the broker/driver?                                         | § 10.4 rule 4, `INF-004`                                                         |
| Q65 | For P3 hybrid, which side owns the canonical secret store when both providers need the same credential?                                                           | § 5.2, § 18                                                                      |

---

## 20. Task index

All work named in this document is tracked in
[`../tasks/16-infrastructure-hardening.md`](../tasks/16-infrastructure-hardening.md), priorities
`P0` → `P3`. Reading order:

1. **`INF-001`** — the Postgres `$1` placeholder bug. Everything in § 12 depends on it.
2. **`INF-002`** — `@tsir/database` must not import `bun:sqlite` at the barrel.
3. **`INF-003`** — Postgres via config, Hyperdrive request scoping, MySQL status.
4. **`INF-004`** — the Cloudflare Queues batch must not lose messages.
5. **`INF-005`** — Lambda/SAM emitters: dropped triggers, invalid EventPattern, invalid WS binding.
6. **`INF-006`** — `waitUntil` + request-scoped `env` in `RequestContext` (S2).
7. **`INF-007`** — unblock the CF→SQS hybrid; SigV4 `fetch` client (H1).
8. **`INF-008`** — storage ACL headers, streaming, native `R2Bucket` driver.
9. **`INF-009`** — one real-time contract; fix the subscription leak (S6).
10. **`INF-010`** — dialect-neutral `@tsir/telemetry`.
11. **`INF-011`** — dialect-neutral `@tsir/pennant`.
12. **`INF-012`** — correct target detection; introduce the worker unit (S4).
13. **`INF-013`** — PBKDF2 iteration policy per substrate.
14. **`INF-014`** — platform constants and documentation drift.
15. **`INF-015`** — native-binary capability attribution at build time.
16. **`INF-016`** — make `admin.product.com` edge-native.
17. **`INF-017`** — the Redis cache/queue driver decision (§ 14.1).
18. **`INF-018`** — the workflow-seam decision (`Q61`, `Q62`).

Related plans: [`../modules/08-deploy.md`](../modules/08-deploy.md) (emitters),
[`../modules/15-capabilities.md`](../modules/15-capabilities.md) (drivers),
[`../modules/05-database.md`](../modules/05-database.md) (connections),
[`../operations/09-tsir-config.md`](../operations/09-tsir-config.md) (config surface),
[`../operations/13-observability.md`](../operations/13-observability.md) (attribution by connection).
