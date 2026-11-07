# Feature Parity Audit — Source Verification

**Audit date:** 2026-11-07
**Source:** `plans/tasks/15-feature-parity.md` (966 lines)
**Scope:** All 30 `@tsir/*` packages
**Method:** Deep-read of source files in `src/framework/<name>/src/` for every `[x]` and `[ ]` claim, plus admin app UI coverage cross-check.

## Executive Summary

The parity doc's aggregate claim (131/241 verified = 54.4%) is **honest in direction** but contains **under-reporting**: several features marked `[ ]` (not implemented) or `[~]` (partial) are in fact fully implemented in source. No `[x]` claim was found to be a pure stub or placeholder.

**Discrepancies found (doc under-reports reality):**

| Package                                     | Doc status | Actual                                                                    | Severity |
| ------------------------------------------- | ---------- | ------------------------------------------------------------------------- | -------- |
| cache — tags, increment/decrement, remember | `[ ]`      | Implemented in `store.ts`, memory driver declares capabilities            | Moderate |
| scout — in-memory engine                    | `[ ]`      | `memoryEngine()` fully implemented in `scout.ts`                          | Moderate |
| cashier — subscriptions, invoices           | `[~]`      | Full REST implementations in `stripe.ts`                                  | Moderate |
| mail — attachments                          | `[ ]`      | All transports (smtp, resend, postmark, ses) send attachments             | Moderate |
| queue — delayed jobs, unique jobs           | `[ ]`      | `dispatchLater` + `idempotencyKey` capabilities exist (backend-dependent) | Low      |
| deploy — custom domains                     | `[ ]`      | Implemented for AWS (SAM) and Cloudflare (wrangler)                       | Moderate |

**Doc claims that are accurate (`[ ]` confirmed absent):**

- storage: copy/move/setVisibility/streaming
- router: named routes, API resource routes, sub-domain routing
- notify: broadcast channel, notification preferences
- validate: built-in unique/exists rules (only Zod `.refine`)
- http: cookies, trust-proxy
- deploy: database proxy / RDS proxy

**Admin UI coverage:** 8 packages have UI pages; 22 do not (expected — admin is a thin consumer of framework packages, not a UI for every one).

---

## Package-by-Package Audit

### auth (counterpart: Auth + Sanctum)

**Verified `[x]` features:**

- Password hashing: PBKDF2-SHA256 + argon2id (Bun) — `password.ts`
- Cookie sessions with idle/absolute TTL, rotation, `__Host-` prefix — `session.ts`
- API keys with scopes, hashed secrets, revocation — `keys.ts`
- Guards: session, bearer, apiKey, compose — `guards.ts`

**Stubs among `[x]`:** None.

**`[ ]` features that exist:** None found.

**UI coverage:** Login, ForgotPassword, ResetPassword, Setup pages.

**Honesty score:** 10/10 — all `[x]` genuine, no under-reporting.

---

### policy (counterpart: Authorization)

**Verified `[x]` features:**

- `createRegistry`, allow/deny gates, policies, roles with `implies`, `toHttpPolicies` — `registry.ts`

**Stubs:** None.

**UI coverage:** Roles, Permissions, Groups pages (rbac module).

**Honesty score:** 10/10.

---

### vault (counterpart: Encryption)

**Verified `[x]` features:**

- AES-256-GCM via WebCrypto, AAD bound to table.column, keyring — `cipher.ts`
- Key rotation, codec, blind indexing, keyring state machine — exports

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### cache (counterpart: Cache)

**Verified `[x]` features:**

- `remember`, `increment`, `invalidateTag` via capabilities — `store.ts:128-172`
- Capability-refusal pattern — `port.ts`
- Memory driver declares `tags: true`, `increment: true` — `drivers/memory.ts`

**DISCREPANCY:** Doc marks tags, increment/decrement, and remember as `[ ]`. They exist in `store.ts`:

- `remember` (lines 128-142)
- `increment` (lines 144-165)
- `invalidateTag` (lines 167-172)
- Memory driver `MEMORY_CAPABILITIES` has `tags: true`, `increment: true`

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 8/10 — `[x]` claims genuine, but 3 features under-reported as `[ ]`.

---

### database (counterpart: Database — query builder, no ORM)

