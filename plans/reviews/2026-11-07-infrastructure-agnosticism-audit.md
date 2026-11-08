# Infrastructure Agnosticism, Cloud Coupling & Scalability Audit

> **Date:** 2026-11-07
> **Scope:** Full source-code verification of all 33 `@tsir/*` packages under `src/framework/` and
> the reference application `src/apps/admin.product.com`, evaluating runtime neutrality, cloud
> coupling, multi-connection fidelity, background execution, real-time transport, deployment
> emitters, and horizontal scalability.
> **Companion architecture plan:** [`../architecture/17-infrastructure-philosophy.md`](../architecture/17-infrastructure-philosophy.md)
> **Companion ADR:** [`../decisions/0030-hybrid-cloud-and-workload-substrates.md`](../decisions/0030-hybrid-cloud-and-workload-substrates.md)
> **Executable backlog:** [`../tasks/16-infrastructure-hardening.md`](../tasks/16-infrastructure-hardening.md)

---

## 1. Executive Summary & Methodology

TypeScript interfaces and environment-variable schemas do not guarantee cloud agnosticism on their
own. A package that compiles cleanly against a structural interface can still fail to bundle for
`workerd` because a barrel re-exports `bun:sqlite`, drop 90 % of a queue batch because a push bridge
drains one message per invocation, reject API-key revocation on PostgreSQL because a SQL placeholder
helper emits `$1` twice, or freeze mid-query on AWS Lambda because an audit write is launched
without an execution-context lifecycle hook.

This audit inspected the **actual implementation** of every non-test source file across all 33
packages in `src/framework/*` and `src/apps/admin.product.com` — static and dynamic `import` graphs
(`node:*`, `bun:*`, third-party SDKs), Drizzle dialect imports, SQL placeholder generation, runtime
global assumptions, deploy entry-point code generation, Wrangler/SAM template emitters, and build
validation gates.

### High-level verdict

1. **Core domain & HTTP pipeline are genuinely portable (`[VERIFIED]`).** `@tsir/container`,
   `@tsir/core`, `@tsir/config` (except filesystem `configDir`), `@tsir/router`, `@tsir/validate`,
   `@tsir/http` (`createFetchHandler`), `@tsir/policy`, `@tsir/vault`, `@tsir/events`,
   `@tsir/schedule`, `@tsir/notify`, `@tsir/cashier`, `@tsir/socialize`, and `@tsir/pulse` depend on
   Web-standard APIs (`Request`, `Response`, `URL`, `Headers`, `ReadableStream`, `AbortSignal`,
   `crypto.subtle`, `TextEncoder`) and structural driver ports (`ADR-0027`) with zero vendor SDK
   lock-in in core packages.
2. **Cloudflare-first path is strong at the driver layer (`[VERIFIED]` / `[PARTIAL]`), with two P0
   production hazards to fix before scale:** whole-batch/single-item queue consumer handling in
   `@tsir/deploy/cloudflare` + `@tsir/queue` (`INF-004`), and `createDatabaseBootstrap` pulling
   `bun:sqlite` + `node:fs` into the `@tsir/database` root barrel (`INF-002`).
3. **PostgreSQL, AWS, and Hybrid paths are architecturally well-designed at the port boundary
   (`ADR-0009`, `ADR-0019`, `ADR-0027`), but currently `[PARTIAL]` end-to-end due to concrete wiring
   and SQL defects:**
   - `@tsir/auth` emits invalid `$1`/`$1` SQL on PostgreSQL for `session.touch()`, `apiKeys.revoke()`,
     and `apiKeys.touch()` (`INF-001`, **P0**).
   - `@tsir/database`'s `createConnectionsFromConfig` throws `DB_DRIVER_UNAVAILABLE` for
     `driver: 'postgres'`, and Cloudflare Hyperdrive sockets require per-request scoping rather than
     boot-time pooling (`INF-003`, **P0**).
   - `tsir deploy:build` skips units whose only triggers are `@OnSns`, `@OnEventBridge`, or
     `@OnStepTask`, while `@tsir/deploy/sam` emits invalid EventBridge YAML and attaches WebSockets
     to `AWS::Serverless::HttpApi` (`INF-005`, **P0**).
   - `@tsir/deploy`'s `checkQueueConnections` blocks Hybrid Cloudflare-HTTP → AWS-SQS deployments by
     requiring every target in `targets` to _consume_ every declared queue connection (`INF-007`,
     **P1**).
   - `@tsir/telemetry` hardcodes `sqliteTable` while calling `drizzle.transaction()` — simultaneously
     rejecting PostgreSQL at compile time and failing at runtime on D1 (`INF-010`, **P1**).

---

## 2. Capability Status & Coupling Taxonomies

### 2.1 Capability status labels (used across all `plans/` documents)

To prevent unimplemented or proposed features from being misread as production-ready, every
infrastructure capability in this audit and in
[`17-infrastructure-philosophy.md`](../architecture/17-infrastructure-philosophy.md) carries one of
six explicit status markers:

| Status Marker         | Definition                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `[VERIFIED]`          | Implemented in `src/framework/`, covered by automated tests, and verified free of hidden runtime/dialect blockers in code.  |
| `[PARTIAL]`           | Port and partial implementation exist, but concrete bugs, missing config wiring, or target gaps block production parity.    |
| `[PLANNED]`           | Accepted in an existing ADR or module plan (`plans/`), with task IDs assigned, but not yet implemented in `src/framework/`. |
| `[PROPOSED]`          | Recommended by this assessment; requires task scheduling or ADR ratification before implementation.                         |
| `[LIMITATION]`        | Verified platform, runtime, or architectural constraint that callers must design around rather than hide.                   |
| `[PROVIDER-SPECIFIC]` | Deliberately bound to one cloud/runtime's native execution model to preserve native performance, economics, or semantics.   |

### 2.2 Coupling classification categories

Every subsystem audited in § 3 is classified into one (or a primary + secondary pair) of seven
architectural coupling categories:

1. **Cat 1 — Provider-independent:** Pure TypeScript / Web-standard runtime APIs (`fetch`,
   `Request`/`Response`, `crypto.subtle`, `ReadableStream`, `AsyncLocalStorage` where supported);
   zero cloud or OS assumptions.
2. **Cat 2 — Interface-abstracted with single provider implementation:** Clean port exists, but only
   one production driver (plus memory/local test doubles) is currently wired end-to-end.
3. **Cat 3 — Tightly coupled to Cloudflare:** Directly assumes `workerd` globals (`WebSocketPair`),
   Wrangler bindings, D1/SQLite dialect semantics, or Cloudflare wire shapes.
4. **Cat 4 — Tightly coupled to AWS:** Directly imports `@aws-sdk/*` or assumes Lambda/SNS/SAM/API
   Gateway v2 contracts.
5. **Cat 5 — Tightly coupled to another service:** Hardcoded to a specific third-party vendor API or
   protocol without a neutral port or alternative production backend.
6. **Cat 6 — Runtime-dependent:** Requires Bun (`Bun.serve`, `bun:sqlite`, `Bun.password`), Node.js
   (`node:fs`, `node:net`, `node:tls`, `node:http2`, `node:child_process`), or an OS container with
   native binaries (`ffmpeg`, `sharp`/`libvips`, Chromium).
7. **Cat 7 — Missing abstraction or configuration layer:** Application code must bypass framework
   bootstraps or hand-roll lifecycle glue because a seam (`waitUntil`, request-scoped bindings,
   container worker target, unified WS pub/sub bridge) does not yet exist.

---

## 3. Complete Subsystem & Package Audit (33 Framework Packages + Reference App)

### 3.1 Cross-cutting architectural dimensions

| Subsystem Dimension                   | Primary Packages                                                                | Coupling Category     | Status                        | Code-Verified Assessment                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------- | --------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime environment detection         | `@tsir/core` (`capabilities.ts`)                                                | Cat 6 + Cat 7         | `[PARTIAL]`                   | `DeployTarget` is fixed to `'bun' \| 'cloudflare' \| 'lambda'`. Any Node.js container/VM (`process.versions.node`) is misdetected as `'lambda'`; `'cloudflare'` omits `'node-compat'` even under `nodejs_compat`.                                           |
| HTTP request/response lifecycle       | `@tsir/http` (`context.ts`, `pipeline.ts`)                                      | Cat 1 + Cat 7         | `[VERIFIED]` / `[LIMITATION]` | Web-standard `(Request) => Promise<Response>` pipeline works on Bun, Workers, and Lambda. **Missing (`Cat 7`):** `RequestContext` has no `waitUntil(promise)` or per-request `env` binding carrier (`INF-006`).                                             |
| Application bootstrap & DI            | `@tsir/core` (`app.ts`), `@tsir/container`                                      | Cat 1                 | `[VERIFIED]`                  | Pure TypeScript DAG container (`singleton`, `scoped`, `transient`), deterministic reverse-topological `stop()`, zero OS/cloud imports.                                                                                                                      |
| Routing, middleware & controllers     | `@tsir/router`, `@tsir/validate`, `@tsir/http`                                  | Cat 1                 | `[VERIFIED]`                  | Radix-tree router, TC39/legacy controller decorators, `@OnSns`/`@OnEventBridge`/`@OnStepTask` metadata, Zod/Standard-Schema validation — 100 % provider-independent.                                                                                        |
| Background task execution (in-req)    | None (`void promise` in app code)                                               | Cat 7                 | `[LIMITATION]`                | No `ExecutionLifecycle.waitUntil` port (`INF-006`). Unawaited promises risk cancellation on Workers after `Response` completes and freeze mid-flight on Lambda when the handler resolves.                                                                   |
| Queue & async worker processing       | `@tsir/queue` (`worker.ts`, `drivers/*`)                                        | Cat 1 (port)          | `[PARTIAL]`                   | Clean pull/push port (`memory`, `sync`, `database`, `cloudflare-queues`, `sqs`). Gaps: CF batch drain default (`INF-004`), static `leaseMs` with no heartbeat renewal, no Redis driver, no SigV4 `fetch` SQS client.                                        |
| Event dispatching & outbox            | `@tsir/events` (`bus.ts`, `outbox.ts`)                                          | Cat 1                 | `[VERIFIED]`                  | Typed sync/queued listeners + transactional SQL outbox supporting both `?` (D1/SQLite) and `$n` (Postgres) placeholders (`outbox.ts:62-64`).                                                                                                                |
| Scheduled tasks & distributed locks   | `@tsir/schedule` (`scheduler.ts`, `lock.ts`)                                    | Cat 1                 | `[VERIFIED]`                  | UTC cron parser, overlap protection (`databaseLock` atomic conditional upsert on D1 & Postgres; `memoryLock` refused when `production: true`). No Redis/DynamoDB lock driver yet (`[PROPOSED]`).                                                            |
| WebSockets & real-time channels       | `@tsir/link/ws` (`rooms.ts`), `@tsir/broadcast`                                 | Cat 3 + Cat 7         | `[PARTIAL]`                   | Split across two unbridged models (`INF-009`): `@tsir/link` has DO-hibernation-shaped `createRoom`; `@tsir/broadcast` has in-memory socket/presence maps + a listener/Redis leak on unsubscribe, and no APIGW WS.                                           |
| Database connections & ORM            | `@tsir/database`, `@tsir/migrate`, `@tsir/seed`                                 | Cat 3 + Cat 6 + Cat 7 | `[PARTIAL]`                   | Core `Database`/`Connections`/`d1`/`postgres` ports are clean, but `bootstrap.ts` statically imports `bun:sqlite` + `node:fs` (`INF-002`), `from-config.ts` throws on Postgres (`INF-003`), MySQL is unbuilt.                                               |
| Cache / KV storage                    | `@tsir/cache` (`memory`, `file`, `database`, `kv`, `redis`)                     | Cat 1 (port)          | `[VERIFIED]`                  | Exemplary capability honesty: `cloudflare-kv` advertises `readYourWrites: false`, `tags: false`, `increment: false`, `locks: false`, `ttlFloorMs: 60_000`; `redis` uses atomic `SET NX PX` + Lua compare-and-delete.                                        |
| File & object storage                 | `@tsir/storage` (`memory`, `local`, `s3`)                                       | Cat 1 + Cat 7         | `[PARTIAL]`                   | Pure WebCrypto SigV4 `s3Driver` serves AWS S3, Cloudflare R2, MinIO, Backblaze B2 (`[VERIFIED]`). Gaps (`INF-008`): sends `x-amz-acl` on visibility (400 on R2 & S3 `BucketOwnerEnforced`), buffers full `Uint8Array`, no native `R2Bucket` binding driver. |
| Sessions, tokens & API keys           | `@tsir/auth` (`session.ts`, `keys.ts`, `drivers/*`)                             | Cat 1                 | `[PARTIAL]`                   | `__Host-` cookies, SHA-256 hashed session/API-key IDs, constant-time compare. **P0 bug (`INF-001`):** `session-database.ts` and `keys-database.ts` emit `$1` twice in `UPDATE` statements on Postgres.                                                      |
| Password hashing                      | `@tsir/auth` (`password.ts`, `bun.ts`)                                          | Cat 1 / Cat 6         | `[VERIFIED]` / `[LIMITATION]` | Self-describing PHC hashes; WebCrypto PBKDF2-SHA256 (210k iterations) everywhere + `Bun.password` Argon2id in `@tsir/auth/bun`. **Edge note (`INF-013`):** 210k PBKDF2 crowds Workers Free 10 ms CPU budget.                                                |
| Logging, metrics, tracing & telemetry | `@tsir/pulse`, `@tsir/telemetry`                                                | Cat 1 vs Cat 3        | `[VERIFIED]` / `[PARTIAL]`    | `@tsir/pulse` (`stdout`, `memory`, `fanout`, W3C `traceparent`, redaction, health/ready) is 100 % provider-independent. `@tsir/telemetry` hardcodes `sqliteTable` + `drizzle.transaction()` (`INF-010`).                                                    |
| Environment & config loading          | `@tsir/config`                                                                  | Cat 1 / Cat 6         | `[VERIFIED]`                  | `defineConfig`/`loadConfig`/`Redacted` take pure `EnvRecord` maps (provider-independent). `configDir` (`node:fs`) is CLI/build-time (`tsir.js`), not imported on edge request paths when config is bundled.                                                 |
| External service integrations         | `@tsir/mail`, `@tsir/notify`, `@tsir/cashier`, `@tsir/socialize`, `@tsir/media` | Cat 1 / Cat 6         | `[VERIFIED]` / `[PARTIAL]`    | `mail` (`ses` SigV4, `cloudflare` binding, `smtp` Node TLS), `notify` (`mail`, `database`, `webhook` HMAC, `chat`, `twilio`), `cashier` (`stripe`, `paddle` via `fetch`), `socialize` (OAuth2 via `fetch`).                                                 |
| Deployment & runtime adapters         | `@tsir/deploy`, `@tsir/console` (`deploy-build.ts`)                             | Cat 3 + Cat 4 + Cat 7 | `[PARTIAL]`                   | Unit graph & secret scanning are solid (`[VERIFIED]`). CF Queue batch ack (`INF-004`), Lambda SNS/EB/StepTask bundling & SAM YAML/WS (`INF-005`), AWS-only `internal.ts` (`INF-007`), and single-fetch `bun` build need fixes.                              |

### 3.2 Package-by-package coupling ledger (all 33 `src/framework/*` packages + `admin.product.com`)