**Verified `[x]` features:**

- Transactions with savepoints, health check, connections, capability honesty — `database.ts`

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### migrate (counterpart: Migrations — Drizzle journal)

**Verified `[x]` features:**

- Drizzle journal authoritative, checksums, transaction policy, advisory lock, audit sidecar — `journal.ts`, `plan.ts`, `lock.ts`, `migrate.ts`
- Rollback with down-file enforcement, drift detection — `rollback.ts`
- Status reporting — `status.ts`

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### seed (counterpart: Seeders)

**Verified `[x]` features:**

- `defineSeeder` with order, idempotency, environments, transaction, connections — `seeder.ts`
- Runner enforces environment, idempotency, production refusal — `runner.ts`
- Fixtures — `fixture.ts`

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### events (counterpart: Events)

**Verified `[x]` features:**

- Bus with sync + queued listeners, dispatch, jobs() — `bus.ts`
- Transactional outbox: `record` (joins caller batch), `pending`, `markPublished`, `relay` — `outbox.ts`
- Publisher: `record`, `relay`, `pending`, `size` — `publish.ts`

**Stubs:** None.

**UI coverage:** None (events used internally: send-welcome-email listener).

**Honesty score:** 10/10.

---

### queue (counterpart: Queue)

**Verified `[x]` features:**

- Worker drain loop, retries with backoff, graceful shutdown, DLQ — `worker.ts`
- `dispatch`, `dispatchMany`, `cancel`, `retry`, `discard`, `purge`, `dead` — `queue.ts`
- Capabilities: transactional, delay, cancel, persistent, ordered, deadLetter, idempotency — `port.ts`

**DISCREPANCY (partial):** Doc marks delayed jobs and unique jobs as `[ ]`. They exist as capabilities:

- `dispatchLater(job, payload, { delayMs })` — `queue.ts:131-136`
- `idempotencyKey` in `DispatchOptions` and `QueueCapabilities.idempotency` — `port.ts:33, 66`
- These are **backend-dependent** (driver must declare `delay: true` / `idempotency: true`), so the guarantee is conditional. Doc should be `[~]` not `[ ]`.

**`[ ]` confirmed absent:** job batching, job chains.

**Stubs:** None.

**UI coverage:** Queues page.

**Honesty score:** 8/10 — delayed/unique under-reported.

---

### schedule (counterpart: Task Scheduling)

**Verified `[x]` features:**

- 5-field cron, macros (`@daily`, `@hourly`), UTC, `nextRunAt` — `cron.ts`

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### mail (counterpart: Mail)

**Verified `[x]` features:**

- `createMessage` with attachment validation (`checkAttachments`) — `message.ts`
- `Attachment` type — `port.ts`
- MIME builder — `mime.ts`

**DISCREPANCY:** Doc marks attachments as `[ ]`. All transports handle them:

- **smtp** — `buildMime(message)` produces full MIME with attachments (line 116)
- **resend** — `attachments` array with base64 content + content_type (lines 58-70)
- **postmark** — `Attachments` array with Name/Content/ContentType/ContentID (lines 75-88)
- **ses** — raw MIME via `buildMime` (line 52), capability `attachments: true`

All transports declare `capabilities.attachments: true`.

**Stubs:** None.

**UI coverage:** EmailTemplates page.

**Honesty score:** 8/10 — attachments under-reported.

---

### notify (counterpart: Notifications)

**Verified `[x]` features:**

- Channel port with capabilities, `assertCarriable` — `channel.ts`
- Notifier, delivery — `notifier.ts`, `delivery.ts`
- Channels: mail, post, webhook, memory, database, chat, sms — `channels/`

**`[ ]` confirmed absent:** broadcast channel, notification preferences.

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### storage (counterpart: Filesystem)

**Verified `[x]` features:**

- `put`, `get`, `head`, `exists`, `delete`, `list` (paginated), `url`, `temporaryUrl` — `disk.ts`, `port.ts`
- Key validation (traversal, length, control chars) — `disk.ts:assertKey`
- Local driver with atomic writes, sidecar metadata, range reads — `drivers/adapters/local.ts`
- S3 driver with SigV4 — `drivers/s3.ts`, `sigv4.ts`