| #   | Package / App                | Cat       | Status                | Runtime / SDK Imports                                                        | Verified Notes & Cloud Portability Constraints                                                                                                                    |
| --- | ---------------------------- | --------- | --------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `@tsir/auth`                 | Cat 1     | `[PARTIAL]`           | WebCrypto; `Bun.password` isolated in `./bun` subpath                        | Portable design; **blocked on Postgres by `INF-001`** (`$1`/`$1` placeholder bug in `session-database.ts:128` & `keys-database.ts:90,98`).                        |
| 2   | `@tsir/broadcast`            | Cat 7     | `[PARTIAL]`           | None (app-supplied Redis/Pusher clients)                                     | `websocket.ts:163` leaks broadcaster subscriptions (`INF-009`); `presence` is process-local; not integrated with DO or APIGW WebSockets.                          |
| 3   | `@tsir/cache`                | Cat 1     | `[VERIFIED]`          | `node:fs/promises` isolated in `drivers/file.ts`                             | `memory`, `file`, `database` (D1 + PG), `cloudflare-kv`, `redis` (app-supplied client). Capability flags enforced before backend calls.                           |
| 4   | `@tsir/cashier`              | Cat 2     | `[VERIFIED]`          | Web `fetch` + WebCrypto HMAC (`stripe.ts`, `paddle.ts`)                      | Stripe is primary `BillingProvider`; Paddle client shipped separately in `./paddle`. Runs on Workers, Lambda, Node, and Bun.                                      |
| 5   | `@tsir/config`               | Cat 1     | `[VERIFIED]`          | Dynamic `node:fs`/`node:path`/`node:url` in `config-dir.ts`                  | Runtime `loadConfig(spec, env)` is pure; `configDir()` is build/CLI-only for `tsir.js`.                                                                           |
| 6   | `@tsir/console`              | Cat 6     | `[PARTIAL]`           | `node:fs`, `node:path`, `node:child_process`, `Bun.build`                    | Dev/build CLI (`Bun`/Node host). `deploy-build.ts` has `INF-005` (drops `sns`/`eventbridge`/`manual` triggers) and stale 1 MiB CF budget.                         |
| 7   | `@tsir/container`            | Cat 1     | `[VERIFIED]`          | Zero runtime/OS/vendor imports                                               | Pure DI container, scopes, tokens, `TsirError`. Runs identically in every JS isolate/process.                                                                     |
| 8   | `@tsir/core`                 | Cat 6     | `[PARTIAL]`           | Zero imports; sniffs `Bun`, `WebSocketPair`, `process.versions`              | Lifecycle & module composition are `[VERIFIED]`; `detectTarget()` misclassifies generic Node.js as `'lambda'` (`INF-012`).                                        |
| 9   | `@tsir/database`             | Cat 3/6   | `[PARTIAL]`           | Static `bun:sqlite`, `node:fs`, `node:path` in `bootstrap.ts`; `drizzle-orm` | `d1.ts`, `postgres.ts`, `connections.ts` are `[VERIFIED]`. `bootstrap.ts` (`INF-002`) & `from-config.ts` (`INF-003`) block PG/Workers/Node; MySQL `[PLANNED]`.    |
| 10  | `@tsir/deploy`               | Cat 3/4   | `[PARTIAL]`           | Dynamic `@aws-sdk/client-sns`, `@aws-sdk/client-lambda` in `internal.ts`     | Graph/Wrangler secret separation `[VERIFIED]`; CF Queue ack (`INF-004`), SAM YAML/WS (`INF-005`), and AWS-only `internal.ts` (`INF-007`) are `[PARTIAL]`.         |
| 11  | `@tsir/events`               | Cat 1     | `[VERIFIED]`          | Zero OS/vendor imports                                                       | In-process event bus + SQL outbox (`?` and `$n` dialects verified).                                                                                               |
| 12  | `@tsir/forge`                | Cat 6     | `[PROVIDER-SPECIFIC]` | Dynamic `node:child_process` (`execSync`, `execFileSync` `ssh`)              | Imperative Linux/Ubuntu VPS management (`nginx`, `certbot`, `psql`, `mysql`). Host/CLI tool only; shell-quoting risk noted in security.                           |
| 13  | `@tsir/http`                 | Cat 1/6   | `[PARTIAL]`           | `./bun` subpath uses `Bun.serve` + `node:process`                            | Core `createFetchHandler` is 100 % WinterCG/Web-standard (`[VERIFIED]`), but lacks `waitUntil` and request-scoped `env` (`INF-006`).                              |
| 14  | `@tsir/link`                 | Cat 1/3/6 | `[PARTIAL]`           | `grpc.ts` statically imports `@grpc/grpc-js` (Node HTTP/2)                   | `rest.ts` & `soap.ts` are pure `fetch` (`[VERIFIED]`); `rooms.ts` is DO-shaped (`Cat 3`); `grpc.ts` is Node/Bun-only (`Cat 6`).                                   |
| 15  | `@tsir/mail`                 | Cat 1     | `[VERIFIED]`          | `smtp.ts` dynamically imports `node:net`/`node:tls`                          | `ses` (WebCrypto SigV4 over `fetch`), `cloudflare` (Email binding), `smtp` (TCP/TLS on Bun/Node/Workers `nodejs_compat`), `memory`, `log`.                        |
| 16  | `@tsir/media`                | Cat 6     | `[PARTIAL]`           | `ffmpeg.ts` (`node:child_process`), `sharp.ts` (`import('sharp')`), `fetch`  | Cloud HTTP adapters (`cloudflare`, `cloudinary`, `imagekit`) run on edge; `sharp`/`ffmpeg` require Container/VM (`INF-015`). Buffers full `Uint8Array`.           |
| 17  | `@tsir/migrate`              | Cat 6     | `[VERIFIED]`          | `node:fs`, `node:path` (CLI / one-shot `migrate` unit)                       | Checksummed forward/down SQL runner with Postgres advisory locks; D1 rightly delegates to `wrangler d1 migrations apply`.                                         |
| 18  | `@tsir/nightwatch`           | Cat 6     | `[VERIFIED]`          | Dynamic `import('playwright')`                                               | E2E test harness (`inMemoryBackend` + `playwrightBackend`). CI/host tool only, never bundled into app units.                                                      |
| 19  | `@tsir/notify`               | Cat 1     | `[VERIFIED]`          | Web `fetch` + WebCrypto HMAC                                                 | Channels: `mail`, `database` (`?` and `$n`), `webhook` (SSRF guard + HMAC), `chat` (Slack/Discord), `sms` (`twilioProvider` via `fetch`).                         |
| 20  | `@tsir/pennant`              | Cat 2     | `[PARTIAL]`           | Zero OS/vendor imports                                                       | Feature flags (`memoryStore`, `nullStore`, `databaseStore`). **Bug (`INF-011`):** `databaseStore` (`stores.ts:54,68`) hardcodes `?`, failing on Postgres.         |
| 21  | `@tsir/policy`               | Cat 1     | `[VERIFIED]`          | Zero OS/vendor imports                                                       | Deterministic RBAC + ABAC policy engine; zero runtime or cloud coupling.                                                                                          |
| 22  | `@tsir/pulse`                | Cat 1     | `[VERIFIED]`          | Optional `process.stdout.write` fallback to `console.log`                    | Redacting structured logger (`tsir`/`json`/`pretty`), counters/histograms, W3C tracer, `/health` & `/ready`. OTLP HTTP sink `[PLANNED]`.                          |
| 23  | `@tsir/queue`                | Cat 1     | `[PARTIAL]`           | Zero OS/vendor imports (app-supplied bindings/SDK)                           | `memory`, `sync`, `database` (D1 + PG `SKIP LOCKED`), `cloudflare-queues`, `sqs`. Needs full-batch CF drain (`INF-004`) & 24h delay cap update (`INF-014`).       |
| 24  | `@tsir/router`               | Cat 1     | `[VERIFIED]`          | Zero OS/vendor imports                                                       | Radix tree, OpenAPI 3.1 generator, route/event decorators, compile-time route codegen.                                                                            |
| 25  | `@tsir/schedule`             | Cat 1     | `[VERIFIED]`          | Zero OS/vendor imports                                                       | Cron evaluator, scheduler runner, `memoryLock` & `databaseLock` (D1 + PG).                                                                                        |
| 26  | `@tsir/scout`                | Cat 1     | `[VERIFIED]`          | Zero OS/vendor imports                                                       | Full-text search port with `inMemoryEngine`, `sqliteEngine` (FTS5 `?`), and `postgresEngine` (`tsvector` + GIN `$1`).                                             |
| 27  | `@tsir/seed`                 | Cat 1     | `[VERIFIED]`          | Zero OS/vendor imports                                                       | Deterministic `order`-sorted seeder runner with production refusal guard and per-connection allowlists (`SED-011`).                                               |
| 28  | `@tsir/socialize`            | Cat 1     | `[VERIFIED]`          | Web `fetch` + WebCrypto HMAC state tokens                                    | OAuth 2.0 + PKCE (`github`, `google`, `discord`, `x`, `gitlab`, `bitbucket`, `linkedin`, `slack`). 100 % edge/serverless portable.                                |
| 29  | `@tsir/storage`              | Cat 1     | `[PARTIAL]`           | `local.ts` uses `node:fs/promises`; `s3.ts` uses WebCrypto + `fetch`         | `s3Driver` works across S3/R2/MinIO except ACL headers (`INF-008`), full-buffer memory ceiling, and missing native `R2Bucket` driver.                             |
| 30  | `@tsir/telemetry`            | Cat 3     | `[PARTIAL]`           | `drizzle-orm/sqlite-core`, `drizzle-orm/sqlite-proxy`                        | **Broken cross-dialect & D1 tx (`INF-010`):** hardcodes `sqliteTable` while calling `drizzle.transaction()` in `retryJob()` (`queue-monitor.ts:220`).             |
| 31  | `@tsir/testing`              | Cat 1     | `[VERIFIED]`          | Zero cloud imports                                                           | Fake clock, DI override helpers, in-process HTTP test client.                                                                                                     |
| 32  | `@tsir/validate`             | Cat 1     | `[VERIFIED]`          | `zod`                                                                        | Schema validation boundary for HTTP bodies/queries/params/headers and event payloads.                                                                             |
| 33  | `@tsir/vault`                | Cat 1     | `[VERIFIED]`          | WebCrypto (`AES-256-GCM`), `node:fs` isolated in keyring loader              | Envelope encryption, key rotation, blind AAD binding, `VaultKeyProvider` KMS seam (`provider.ts`, interface ready; AWS/GCP KMS app-owned).                        |
| 34  | `src/apps/admin.product.com` | Cat 3/6   | `[PARTIAL]`           | `node:async_hooks`, `node:fs`, `node:path`, `@tsir/database`                 | Uses `createDatabaseBootstrap` (`bun:sqlite` pull-in), sync `readFileSync` for SPA assets, `cf-connecting-ip`, and un-awaited `requestLogger.record` (`INF-016`). |

---

## 4. Critical Limitations, Verified Bugs & Architectural Recommendations (`INF-001` – `INF-016`)

Findings are ordered by severity (`P0` correctness/security/data-loss blockers → `P1` architectural
portability & scaling blockers → `P2` edge limits, native workload boundaries & drift). Migration
effort uses: **XS** (< 0.5 day, isolated file), **S** (1–2 days, single package), **M** (3–5 days,
cross-package port/adapter), **L** (1–2 weeks, multi-package + deploy template + conformance suite).

---

### `INF-001` — PostgreSQL `$1`/`$1` SQL placeholder bug breaks API-key revocation & session idle-touch

- **Severity / Priority:** **Critical (`P0`)** — Security & PostgreSQL Portability
- **Affected subsystem:** `@tsir/auth` (`src/framework/auth/src/drivers/session-database.ts:126-131`,
  `src/framework/auth/src/drivers/keys-database.ts:88-101`)
- **Current behavior:** Both files define `placeholders(count)` starting from `$1` on every call. In
  `databaseSessionStore.touch()`, `databaseApiKeyStore.revoke()`, and `databaseApiKeyStore.touch()`,
  `placeholders(1)` is interpolated twice in the same `UPDATE` statement:
  `UPDATE tsir_api_keys SET revoked_at = $1 WHERE id = $1 AND revoked_at IS NULL` with
  `params: [at, id]`. On D1/SQLite (`?`), positional binding succeeds. On PostgreSQL (`$n`), `$1` is
  bound twice (`revoked_at` compared to `id`) and the second parameter is either rejected by
  `postgres.js` or matches zero rows — `revoke()` returns `false` and **compromised API keys remain
  active**.
- **Root cause:** `placeholders(count)` resets `index` to `0` per call instead of providing an
  indexed parameter helper `p(index)` (as `@tsir/queue/src/drivers/database.ts:132` and
  `@tsir/events/src/outbox.ts:63` do), and unit tests exercised `session-database` / `keys-database`
  against `?`-placeholder doubles without asserting `$1, $2` SQL text on `dollar` engines.
- **Impact on developers & scalability:** Immediate failure of session touch and API-key revocation
  for any deployment moving `@tsir/auth` from D1 to PostgreSQL (RDS, Neon, Supabase, self-hosted).
- **Cost / operational trade-offs:** None — fixing the placeholder index has zero runtime overhead.
- **Migration effort:** **XS** (< 2 hours, backward-compatible bug fix + dual-dialect conformance test).
- **Recommended architectural direction:** Replace `placeholders(1)` in `UPDATE` clauses with an
  explicit `p(1)` / `p(2)` helper matching `@tsir/events/src/outbox.ts`, and add a mandatory
  `dollar`-placeholder test run to `@tsir/auth`'s driver test suite.

---

### `INF-002` — `createDatabaseBootstrap` pulls `bun:sqlite` & `node:fs` into `@tsir/database` and shares mutable global bindings

- **Severity / Priority:** **Critical (`P0`)** — Bundling Neutrality, Concurrency & Dialect Portability
- **Affected subsystem:** `@tsir/database` (`src/framework/database/src/bootstrap.ts:16-18,53,75-120`,
  re-exported at `src/framework/database/src/index.ts:42`)
- **Current behavior:**
  1. `bootstrap.ts` has top-level static imports of `Database as Sqlite` from `'bun:sqlite'`,
     `existsSync`/`mkdirSync` from `'node:fs'`, and `dirname` from `'node:path'`. Any application
     calling `createDatabaseBootstrap` (including `src/apps/admin.product.com/database.ts`) pulls
     `bun:sqlite` into its module graph, breaking non-Bun Node/Lambda execution and Workers builds
     unless `bun:sqlite` is externalized.
  2. `DatabaseBootstrap.drizzle` is hardcoded to `SqliteRemoteDatabase` (`drizzle-orm/sqlite-proxy`).
  3. `runtimeBindings` is a module-global mutable dictionary mutated on each request via
     `Object.assign(runtimeBindings, env)` (`admin.product.com/app.ts:285`), and `deferredD1Driver`
     (`from-config.ts:49-56`) permanently caches `let real: DbDriver | null = null` on the first
     query — freezing the first request's binding for the lifetime of the isolate.
- **Root cause:** `createDatabaseBootstrap` combined local dev SQLite fallback, D1 binding deferral,
  and Drizzle construction into one convenience file inside the core `@tsir/database` barrel.
- **Impact on developers & scalability:** Breaks runtime neutrality (`03-core.md`), prevents
  `createDatabaseBootstrap` apps from switching to PostgreSQL, and creates cross-request state
  hazards if Workers bindings rotate or per-tenant bindings are injected per request.
- **Cost / operational trade-offs:** Moving `bun:sqlite` fallback to a subpath (`@tsir/database/bun`
  or dynamic `await import('bun:sqlite')` only in CLI/dev) adds zero production cost while shrinking
  edge bundles.
- **Migration effort:** **S** (1–2 days).
- **Recommended architectural direction:**
  1. Keep `createDatabaseBootstrap` signature backward-compatible, but move `bun:sqlite` + `node:fs`
     behind a subpath (`@tsir/database/bun-sqlite`) or lazy dev-only factory so `@tsir/database` has
     zero `bun:*` or `node:fs` static imports.
  2. Resolve per-request bindings via an `AsyncLocalStorage`-backed request context (falling back to
     `runtimeBindings` for backward compatibility) instead of caching `real` permanently across
     requests.

---

### `INF-003` — `createConnectionsFromConfig` throws on PostgreSQL, Hyperdrive lacks per-request scoping, and MySQL is unimplemented

- **Severity / Priority:** **Critical (`P0`)** — Multi-Connection & Cloud Database Portability
- **Affected subsystem:** `@tsir/database` (`src/framework/database/src/from-config.ts:114-120`,
  `src/framework/database/src/postgres.ts:346-369`, `src/framework/database/src/config.ts`)
- **Current behavior:**
  1. `createConnectionsFromConfig` explicitly throws `DB_DRIVER_UNAVAILABLE`
     (`"postgres bootstrap from config is not yet wired — pass a driver directly via createConnections()"`).
  2. On Cloudflare Workers with **Hyperdrive**, `env.HYPERDRIVE.connectionString` is only available
     inside the request's `env` argument, and TCP sockets opened by `postgres.js` inside one Worker
     invocation **cannot be reused in a subsequent invocation** (`workerd` enforces per-request I/O
     context ownership and throws `Cannot perform I/O on behalf of a different request`). Yet
     `createConnections` (`connections.ts:79`) mandates building all drivers eagerly once at boot.
  3. `DATABASE_ENGINES` in `config.ts` and `ADR-0020` / `05-database.md § 2.9` include `'mysql'`,
     but no `src/framework/database/src/mysql.ts` exists (`[PLANNED]`, not supported).
- **Root cause:** D1 deferred binding resolution was implemented first (`from-config.ts:48-84`),
  leaving Postgres config-driven construction and Hyperdrive's request-scoped socket model unwired.
- **Impact on developers & scalability:** Developers cannot switch `config/database.ts` from
  `driver: 'd1'` to `driver: 'postgres'` declaratively; deploying Postgres behind Cloudflare
  Hyperdrive with a boot-scoped `postgres.js` pool fails on the second HTTP request hitting the same
  isolate.
- **Cost / operational trade-offs:** Per-request `postgres.js` client instantiation over Hyperdrive
  (`max: 5, fetch_types: false`) adds negligible JS object overhead (< 0.2 ms) because Hyperdrive
  maintains the warm regional TCP/TLS connection pool at the Cloudflare edge at $0 extra on Workers
  Paid.
- **Migration effort:** **M** (3–4 days).
- **Recommended architectural direction:**
  1. Add an app-supplied `postgresFactory?: (url: string, pool: PoolOptions) => PgClientLike` option
     to `createConnectionsFromConfig` (preserving `ADR-0009` zero-dependency rule) for Bun/Node/Lambda.
  2. Add `createHyperdriveDriver({ bindingName, createClient })` that instantiates a request-scoped
     `PgClientLike` from the active request's `env[bindingName].connectionString` and schedules
     `client.end()` via `waitUntil` at request completion.
  3. Explicitly mark `mysql` as `[PLANNED]` in `05-database.md` until `DB-023`–`DB-026` ship.

---

### `INF-004` — Cloudflare Queues consumer drops unprocessed batch items on partial failure or default `drainOnce()`

- **Severity / Priority:** **Critical (`P0`)** — Background Job Reliability & Silent Data Loss
- **Affected subsystem:** `@tsir/deploy` (`src/framework/deploy/src/cloudflare.ts:116-135`),
  `@tsir/queue` (`src/framework/queue/src/drivers/cloudflare-queues.ts:296-305`,
  `src/framework/queue/src/worker.ts:35-38,223-254`)
- **Current behavior:** Two compounding batch defects exist on Cloudflare Queues:
  1. `toCloudflareWorker` (`cloudflare.ts:127-134`) wraps `app.queue(batch)` in a whole-batch
     `batch.ackAll()` / `batch.retryAll()`: if message 3 of 10 throws a non-retryable error,
     `batch.ackAll()` acknowledges messages 4–10 before they ever ran; if message 3 throws a
     retryable error, `batch.retryAll()` redelivers messages 1–2 even though they already succeeded.
  2. When using `@tsir/queue`'s `queueConsumer({ backend, drain: () => worker.drainOnce() })` with
     `createWorker` defaults (`batchSize: 1`, `concurrency: 1`), `wrangler.ts` delivers up to
     `max_batch_size = 10` messages into `backend.deliver(batch)`, `worker.drainOnce()` reserves and
     processes **1 message**, and `queue()` returns normally — causing Cloudflare Workers runtime to
     implicitly acknowledge the remaining **9 unreserved messages in `inbox`**, losing them silently.
- **Root cause:** `toCloudflareWorker` predated `@tsir/queue`'s per-message `delivered.ack()` /
  `delivered.retry({ delaySeconds })` bridge (`cloudflare-queues.ts:231-252`), and `queueConsumer`
  called a single `drain()` pass instead of draining until `inbox` is empty.
- **Impact on developers & scalability:** Silent job loss or duplicate side effects whenever batch
  size > 1 under real queue load on Cloudflare Workers.
- **Cost / operational trade-offs:** Per-message `ack()` / `retry()` avoids wasted retry operations
  on Cloudflare Queues (where every retried message in a batch of 10 bills 10 extra read operations
  at $0.40/million).
- **Migration effort:** **S** (1–2 days).
- **Recommended architectural direction:**
  1. In `queueConsumer`, loop `drain()` until `inbox` is empty (or expose `worker.drainAll()`), and
     explicitly `retry()` any residual `inbox` messages in a `finally` block if an unexpected abort
     occurs.
  2. Update `toCloudflareWorker` so when the consumer uses per-message settlement (`cloudflareQueuesDriver`),
     it does **not** overwrite per-message `ack()`/`retry()` with `batch.ackAll()`, reserving
     `retryAll()` strictly for uncaught top-level handler crashes.

---

### `INF-005` — AWS Lambda `deploy:build` drops `@OnSns` / `@OnEventBridge` / `@OnStepTask` units & SAM emits invalid EventBridge/WebSocket templates

- **Severity / Priority:** **Critical (`P0`)** — AWS Deployment Correctness
- **Affected subsystem:** `@tsir/console` (`src/framework/console/src/commands/deploy-build.ts:154-205`),
  `@tsir/deploy` (`src/framework/deploy/src/sam.ts:171-225`)