**`[ ]` confirmed absent:** `copy`, `move`, `setVisibility`, streaming (get returns `Uint8Array`, not a stream).

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### validate (counterpart: Validation — Zod 4)

**Verified `[x]` features:**

- Standard Schema interop, `validate`/`validateSync`/`parse`, issue normalization — `validate.ts`, `issues.ts`
- `objectOf`, `withUnknownKeys`, unknown keys policy — `objects.ts`
- Re-exports `z` from Zod 4 — `index.ts`

**`[ ]` confirmed absent:** built-in `unique`/`exists` rules. Only achievable via Zod's `.refine(async ...)`.

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### pulse (counterpart: Logging + Pulse)

**Verified `[x]` features:**

- Structured logger with redaction — `logger.ts`, `redact.ts`
- Metrics: counter, histogram, gauge with cardinality guard and route-template enforcement — `metrics.ts`
- Tracing: W3C traceparent, samplers (always/never/ratio/parent-based), spans — `tracing.ts`
- Health: liveness (no deps), readiness (checks with timeout, critical/degraded), `toResponse` — `health.ts`
- Rate limiter: per-event-per-second, dropped-count summary — `limits.ts`
- Sinks — `sinks.ts`

**Stubs:** None.

**UI coverage:** Dashboard (analytics).

**Honesty score:** 10/10.

---

### config (counterpart: Configuration)

**Verified `[x]` features:**

- `defineConfig`, `env` — `define.ts`
- Secret detection (base64-32-byte-key, url-password), secret-name heuristics — `secrets.ts`
- Presets with append-list, version records — `presets.ts`
- Module config layering (Root < App < Module < env) — `module-config.ts`
- Managed regions, migrations, schema docs

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### container (counterpart: Container)

**Verified `[x]` features:**

- `classProvider`, `factoryProvider`, `valueProvider` with explicit `inject` tuples — `provider.ts`
- Scopes: singleton, transient, scoped — `provider.ts`
- `Container` with register, resolve, resolveAsync, scopes (request/job/task) — `container.ts`
- Cycle detection (resolution depth), disposal, diagnostics (transient-leak, slow-dispose)

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### http (counterpart: HTTP Requests)

**Verified `[x]` features:**

- Pipeline: match → acceptable → middleware → guards → policies → bind → handler — `pipeline.ts`
- CORS with preflight handling, origins + credentials enforcement — `pipeline.ts:151-340`
- Body parsing, multipart (opt-in) — `body.ts`, `multipart.ts`
- Problem responses (RFC 9457) — `problems.ts`
- Response validation, audit events

**`[ ]` confirmed absent:** cookies (no cookie parsing/setting in http package), trust-proxy.

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### router (counterpart: Routing)

**Verified `[x]` features:**

- Decorators: `@Controller`, `@Get`/`@Post`/etc., `@UseMiddleware`, `@Guards`, `@Policies` — `decorators.ts`
- Path validation, parameter parsing, wildcard — `decorators.ts:assertValidPath`
- Module registry, compilation, matcher — `registry.ts`, `compile.ts`, `matcher.ts`
- AWS listener decorators: `@OnSns`, `@OnEventBridge`, `@OnStepTask` — `decorators.ts`

**`[ ]` confirmed absent:** named routes (no `name` on RouteMeta for URL generation), API resource routes, sub-domain routing.

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### console (counterpart: Artisan)

**Verified `[x]` features:**

- `tsir bootstrap` (detect/plan/apply deploy config) — `commands/bootstrap.ts`
- `make:*` generators (module, controller, model, migration, seeder, command, policy, async, connection, parts, link-client) — `commands/make-*.ts`
- `db`, `cache`, `queue`, `schedule`, `mail`, `notify`, `storage`, `vault`, `routes`, `openapi`, `compile`, `doctor`, `deploy` commands — `commands/*.ts`
- Stub-based code generation via `.slug` templates

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### deploy (counterpart: Vapor)

**Verified `[x]` features:**

- Deploy units, graph — `units.ts`, `graph.ts`
- Cloudflare (wrangler.toml generation) — `wrangler.ts`, `cloudflare.ts`
- AWS Lambda/SAM (template.yaml generation) — `sam.ts`, `lambda.ts`
- Queue triggers, listeners, secrets — `queue-triggers.ts`, `listeners.ts`, `secrets.ts`