- **Current behavior:**
  1. `adapterTriggers(unit)` in `deploy-build.ts:163-170` maps only `http`/`websocket` → `fetch`,
     `queue` → `queue`, and `cron` → `scheduled`. It ignores `sns`, `eventbridge`, and `manual`
     (`@OnStepTask`). Consequently, any unit triggered solely by SNS, EventBridge custom events, or
     Step Functions returns `[]`, logs `"no deployable triggers — skipped"`, and emits **neither a
     Lambda bundle nor a SAM template**; `unitEntrySource` also never wires `sns`, `eventbridge`, or
     `invoke` into `toLambdaHandler`.
  2. `sam.ts:212-216` indents `detail-type:` _inside_ `source:` under `EventPattern:`
     (`source:\n  detail-type:`), producing invalid EventBridge pattern syntax (CloudFormation
     requires sibling `source: [...]` and `detail-type: [...]` arrays).
  3. `sam.ts:171-183` combines `http` and `websocket` triggers onto `AWS::Serverless::HttpApi`. On
     AWS, API Gateway v2 HTTP APIs **do not support WebSockets**; WebSockets require a separate
     `AWS::ApiGatewayV2::Api` (`ProtocolType: WEBSOCKET`) with `$connect`, `$disconnect`, and
     `$default` route integrations plus `execute-api:ManageConnections` IAM permissions.
- **Root cause:** `DPL-026`–`DPL-029` implemented the runtime `toLambdaHandler` dispatchers and SAM
  event snippets in unit tests without wiring `deploy-build.ts` trigger codegen or running
  `sam validate --lint` (`C5` in `07-deploy-cloud-checks.md`).
- **Impact on developers & scalability:** AWS event-driven units (`@OnSns`, `@OnEventBridge`,
  `@OnStepTask`) and AWS WebSocket units cannot be built or deployed via `tsir deploy:build`.
- **Cost / operational trade-offs:** None; fixing build codegen and SAM templates enables native
  serverless AWS event topologies within AWS Always-Free tiers (1M SQS, 1M SNS, 4k Step Functions).
- **Migration effort:** **S–M** (2–3 days).
- **Recommended architectural direction:** Extend `AdapterTrigger` in `deploy-build.ts` with `'sns'`,
  `'eventbridge'`, and `'invoke'`; fix `EventPattern` indentation in `sam.ts`; and refuse
  `websocket` on `AWS::Serverless::HttpApi` with a clear `DPL_CAPABILITY_MISSING` diagnostic until
  the dedicated `AWS::ApiGatewayV2::Api` (`WEBSOCKET`) emitter ships.

---

### `INF-006` — Missing `ExecutionLifecycle.waitUntil` & per-request binding context in `@tsir/http`

- **Severity / Priority:** **High (`P1`)** — Background Execution & Serverless Reliability
- **Affected subsystem:** `@tsir/http` (`src/framework/http/src/context.ts`), `@tsir/deploy`
  (`cloudflare.ts`, `lambda.ts`), `src/apps/admin.product.com/app.ts:280-369`
- **Current behavior:** `createFetchHandler` accepts `(request: Request)` only, and `RequestContext`
  has no `waitUntil(promise)` method or `env` carrier. In `admin.product.com/app.ts:356-367`,
  `void requestLogger.record({...})` is fired without awaiting or registering with Cloudflare's
  `ExecutionContext.waitUntil()`.
  - On **Cloudflare Workers**, unawaited promises not passed to `ctx.waitUntil()` may be cancelled as
    soon as the HTTP `Response` finishes streaming.
  - On **AWS Lambda**, there is no post-response background window: the Firecracker microVM freezes
    all CPU execution the instant the `handler` promise resolves, leaving in-flight TCP writes hung
    until a subsequent invocation thaws the environment (or lost permanently on scale-down).
- **Root cause:** Minimal `(Request) => Promise<Response>` handler signature omitted optional
  platform execution metadata `(request, env, executionCtx)`.
- **Impact on developers & scalability:** Audit logs, telemetry flushes (`pulse` buffered sinks),
  cache warmups, and Hyperdrive socket cleanup (`sql.end()`) either add latency to every HTTP
  response or silently drop/corrupt under serverless execution.
- **Cost / operational trade-offs:** On Cloudflare Workers, `ctx.waitUntil()` extends lifetime up to
  30 s after response at **zero wall-clock charge** (billed only for active CPU milliseconds). On
  AWS Lambda, awaiting `waitUntil` tasks before handler return adds 1–5 ms of billed GB-s duration
  per request — far cheaper and safer than lost audit records or frozen sockets.
- **Migration effort:** **S** (1–2 days, backward-compatible optional parameter).
- **Recommended architectural direction:** Add `ctx.waitUntil(task: Promise<unknown>): void` to
  `RequestContext` with deterministic per-target semantics:
  - **Cloudflare Workers:** delegates to native `executionContext.waitUntil(task)`.
  - **AWS Lambda:** collects registered promises per request and awaits `Promise.allSettled(pending)`
    immediately before `toLambdaHandler` returns the formatted response (bounded by remaining time).
  - **Bun / Long-running server:** tracks pending tasks in an in-flight set drained during graceful
    `SIGTERM` shutdown.

---

### `INF-007` — Hybrid cloud deployments blocked by queue-trigger matrix conflation & AWS-only `@tsir/deploy/internal`

- **Severity / Priority:** **High (`P1`)** — First-Class Hybrid Infrastructure
- **Affected subsystem:** `@tsir/deploy` (`src/framework/deploy/src/queue-triggers.ts`,
  `src/framework/deploy/src/internal.ts`), `@tsir/queue` (`src/framework/queue/src/drivers/sqs.ts`)
- **Current behavior:**
  1. `checkQueueConnections` (`queue-triggers.ts:127-189`) checks `QUEUE_TRIGGER_MATRIX[driver][target]`
     for _every_ target in `deploy.targets`. Because `QUEUE_TRIGGER_MATRIX.sqs.cloudflare` is
     `'unsupported'`, an application cannot configure Cloudflare Workers for `http` (producing jobs
     to SQS over HTTPS) and AWS Lambda / ECS / Bun for `queue` (consuming SQS).
  2. `sqsDriver` (`sqs.ts`) requires an `SqsLike` SDK object (`@aws-sdk/client-sqs`), lacking a
     lightweight WebCrypto SigV4 `fetch` client (even though `@tsir/storage/src/sigv4.ts` and
     `@tsir/mail/src/transports/ses.ts` already implement zero-dependency WebCrypto SigV4!).
  3. `@tsir/deploy/internal` (`publish`, `invokeUnit` in `internal.ts`) dynamically imports
     `@aws-sdk/client-sns` and `@aws-sdk/client-lambda`, uses Node `Buffer`, and reads
     `process.env.TSIR_STACK_NAME`, throwing at runtime on Cloudflare Workers or Bun without AWS.
- **Root cause:** `deploy.targets` was modeled as "build every unit identically for target X" rather
  than allowing **per-unit target placement** in Hybrid topologies (`http` → `cloudflare`,
  `queue:heavy` → `lambda` or `bun`), and queue _producer_ capability was conflated with _consumer
  trigger_ capability.
- **Impact on developers & scalability:** Blocks the canonical Hybrid architecture (Cloudflare Edge
  HTTP + AWS SQS/Lambda/Container heavy workers).
- **Cost / operational trade-offs:** WebCrypto SigV4 SQS `SendMessage` over HTTPS from Workers adds
  zero bundle dependencies (~3 KB) and $0 Cloudflare egress, enabling seamless cross-cloud job
  handoff (~15–40 ms enqueue RTT to nearest AWS region, or async via D1 outbox relay).
- **Migration effort:** **M** (3–5 days).
- **Recommended architectural direction:**
  1. Split queue validation into **Producer compatibility** (can unit A `push()` over HTTP/binding on
     its target?) vs **Consumer trigger compatibility** (can consumer unit B be triggered by this
     broker on unit B's target?), and allow optional per-unit `target` overrides in `deploy.units`.
  2. Extract shared WebCrypto SigV4 into an internal/shared helper or add `sqsHttpClient({ region, credentials })`
     in `@tsir/queue` so Workers and Bun can enqueue/poll SQS with zero `@aws-sdk/client-sqs` weight.
  3. Make `publish` / `invokeUnit` a transport port with AWS (`SNS`/`Lambda`), Cloudflare (Service
     Bindings / Queues), and Local/HTTP implementations.

---

### `INF-008` — `@tsir/storage` `s3Driver` sends legacy `x-amz-acl` headers, buffers full objects in RAM, and lacks native `R2Bucket` binding support

- **Severity / Priority:** **High (`P1`)** — Storage Portability, Memory Limits & Edge Performance
- **Affected subsystem:** `@tsir/storage` (`src/framework/storage/src/drivers/s3.ts:192-194,207-231,291-300`),
  `@tsir/deploy` (`wrangler.ts`)
- **Current behavior:**
  1. When `put(..., { visibility })` or `setVisibility()` is called, `s3Driver` sends
     `x-amz-acl: public-read | private` and `PUT ?acl`. **Cloudflare R2 does not implement S3 Object
     ACLs**, and **AWS S3 buckets created since April 2023 default to `BucketOwnerEnforced` (ACLs
     disabled)** — both return `400 Bad Request (AccessControlListNotSupported)`.
  2. `put(key, body: Uint8Array)` and `get(key)` buffer the entire payload in heap memory and compute
     `sha256Hex(body)` over the full `Uint8Array`. On Cloudflare Workers (128 MB isolate memory
     shared across concurrent requests), uploading or downloading a 60–100 MB file triggers
     isolate OOM (`Error 1102` / memory limit exceeded). Multipart uploads (`CreateMultipartUpload` /
     `UploadPart`) are not implemented.
  3. `wrangler.ts` emits `[[r2_buckets]]` Worker bindings (`env.UPLOADS`), yet `@tsir/storage` ships
     no `cloudflareR2Driver(bucket: R2BucketLike)` — forcing Workers apps to mint S3 API credentials
     and pay SigV4 + HTTPS round-trip overhead instead of using the zero-config in-runtime binding.
- **Root cause:** First-generation S3 REST implementation targeted small payloads and pre-2023 S3 ACL
  semantics.
- **Impact on developers & scalability:** Large file uploads/downloads crash isolates; `visibility`
  options fail on modern S3 and R2; Wrangler R2 bindings emitted by `@tsir/deploy` have no matching
  `@tsir/storage` driver.
- **Cost / operational trade-offs:** Direct browser-to-R2/S3 presigned `PUT` URLs (`temporaryUploadUrl`)
  and native `R2Bucket` streaming bypass Worker memory limits and Lambda's 6 MB buffered payload cap
  completely, saving compute billing on both clouds.
- **Migration effort:** **M** (3–4 days).
- **Recommended architectural direction:**
  1. Make ACL headers opt-in (`aclMode: 'none' | 'object-acl'`, default `'none'`), reporting
     `setVisibility` capability honestly (`visibilityControl: false` when `'none'`).
  2. Add `temporaryUploadUrl(key, expiresInMs, { contentType, maxBytes? })` (presigned `PUT`) and
     `putStream(key, stream, { contentLength })` + multipart upload helper for server-side large files.
  3. Add zero-dependency structural `cloudflareR2Driver({ bucket, publicBaseUrl })` for Workers
     `R2Bucket` bindings (falling back to `s3Driver` only when `temporaryUrl` presigning is needed).

---

### `INF-009` — WebSocket & real-time split brain (`@tsir/link/ws` vs `@tsir/broadcast`) + listener/Redis memory leak

- **Severity / Priority:** **High (`P1`)** — Real-Time Scalability & Memory Safety
- **Affected subsystem:** `@tsir/broadcast` (`src/framework/broadcast/src/websocket.ts:70-73,163-165,192-245`,
  `src/framework/broadcast/src/redis.ts`), `@tsir/link` (`src/framework/link/src/rooms.ts`)
- **Current behavior:**
  1. **Memory & Redis subscription leak:** In `websocket.ts:163`, `handleSubscribe` calls
     `options.broadcaster.subscribe(channel, (broadcast) => sendTo(send, broadcast))` and **discards
     the returned unsubscribe function**. When a client unsubscribes or disconnects (`unregister`),
     the callback stays registered in `broadcaster` forever — retaining dead socket closures in RAM
     and preventing `redisBroadcaster` from ever calling `client.unsubscribe()`.
  2. **Process-local presence:** `presence` in `websocket.ts:72` is an in-memory `Map`. Across two
     Bun/Container replicas behind a load balancer, User A on Node 1 and User B on Node 2 receive
     incomplete `pusher:subscription_succeeded` member lists and miss cross-node whispers unless
     routed through `broadcaster`.
  3. **Architectural split:** `@tsir/link/ws` (`createRoom`) models stateful, single-writer,
     hibernatable Cloudflare Durable Object rooms (`ADR-0025`), while `@tsir/broadcast` models
     Pusher/Reverb channels over long-lived in-memory sockets. Neither supports AWS API Gateway
     WebSocket API (`$connect`/`$disconnect`/`$default` + DynamoDB connection store + `@connections`
     `PostToConnectionCommand`), and server-side services have no unified port to publish an event to
     a room/channel regardless of whether clients terminate on Durable Objects, Bun/Redis, Pusher, or
     API Gateway.
- **Root cause:** `@tsir/link/ws` (Phase 5) and `@tsir/broadcast` (Phase 10 parity) were built
  independently for different mental models (DO room actor vs Reverb Pusher server).
- **Impact on developers & scalability:** Long-running `@tsir/broadcast` servers leak memory under
  connection churn; horizontal scaling breaks presence; switching between Cloudflare DOs, AWS API
  Gateway WS, and Redis-backed containers requires rewriting real-time application code.
- **Cost / operational trade-offs:** Durable Object Hibernation reduces idle WebSocket compute
  billing on Cloudflare to **$0** (plus 20:1 message ratio = $0.0075 per million inbound WS frames
  beyond included quota), whereas non-hibernating sockets or chatty Redis heartbeats incur continuous
  compute/command charges.
- **Migration effort:** **M** (4–5 days).
- **Recommended architectural direction:**
  1. Store per-(socket, channel) unsubscribe callbacks in `WebSocketConnection` and invoke them in
     both `handleUnsubscribe` and `unregister` (**XS** immediate fix).
  2. Keep both abstractions for their distinct strengths (`Room` = stateful single-writer actor;
     `Broadcaster` = stateless pub/sub fan-out), and add two thin bridges:
     `durableObjectBroadcaster({ namespace })` (Workers HTTP/Queue units publishing to DO rooms) and
     `apiGatewayBroadcaster({ endpoint, store })` (AWS Lambda publishing via `@connections` HTTP
     SigV4, auto-pruning `410 Gone` connections).

---

### `INF-010` — `@tsir/telemetry` hardcodes SQLite Drizzle schemas while calling `drizzle.transaction()` (failing on both D1 and PostgreSQL)

- **Severity / Priority:** **High (`P1`)** — Observability Portability & D1 Runtime Failure
- **Affected subsystem:** `@tsir/telemetry` (`src/framework/telemetry/src/request-logger.ts:11-12,45`,
  `src/framework/telemetry/src/queue-monitor.ts:14-15,79,220-237`)
- **Current behavior:**
  1. Both modules import `sqliteTable`, `integer`, `text` from `drizzle-orm/sqlite-core` and require
     `SqliteRemoteDatabase` — making `@tsir/telemetry` unusable with PostgreSQL (`PgDatabase`),
     despite `docs/cloud-vps-compatibility.md` listing `@tsir/telemetry` as DB-agnostic.
  2. Inside `queue-monitor.ts:220`, `retryJob()` calls `await drizzle.transaction(async (tx) => ...)`.
     On Cloudflare D1 (`SqliteRemoteDatabase`'s primary target!), interactive `BEGIN` transactions
     are **rejected by D1** (`ADR-0016 § 1.2`), so `retryJob()` throws at runtime on D1!
  3. `queue-monitor.ts` queries `queue_jobs` and `queue_dead` directly via SQL instead of going
     through `@tsir/queue`'s `QueueBackend` (`size()`, `dead()`, `replay()`), so dashboards report
     zero pending/running jobs when `cloudflare-queues` or `sqs` is configured.
- **Root cause:** `@tsir/telemetry` bypassed `@tsir/database`'s dialect-aware `{ capabilities, query, batch }`
  structural SQL port (`SessionSql` / `QueueSql`) in favor of concrete `sqlite-core` Drizzle tables.
- **Impact on developers & scalability:** Dead-letter retry from the admin UI fails on Cloudflare D1;
  PostgreSQL deployments cannot compile `@tsir/telemetry`; cloud broker queues show inaccurate
  metrics.
- **Cost / operational trade-offs:** High-traffic HTTP request logging to D1 writes 1 row per HTTP
  request (50M writes/month included on Workers Paid, then **$1.00 per million writes** — at 100M
  requests/month, raw per-request SQL logging costs $50/mo in D1 writes alone unless sampled, batched,
  or routed to Workers Logs / OTLP).
- **Migration effort:** **S** (2 days).
- **Recommended architectural direction:** Refactor `@tsir/telemetry` onto the structural SQL port
  (`{ capabilities: { engine, placeholder }, query, batch }`, matching `@tsir/auth` and `@tsir/queue`),
  use `db.batch([insert, delete])` (atomic on both D1 and Postgres!) or delegate `retryJob` directly
  to `queue.replay(id)`, and add sampling/exclusion filters (`excludePaths: ['/health', '/ready']`)
  to `createRequestLogger`.

---

### `INF-011` — SQL dialect & placeholder leakage in `@tsir/pennant` and application queries

- **Severity / Priority:** **High (`P1`)** — Database Engine Portability
- **Affected subsystem:** `@tsir/pennant` (`src/framework/pennant/src/stores.ts:50-88`),
  `src/apps/admin.product.com`
- **Current behavior:** `@tsir/pennant`'s `databaseStore` accepts a bare `query(sql, params)`
  callback and hardcodes SQLite `?` placeholders (`WHERE name = ?`, `VALUES (?, ?, ?)`), throwing a
  SQL syntax error on PostgreSQL (`$1, $2, $3`).
- **Root cause:** `databaseStore` took a raw function rather than Tsir's standard structural SQL port
  `{ capabilities: { placeholder }, query }`.
- **Impact on developers & scalability:** Feature flags backed by `databaseStore` fail immediately
  when switching from D1/SQLite to PostgreSQL.
- **Cost / operational trade-offs:** None.
- **Migration effort:** **XS** (< 0.5 day; accept either legacy `QueryFn` with optional
  `{ placeholder?: 'question' | 'dollar' }` or structural `Database` object).
- **Recommended architectural direction:** Support both `databaseStore(db)` (reading
  `db.capabilities.placeholder`) and `databaseStore(queryFn, { placeholder: 'dollar' })` without
  breaking existing callers.

---

### `INF-012` — Runtime target detection misclassifies Node.js as `'lambda'` and `bun` deploy target collapses multi-unit worker separation

- **Severity / Priority:** **High (`P1`)** — Container, VPS & Dedicated Worker Deployments
- **Affected subsystem:** `@tsir/core` (`src/framework/core/src/capabilities.ts:71-79`),
  `@tsir/console` (`src/framework/console/src/commands/deploy-build.ts:395-409`)
- **Current behavior:**
  1. `detectTarget()` returns `'lambda'` whenever `process.versions.node` is set — so a long-running
     Node.js 22 container on Fly.io, Cloud Run, ECS Fargate, Railway, Render, or Hetzner is treated
     as AWS Lambda (e.g., clamping Postgres `resolvePool` to `max: 1` instead of the configured pool
     size!).
  2. `deploy-build.ts` for `--target bun` emits only a single `dist/bun/server.mjs` HTTP server
     exposing `fetch`. It emits no entrypoint or process supervisor manifest (`Procfile` / Compose
     roles) for `queue` workers (`queue:work`), `schedule` runners (`schedule:work`), or isolated
     `admin`/`ws` units.
  3. `TARGET_CAPABILITIES.cloudflare` omits `'node-compat'`, even though `wrangler.ts` emits
     `compatibility_flags = ["nodejs_compat"]`.
- **Root cause:** `DeployTarget` only modeled three initial environments (`bun`, `cloudflare`,
  `lambda`), conflating runtime engine (`node` vs `bun`) with hosting lifecycle (ephemeral Lambda vs
  long-running server/container).
- **Impact on developers & scalability:** Node.js containers silently run with `pool.max = 1`;
  dedicated worker deployments (`Profile E`) must invoke `tsir` CLI source commands directly rather
  than running self-contained built `dist/` worker artifacts.
- **Cost / operational trade-offs:** Self-contained `dist/bun/worker.mjs` and `dist/bun/scheduler.mjs`
  bundles allow slim production container images without shipping workspace dev toolchains.
- **Migration effort:** **S–M** (2–3 days).
- **Recommended architectural direction:** Distinguish `AWS_LAMBDA_FUNCTION_NAME` (true Lambda) from
  generic Node.js (`'node'` or `'container'`), honor `nodejs_compat` in Cloudflare capability checks,
  and emit `dist/bun/{server,worker,scheduler}.mjs` entrypoints from `tsir deploy:build --target bun`.

---

### `INF-013` — WebCrypto PBKDF2 (210,000 iterations) approaches Cloudflare Workers Free 10 ms CPU ceiling

- **Severity / Priority:** **Medium (`P2`)** — Free-Tier Edge Reliability & DoS Resilience
- **Affected subsystem:** `@tsir/auth` (`src/framework/auth/src/password.ts:76-92`)
- **Current behavior:** `defaultHasher` runs WebCrypto `PBKDF2-SHA256` with `210,000` iterations
  (OWASP 2023+ recommendation). While `workerd` supports >100k iterations in modern compatibility
  dates and Workers Paid grants 30,000 ms CPU/invocation, **Workers Free enforces a hard 10 ms CPU
  limit per HTTP invocation**. Depending on isolate load, 210k PBKDF2 + JSON validation + D1 session
  writes consumes 5–14 ms of CPU, risking intermittent `Error 1102 (Worker exceeded CPU time limit)`
  on Free-plan login/signup bursts, and amplifying CPU exhaustion if login endpoints lack rate
  limiting (`15-capabilities.md § 9`).
- **Root cause:** Security-first OWASP default does not warn about Workers Free's 10 ms CPU cap.
- **Impact on developers & scalability:** Intermittent 503/1102 errors on Workers Free accounts under
  concurrent logins; Paid accounts ($5/mo, 30 s default CPU) are unaffected.
- **Cost / operational trade-offs:** Never lower the default cryptographic floor silently; instead,
  pair login routes with Cloudflare WAF / Turnstile / rate limiting or configurable `iterations`
  (>= `100_000` floor already enforced in `password.ts:84`) when explicitly targeting Workers Free.
- **Migration effort:** **XS** (documentation + `tsir doctor` diagnostic check).
- **Recommended architectural direction:** Keep `210,000` as the secure default, document the Workers
  Free 10 ms CPU boundary in `17-infrastructure-philosophy.md`, and add login rate-limiting guidance.

---

### `INF-014` — Stale platform constants & documentation drift across `deploy`, `queue`, and `docs`

- **Severity / Priority:** **Medium (`P2`)** — Developer Experience & False Build Failures
- **Affected subsystem:** `deploy-build.ts:53`, `cloudflare-queues.ts:39`, `plans/modules/08-deploy.md § 3.1`,
  `docs/cloud-vps-compatibility.md`
- **Current behavior:**
  1. `DEFAULT_BUDGETS.cloudflare` in `deploy-build.ts:53` is hardcoded to `1_048_576` (1 MiB),
     failing builds that are well within Cloudflare Workers' current **64 MiB** script limit (and
     even legacy 3 MiB Free / 10 MiB Paid limits).
  2. `CLOUDFLARE_QUEUES_MAX_DELAY_SECONDS` in `cloudflare-queues.ts:39` is `43_200` (12 hours),
     whereas Cloudflare Queues now supports **`86_400` seconds (24 hours)**.
  3. `plans/modules/08-deploy.md § 3.1` states _"D1 is not a supported database target"_, whereas
     `ADR-0016` made D1 the default engine and `src/framework/deploy/src/wrangler.ts:119-128`
     actively emits `[[d1_databases]]`.
- **Root cause:** Platform limits increased in 2025–2026 and `ADR-0016` superseded early Phase 6 prose.
- **Impact on developers & scalability:** Premature `DPL_SIZE_BUDGET` failures on multi-module
  Workers and artificial refusal of 12–24h delayed jobs on Cloudflare Queues.
- **Cost / operational trade-offs:** Keep a conservative soft warning (e.g., 1 MiB gzipped for cold-start
  hygiene) while raising the hard default error budget to match Free/Paid reality (e.g., 3 MiB gz
  default, configurable up to platform ceiling).
- **Migration effort:** **XS** (< 0.5 day).
- **Recommended architectural direction:** Update `08-deploy.md` immediately (done in this planning
  pass); schedule constant updates (`INF-014`) in `16-infrastructure-hardening.md`.

---

### `INF-015` — Native binary / HTTP2 modules (`@tsir/media` `ffmpeg`/`sharp`, `@tsir/link/grpc`) lack build-time capability attribution

- **Severity / Priority:** **Medium (`P2`)** — Workload Placement Safety
- **Affected subsystem:** `@tsir/media` (`ffmpeg.ts`, `sharp.ts`), `@tsir/link` (`grpc.ts`),
  `@tsir/forge`, `@tsir/deploy` (`capabilities.ts`)
- **Current behavior:** `@tsir/link/src/index.ts` re-exports `grpc.ts` (which statically imports
  `@grpc/grpc-js`, pulling Node `http2`/`tls`/`dns`/`fs` into any bundle that doesn't tree-shake it),
  and `@tsir/media`'s `ffmpegAdapter` (`child_process.spawn`) / `sharpAdapter` (native `libvips`)
  fail only at **runtime** if accidentally wired into a `cloudflare` or `lambda` (without native
  layer) unit unless the developer manually declares `requires: ['child-process', 'native-addons']`
  on the module.
- **Root cause:** Capability probes exist in `@tsir/core` (`RuntimeCapability`), but adapters do not
  carry static `requiredCapabilities` metadata that `deploymentOf()` can inspect automatically.
- **Impact on developers & scalability:** Late runtime failures instead of build-time
  `DPL_CAPABILITY_MISSING` errors when heavy media or gRPC modules are placed on isolate targets.
- **Cost / operational trade-offs:** Zero runtime cost; catches invalid workload placement in CI.
- **Migration effort:** **S** (1–2 days).
- **Recommended architectural direction:** Move `@grpc/grpc-js` to a dedicated subpath export
  (`@tsir/link/grpc` only, removed from `@tsir/link` root barrel if unused, or keep subpath-isolated)
  and attach `readonly requires: readonly RuntimeCapability[]` metadata to `ffmpegAdapter`
  (`['child-process', 'fs']`) and `sharpAdapter` (`['native-addons']`) so `deploy:plan` routes or
  rejects incompatible targets automatically.

---

### `INF-016` — Flagship `admin.product.com` uses runtime `node:fs` static serving & `cf-connecting-ip`

- **Severity / Priority:** **Medium (`P2`)** — Reference App Cloud Portability
- **Affected subsystem:** `src/apps/admin.product.com/app.ts:19-21,239-265,354,356-367`
- **Current behavior:** `app.ts` serves `/public/*` and `index.html` using synchronous `existsSync`,
  `statSync`, and `readFileSync` from `import.meta.dir`, extracts client IP strictly from
  `cf-connecting-ip`, and fires `requestLogger.record` without `waitUntil`.
- **Root cause:** Built first for `bun serve.ts` local execution before Workers Static Assets / S3+CloudFront
  asset separation was wired.
- **Impact on developers & scalability:** Synchronous filesystem I/O blocks the event loop under
  load on Bun/Node and fails on Cloudflare Workers (where static assets live in Workers Static Assets
  `env.ASSETS` or Cloudflare Pages) unless fronted by an asset binding.
- **Cost / operational trade-offs:** Serving `public/*` via Cloudflare Workers Static Assets is
  **100 % free and unlimited** (does not invoke the Worker or consume request/CPU quota!), whereas
  serving static files through `readFileSync` / Worker JS bills every `.js`/`.css`/`.svg` hit as a
  dynamic invocation.
- **Migration effort:** **S** (1 day).
- **Recommended architectural direction:** Delegate static asset serving to `env.ASSETS.fetch(request)`
  on Cloudflare Workers, CloudFront/S3 on AWS, and `Bun.file()` in `serve.ts`, while keeping `app.ts`
  focused on `/api/*` and SPA HTML fallback; use `ctx.clientIp` + `ctx.waitUntil` (`INF-006`).

---

## 5. Summary Priority Matrix

| Priority | IDs                                                                         | Theme                                                                                                                                                                                                                                    | Target Gate                |
| -------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **P0**   | `INF-001`, `INF-002`, `INF-003`, `INF-004`, `INF-005`                       | Fix Postgres `$1/$1` auth bug, decouple `bun:sqlite` bootstrap, wire Postgres/Hyperdrive config, fix CF Queue batch loss, fix Lambda/SAM event & WS emitters                                                                             | Immediate (pre-scale)      |
| **P1**   | `INF-006`, `INF-007`, `INF-008`, `INF-009`, `INF-010`, `INF-011`, `INF-012` | Add `waitUntil` + request-scoped `env`, unblock Hybrid CF→SQS, fix S3/R2 ACLs + `R2Bucket` + presigned PUT, fix WS subscription leak + DO/APIGW bridges, make `telemetry` & `pennant` dialect-neutral, add Node/Container worker bundles | Next milestone             |
| **P2**   | `INF-013`, `INF-014`, `INF-015`, `INF-016`                                  | Document Free-tier PBKDF2 CPU cliff + rate-limiting, update CF bundle/queue constants & docs, annotate native-binary capabilities, make `admin.product.com` edge-asset-native                                                            | Hardening pass             |
| **P3**   | `INF-017`, `INF-018`, `INF-019`, `INF-020`                                  | Decide the Redis driver question, decide workflow orchestration, decide read-replica routing, decide native DLQ/backoff policy                                                                                                           | After the P1 findings land |

### 5.1 Disposition of this audit

This is an **audit of the source tree at `676a5a3`**, not a gate review with a sign-off: it was
performed by reading every package and running the existing suites, not by an independent reviewer
(`SEC-004` still wants one, and `reviews/README.md` says so). Every one of the sixteen findings is
**open** — none has a fix in this repository yet. The disposition is therefore uniform and honest:
_found, documented, scheduled_, with the accepting record in
[ADR-0030](../decisions/0030-hybrid-cloud-and-workload-substrates.md) and the ledger in
[`../tasks/16-infrastructure-hardening.md`](../tasks/16-infrastructure-hardening.md).

Four facts a reader should take away, in order of consequence:

1. **The portability claim is currently wider than the working provider matrix.** Postgres is
   declared in `tsir.js`, in `05-database.md` and in a dedicated driver — and it fails in three
   independent places (`INF-001`, `INF-003`).
2. **The default Cloudflare path has one silent data-loss bug** (`INF-004`: whole-batch
   `ackAll`/`retryAll` plus a `batchSize: 1` drain) and one silent work-loss bug (`INF-006`:
   background writes with no `waitUntil`). Both are the kind that pass every test and drop work in
   production.
3. **The AWS path emits an invalid template** for the three trigger kinds that make Lambda worth
   using (`INF-005`), so an AWS-first deployment is not merely unproven — it is wrong at the
   artefact level.
4. **Hybrid is refused by the build** (`INF-007`), which is the one finding that contradicts the
   stated philosophy most directly, because it is a deliberate check rather than an omission.

### 5.2 What is genuinely verified, and should not be re-audited

The audit is mostly a list of defects, so it is worth recording the parts that survived inspection
unchanged — these are the foundation the fixes rest on:

| Property                                                                                             | Evidence                                                                                         |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `(Request) => Promise<Response>` works on Bun, Workers and Lambda with no `node:`/`bun:` in the core | existing adapter tests + `make verify-dist` Workers/Lambda probes                                |
| The capability driver pattern, the closed driver set and six conformance kits                        | `@tsir/cache`, `@tsir/queue`, `@tsir/storage`, `@tsir/mail`, `@tsir/notify`, `@tsir/auth` suites |
| SigV4 written out against WebCrypto, checked against AWS's published vectors                         | `@tsir/storage` `sigv4.ts` + its tests                                                           |
| `@tsir/pulse`: four formats, three redaction layers, `traceparent`, fail-open sinks                  | 123 tests, 97.27 % lines                                                                         |
| `@tsir/schedule`: UTC-enforced cron, two lock drivers, `DPL_CRON_NOT_UTC` at build time              | package tests + deploy graph tests                                                               |
| The deploy graph as a committed, diffable artefact with secret scanning                              | ADR-0026, `deploy:validate`, `DPL_PRIVATE_EXPOSED`                                               |
| No `any`, no global service locator, no reflection on the hot path                                   | `plans/README.md` § 6, boundary checks, review                                                   |

## 6. Failure modes

How this audit itself can fail, which matters because a document like this is trusted.

| Failure                                          | Why it happens                                                | The guard                                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A finding is stale the moment it is fixed        | nobody re-reads a review after the fix                        | each `INF-NNN` is closed by a task in `tasks/16-infrastructure-hardening.md` that also moves the status label in `17-infrastructure-philosophy.md § 16` |
| A finding is wrong                               | it was inferred from a type signature, not read in the source | every finding names a file, often a line; a reader can falsify it in one `grep`                                                                         |
| The severity is inflated                         | "P0" is easier to write than "annoying"                       | P0 means silent data loss, a broken declared provider, or an invalid artefact — nothing else                                                            |
| The audit becomes a second source of truth       | it restates the module plans and then drifts from them        | it cites the plan documents and owns only the findings; the philosophy document owns the position                                                       |
| Someone treats it as a gate review with sign-off | the file lives in `reviews/`                                  | § 5.1 states the disposition; `reviews/README.md` repeats that no independent reviewer exists                                                           |

## 7. Security considerations

The audit read security-relevant code, so its own handling rules matter.

- **No credential appears in this document.** Connection strings, key material and account ids are
  referenced by variable name only (`APP_KEY_NOW`, `HYPERDRIVE`), which is the same rule
  `@tsir/config` enforces on a dump.
- **Severity is assigned with a security lens, not only an availability one.** `INF-001` is P0 for
  two reasons: it breaks session rolling expiry and it can leave a revoked API key live — that is an
  authorization defect, not a query bug.
- **`INF-013` is a availability-security finding.** An unauthenticated endpoint that spends 5–14 ms
  of a 10 ms CPU budget per attempt is a one-request outage; the mitigation is a rate limit, which is
  a security control.
- **This document does not assess the provider's security posture** — Cloudflare Access, IAM policy,
  VPC design and secret rotation belong to [`../operations/14-security.md`](../operations/14-security.md).
- **Findings are reproducible without production access.** Everything here was read in the repository;
  no live account, token or customer data was involved.

## 8. Open questions

| #     | Question                                                                                                                                                                                                 | Decides    |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `Q60` | `Q60` is defined in [`../architecture/17-infrastructure-philosophy.md § 19`](../architecture/17-infrastructure-philosophy.md#19-open-questions) — this audit raises it, the philosophy document owns it. | `INF-012`  |
| `Q61` | Defined in the same register — the workflow-seam question.                                                                                                                                               | `INF-018`  |
| `Q63` | Defined in the same register — read-replica routing.                                                                                                                                                     | `INF-019`  |
| `Q64` | Defined in the same register — native DLQ and backoff policy.                                                                                                                                            | `INF-020`  |
| `Q65` | Defined in the same register — which side owns the canonical secret store in a hybrid.                                                                                                                   | P3 profile |

Two questions are audit-specific and are not in that register:

| #   | Question                                                                                                                       | Decides               |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| Q69 | Does an independent reviewer exist for `SEC-004`, or does the audit stay "author-reviewed, not audited" indefinitely?          | `SEC-004`             |
| Q70 | Should the `INF-NNN` prefix survive into the task ledger permanently, or be re-homed into `DPL`/`DB`/`CAP` once the P0s close? | `tasks/README.md` § 2 |

## 9. Task index

Every finding is scheduled in
[`../tasks/16-infrastructure-hardening.md`](../tasks/16-infrastructure-hardening.md):

| Finding   | Task      | Priority |
| --------- | --------- | -------- |
| `INF-001` | `INF-001` | P0       |
| `INF-002` | `INF-002` | P0       |
| `INF-003` | `INF-003` | P0       |
| `INF-004` | `INF-004` | P0       |
| `INF-005` | `INF-005` | P0       |
| `INF-006` | `INF-006` | P1       |
| `INF-007` | `INF-007` | P1       |
| `INF-008` | `INF-008` | P1       |
| `INF-009` | `INF-009` | P1       |
| `INF-010` | `INF-010` | P1       |
| `INF-011` | `INF-011` | P1       |
| `INF-012` | `INF-012` | P1       |
| `INF-013` | `INF-013` | P2       |
| `INF-014` | `INF-014` | P2       |
| `INF-015` | `INF-015` | P2       |
| `INF-016` | `INF-016` | P2       |
| —         | `INF-017` | P2       |
| —         | `INF-018` | P2       |
| —         | `INF-019` | P3       |
| —         | `INF-020` | P3       |

Reading order, and the reasoning for it, is in the philosophy document's task index
([§ 20](../architecture/17-infrastructure-philosophy.md#20-task-index)). The short version:
`INF-001` first, because every Postgres claim in `plans/` is waiting on it.