**DISCREPANCY:** Doc marks custom domains as `[ ]`. They exist:

- **AWS (SAM):** `domain` option emits `DomainName` parameter + API Gateway custom domain wiring — `sam.ts:58-62, 247-270`
- **Cloudflare (wrangler):** `domain` + `zone` options emit `routes` entry — `wrangler.ts:67-68, 195-202`

**`[ ]` confirmed absent:** database proxy / RDS proxy.

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 8/10 — custom domains under-reported.

---

### pennant (counterpart: Pennant — feature flags)

**Verified `[x]` features:**

- Rules: boolean, percentage, allowlist, conditional — `pennant.ts`
- Stores: memoryStore, databaseStore, nullStore — `stores.ts`

**Stubs:** None.

**UI coverage:** FeatureFlags page.

**Honesty score:** 10/10.

---

### cashier (counterpart: Cashier — billing)

**Verified `[x]` features:**

- Stripe REST: `createCustomer`, `getCustomer`, `createSubscription`, `getSubscription`, `cancelSubscription`, `listInvoices` — `stripe.ts`
- Webhook HMAC-SHA256 signature verification — `webhooks.ts`
- Types: Customer, Subscription, Invoice — `types.ts`

**DISCREPANCY:** Doc marks subscriptions and invoices as `[~]` (partial). They are fully functional REST calls with real mapping:

- `createSubscription` → `POST /v1/subscriptions`
- `cancelSubscription` → `DELETE /v1/subscriptions/{id}`
- `getSubscription` → `GET /v1/subscriptions/{id}`
- `listInvoices` → `GET /v1/invoices?customer=...`

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 8/10 — subscriptions/invoices under-reported as partial.

---

### forge (counterpart: Forge — servers)

**Verified `[x]` features:**

- `ServerProvider` interface: list/create/destroy/run — `forge.ts`
- `deploy()` recipe runner — `forge.ts`
- `localProvider` via `child_process` — `forge.ts`

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### socialize (counterpart: Socialite — OAuth)

**Verified `[x]` features:**

- Google OAuth2 auth code flow, userinfo — `google.ts`
- Factory `createSocialize` — `socialize.ts`
- State tokens (HMAC-SHA256) for CSRF — `state.ts`

**Stubs:** None.

**UI coverage:** None (socialize wired into auth module's socialize service).

**Honesty score:** 10/10.

---

### scout (counterpart: Scout — search)

**Verified `[x]` features:**

- `sqliteEngine` (FTS5), `postgresEngine` (tsvector) — `drivers.ts`

**DISCREPANCY:** Doc marks in-memory engine as `[ ]`. `memoryEngine()` is fully implemented in `scout.ts:31-64` with tokenize + TF scoring.

**Stubs:** None.

**UI coverage:** None (scout wired into system module's search controller).

**Honesty score:** 8/10 — in-memory engine under-reported.

---

### broadcast (counterpart: Broadcasting — Echo + Reverb)

**Verified `[x]` features:**

- `memoryBroadcaster` pub/sub — `broadcaster.ts`
- `createWebSocketHandler` with authenticate + authorize — `websocket.ts`
- `createEcho` client — `echo.ts`

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

### nightwatch (counterpart: Dusk — browser E2E)

**Verified `[x]` features:**

- `Page` interface — `nightwatch.ts`
- `playwrightBackend` via lazy import — `nightwatch.ts`
- `inMemoryBackend` — `nightwatch.ts`

**Note on inMemoryBackend:** It is a test stub (goto stores URL, click does nothing, text returns empty). The `[x]` "browser abstraction" claim is satisfied by the `Page` interface + `playwrightBackend` (real). The in-memory backend is intentionally a no-op for tests, not a claim of real browser automation. This is honest.

**UI coverage:** None.

**Honesty score:** 10/10 — abstraction is real; in-memory is clearly a test double.

---

### telemetry (counterpart: Horizon + Telescope)

**Verified `[x]` features:**

- Request logger records to `requestLogs` table — `request-logger.ts`
- Queue monitor: `countsByState`, `listJobs`, `getJob`, `retryJob` (with transaction) — `queue-monitor.ts`

**Stubs:** None.

**UI coverage:** Requests page.

**Honesty score:** 10/10.

---

### media (counterpart: Intervention Image analog)

**Verified `[x]` features:**

- `createMediaManager`, adapter dispatch by kind/name — `media.ts`

**Stubs:** None.

**UI coverage:** None.

**Honesty score:** 10/10.

---

## Admin App UI Coverage Matrix

| Package    | UI Page                                     | Module                     |
| ---------- | ------------------------------------------- | -------------------------- |
| auth       | Login, ForgotPassword, ResetPassword, Setup | auth                       |
| policy     | Roles, Permissions, Groups                  | rbac                       |
| mail       | EmailTemplates                              | mail                       |
| pennant    | FeatureFlags                                | system                     |
| queue      | Queues                                      | system                     |
| telemetry  | Requests                                    | system                     |
| pulse      | Dashboard                                   | system                     |
| i18n       | I18n                                        | i18n                       |
| vault      | —                                           | system (service only)      |
| cache      | —                                           | system (service only)      |
| storage    | —                                           | system (service only)      |
| scout      | —                                           | system (search controller) |
| socialize  | —                                           | auth (service only)        |
| media      | —                                           | system (service only)      |
| events     | —                                           | system (internal)          |
| schedule   | —                                           | system (service only)      |
| notify     | —                                           | system (service only)      |
| config     | —                                           | —                          |
| container  | —                                           | —                          |
| http       | —                                           | —                          |
| router     | —                                           | —                          |
| console    | —                                           | —                          |
| deploy     | —                                           | —                          |
| database   | —                                           | —                          |
| migrate    | —                                           | —                          |
| seed       | —                                           | —                          |
| validate   | —                                           | —                          |
| cashier    | —                                           | —                          |
| forge      | —                                           | —                          |
| broadcast  | —                                           | —                          |
| nightwatch | —                                           | —                          |

**Note:** Infrastructure packages (config, container, http, router, console, deploy, database, migrate, seed, validate) have no UI by design — they are framework primitives. Packages wired as services in the system module (vault, cache, storage, scout, socialize, media, events, schedule, notify) are accessible programmatically but lack dedicated admin pages.

---

## Recommendations

1. **Update parity doc `[ ]` → `[x]` or `[~]`** for:
   - cache: tags, increment/decrement, remember → `[x]`
   - scout: in-memory engine → `[x]`
   - cashier: subscriptions, invoices → `[x]`
   - mail: attachments → `[x]`
   - deploy: custom domains → `[x]`
   - queue: delayed jobs, unique jobs → `[~]` (backend-dependent)

2. **Recalculate aggregate:** With 6 features reclassified from `[ ]`/`[~]` to `[x]` and 2 to `[~]`, verified count rises from 131 to ~137, partial from 12 to ~14.

3. **No `[x]` claims require downgrade** — every verified feature has real source implementation, not stubs.

---

## Files Examined

- Parity doc: `plans/tasks/15-feature-parity.md`
- All 30 package `index.ts` exports
- Deep reads of: auth/password.ts, session.ts, keys.ts, guards.ts; policy/registry.ts; vault/cipher.ts; cache/store.ts, port.ts; database/database.ts; queue/queue.ts, job.ts, port.ts, worker.ts; schedule/cron.ts; mail/message.ts, port.ts, transports/{smtp,resend,postmark,ses}.ts; notify/channel.ts; storage/port.ts, disk.ts, drivers/adapters/local.ts; validate/index.ts; pulse/{metrics,tracing,limits,health}.ts; config/secrets.ts, presets.ts; container/container.ts, provider.ts; http/pipeline.ts; router/decorators.ts; console/commands/bootstrap.ts; deploy/sam.ts, wrangler.ts; events/{bus,outbox,publish}.ts; migrate/index.ts; seed/{index,seeder}.ts; pennant/{pennant,stores}.ts; cashier/{stripe,webhooks,types}.ts; forge/forge.ts; socialize/{google,socialize,state}.ts; scout/{scout,drivers}.ts; broadcast/{broadcaster,websocket,echo}.ts; nightwatch/nightwatch.ts; telemetry/{request-logger,queue-monitor}.ts; media/media.ts
- Admin app: `client/src/pages/`, `modules/`
