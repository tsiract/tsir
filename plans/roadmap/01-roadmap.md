# 01 — Roadmap & Sequencing

> Nine phases, each with a gate. A phase does not begin until the previous gate passes and is recorded in this file.

---

## 1. Sequencing principles

1. **Contracts before capabilities.** A module's public API is specified and type-tested before its internals are optimized.
2. **One vertical slice early.** Phase 2 delivers a _complete_ request path (route → bind → validate → handler → serialize → error) for one trivial controller. Everything after widens it.
3. **Nothing optional inside `@tsir/core`.** If a capability can be absent, it lives in its own package and is peer-gated.
4. **Runtime neutrality is not retrofittable.** The HTTP core is Web-standard from day one; otherwise Workers/Lambda support becomes a fork.
5. **Security features ship before public alpha.** Vault and auth/token handling complete before the first tagged release that a third party could run in production.

---

## 2. Phase map

```
Phase 0  Scaffolding            ──► docs, Makefile, dev server, frontpage       ✅ closed
Phase 1  Architectural core     ──► monorepo, container, config, errors, CLI      ✅ closed
Phase 2  HTTP vertical slice    ──► router, binders, validation, middleware       ✅ closed, one deviation (§ 3)
Phase 3  Database               ──► Drizzle, migrations, seeders, test harness    ✅ closed
Phase 4  Vault                  ──► envelope, keyring, codec, rotation            ✅ closed, no metrics exporter yet (§ 3)
Phase 5  Link                   ──► REST / gRPC / SOAP / WebSocket                ✅ closed in code; deploy half is `DPL-LNK`
Phase 6  Deploy                 ──► Workers, Lambda, topology, tsir.js automation  🟡 graph + emitters built; cloud half open
Phase 7  Capabilities           ──► auth, policy, cache, queue, events, schedule, mail, storage  ✅ closed, with caveats (§ 3)
Phase 8  Production readiness   ──► benchmarks, security review, docs, release automation  [CURRENT]
Phase 9  Laravel decoupling     ──► rename Laravel-inspired packages & terminology      [ ] planning-only, after P8]
Phase 10 Feature parity         ──► 1:1 feature mapping vs Laravel ecosystem + tasks   [ ] planning-only, after P9]
```

Phases 3 and 4 are ordered because Vault's column codec integrates with `@tsir/database`; Phases 5 and 6 are ordered because `@tsir/link` needs a stable unit model from `@tsir/deploy`'s design (though both may be specified in parallel).

The machine-readable copy of the current phase is the root `status.json`: `make readme` reads it
for the README badge, so this map and the badge cannot disagree.

### 2.1 Where Phase 8 actually is (re-derived 2026-11-08)

Phase 8 is the phase this repository is *in*, and it collects four independent work streams that do
not share a ledger. This is the authoritative map from stream to ledger to state:

| Stream                                | Ledger                                                                        | State                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Production readiness (bench, security, docs, release) | [`12-security.md`](../tasks/12-security.md), [`10-testing.md`](../tasks/10-testing.md), [`09-frontpage.md`](../tasks/09-frontpage.md), [`08-dx.md`](../tasks/08-dx.md) | Partial — `SEC-006`/`SEC-007`/`SEC-015`/`SEC-017`/`SEC-018` open; docs and release mostly landed |
| Capability completeness (Phase 7 leftovers) | [`07-capabilities.md`](../tasks/07-capabilities.md) + per-module files        | Closed except `TEL-*` and the Phase-7 modules' own open rows          |
| Feature parity (originally Phase 10)  | [`15-feature-parity.md`](../tasks/15-feature-parity.md)                       | Active — 177/255 verified, under construction rather than planning-only |
| **Infrastructure hardening**           | [`16-infrastructure-hardening.md`](../tasks/16-infrastructure-hardening.md)   | **Not started — gates Phase 8** (`P0` = `INF-001`–`INF-005`)          |

Two consequences worth stating plainly, because the phase map above does not show them:

1. **Phase 9 (Laravel decoupling) and Phase 10 (feature parity) are no longer strictly "after Phase 8".**
   Feature parity is being executed *inside* Phase 8 (its ledger has `[x]` rows dated 2026-11-07/08),
   while decoupling remains genuinely gated. The map keeps its ordering; this section records the
   deviation rather than pretending the ledger agrees with it.
2. **`INF-*` is the gate, not a side quest.** A "production readiness" phase that closes with a
   queue driver that drops messages, an auth bug on the escape-hatch database, and an AWS template
   that does not validate is not ready. That is why criterion 6 above exists.

---

## 3. Phase details

### Phase 0 — Scaffolding ✅

**Deliverables**

| Item                                                   | Path                                        | Status |
| ------------------------------------------------------ | ------------------------------------------- | ------ |
| Plan set                                               | `plans/**`                                  | ✅     |
| Makefile (`dev`, `kill`, `check`, …)                   | `Makefile`                                  | ✅     |
| Dev server with graceful shutdown + owned-port cleanup | `src/tools/dev.ts`, `src/tools/kill-dev.sh` | ✅     |
| Framework frontpage                                    | `src/apps/frontpage/public/index.html`      | ✅     |
| `tsir.js` spec, deploy spec, link spec                 | `operations/09-…`, `modules/08-…`, `07-…`   | ✅     |
| Base tsconfig / bunfig / package.json                  | root                                        | ✅     |

**Gate P0:** `make dev` serves the frontpage, `make kill` stops it cleanly, `make check` reports no workspace errors, and every plan document has a task index.

---

### Phase 1 — Architectural core

**Goal:** an application can boot, validate configuration, resolve dependencies, and shut down — with no HTTP yet.

**Scope:** `@tsir/core`, `@tsir/container`, `@tsir/config`, `@tsir/validate` (on top of Zod 4), `@tsir/console` (skeleton), `@tsir/testing` (unit harness), the `src/` → `dist/` build pipeline, repo tooling and CI.

**Exit criteria (Gate P1)**

1. `tsir dev` boots a sample app with a typed config object and a resolved provider graph.
2. Missing provider, circular provider, and invalid env all fail at boot with distinct error codes and a remediation hint.
3. `bun test` runs unit tests for container and config with ≥ 90 % line coverage on both packages.
4. `make typecheck` and `make lint` pass with zero suppressions.
5. `tsir.js` loader reads presets and produces a normalized, validated `ResolvedProjectConfig` (no deployment features yet).

---

### Phase 2 — HTTP vertical slice

**Goal:** a real API endpoint works end to end on Bun.

**Scope:** `@tsir/router` (decorators, metadata registry, compile step), `@tsir/http` (Bun adapter, middleware, guards, error mapping, request context), `@tsir/validate` (HTTP schemas), OpenAPI subset, `@tsir/testing` (HTTP integration harness).

**Exit criteria (Gate P2)**

1. Controller/route decorators compile into `routes.gen.ts`; production boot performs **zero** decorator reflection (verified by a test that deletes metadata before boot).
2. All six binders work with typed, validated values; invalid input returns RFC 9457-shaped 422 with `issues[]`.
3. Middleware and guards run in declared order; errors thrown anywhere map to the response contract.
4. OpenAPI 3.1 document is generated from the compiled registry and validated against the schema.
5. Integration tests cover success, 404, 405, 415, 422, 500, and request timeout.

**Status (2026-10-28):** criteria 1–3 and 5 are met and tested. Criterion 4 is met
for generation and schema validation; serving the document at `/__tsir/openapi.json`
in dev waits on `tsir openapi:generate` (Phase 6 CLI work). The one deviation worth
recording: criterion 1's "test that deletes metadata before boot" is satisfied
structurally instead — the HTTP example boots from `routes.gen.ts`, imports no
decorator metadata, and the workspace installs no `reflect-metadata`.

Every task in `tasks/03-http.md` is closed.

---

### Phase 3 — Database

**Goal:** D1 (default) and Postgres via Drizzle, with migrations and seeders that are safe to run in CI and production. **ADR-0016:** D1 ships first and is the default; the Postgres driver ships in the same phase so the escape hatch exists from day one.

**Scope:** `@tsir/database`, `@tsir/migrate`, `@tsir/seed`, `@tsir/testing` (DB harness).

> **Closed 2026-10-28.** All seven criteria met — see the review table in
> [`tasks/04-database.md`](../tasks/04-database.md). `DB-010` closes in Phase 4 with `VLT-008`
> and `MIG-012` in Phase 6 with `DPL-004`; both are recorded there as deferred by design.

**Exit criteria (Gate P3)**

1. `DB` provider boots against local Miniflare D1 **and** a real Postgres container; health check reports connectivity + latency for the selected driver.
2. `withTransaction` supports nesting through savepoints and propagates context; leaks are detected by test.
3. `tsir migrate`, `migrate:status`, `migrate:rollback` operate on Drizzle's journal with an advisory lock preventing concurrent runners.
4. Seeders are deterministic (fixed clock + seeded RNG) and idempotent where declared.
5. Integration test suite runs against ephemeral D1 (per-file isolated storage, real migrations) and against ephemeral Postgres with parallel-safe schema isolation.
6. **Named connections (ADR-0019):** `database.connections` with an explicit `default`; `db.connection('reporting')` returns a `Database`; an unknown name fails with `DB_UNKNOWN_CONNECTION`; capability requirements are checked per connection at boot; `migrate`, `migrate:status`, `migrate:rollback` and `db:seed` take `--connection`, and the journal, sidecar and lock key are per connection. `DB-018`'s `connection(fn)` is renamed `pinned(fn)`.
7. **MySQL/MariaDB is a Phase 3 _extension_, not a gate item (ADR-0020).** Gate P3 closes on
   D1 + Postgres; `DB-023` … `DB-026` and `MIG-016` land after it. A third engine must never
   be the reason the two promised engines are late, and the CI service it needs
   (`mariadb:11`) arrives with the suite that uses it, not before.

---

### Phase 4 — Vault

**Goal:** versioned column encryption with a resumable rotation state machine.

**Scope:** `@tsir/vault` (envelope, keyring, providers), `@tsir/database` codec adapter, rotation CLI.

**Exit criteria (Gate P4)**

1. Envelope round-trips through the DB codec; tampered ciphertext, wrong key id, and truncated envelope all fail closed with distinct errors.
2. Keyring state machine (`staged`/`active`/`decrypt-only`/`retired`) refuses invalid transitions; rolling-deploy simulation passes.
3. `tsir vault:rotate` re-encrypts in bounded batches, is resumable, emits progress metrics, and is idempotent per row.
4. Negative test matrix from [`06-vault.md § 8`](../modules/06-vault.md#8-test-matrix) passes.
5. Threat model updated; no plaintext or key material appears in logs (asserted by a log-capture test).

**Gate P4 status (2026-10-28):** criteria 1, 2, 4 and 5 pass. Criterion 3 passes for
batching, resumability and per-row idempotence; its **metrics** half is emitted
(`vault_rotation_rows_total`, `vault_rotation_errors_total`, `vault_rotation_remaining`
through an optional `RotationObserver`) but has no exporter — `@tsir/telemetry` is phase 8, so
the numbers currently go nowhere unless an application supplies a sink. The design review is
in [`reviews/2026-10-28-vault-design-review.md`](../reviews/2026-10-28-vault-design-review.md);
it is the author's review, not an independent audit, which is listed there as an open risk.

---

### Phase 5 — Link (service-to-service)

**Goal:** first-party, typed clients and servers for REST, gRPC, SOAP, and WebSocket.

**Scope:** `@tsir/link` with entrypoints `rest`, `grpc`, `soap`, `ws`; capability matrix by runtime.

**Exit criteria (Gate P5)**

1. Each protocol has a documented capability matrix per target (Bun / Workers / Lambda) and a conformance test against a real peer (local container or in-process server).
2. REST and WebSocket work on all three targets; gRPC works on Bun and Lambda (documented Worker limitation with Connect fallback path).
3. Timeouts, retries (idempotent-only), and cancellation are uniform across protocols via a shared `CallContext`.
4. WSDL→types tooling for SOAP produces compiled artifacts, not runtime reflection.

**Status (2026-10-28):** criteria 3 and 4 are met and tested. `conformance.test.ts` runs one
table of scenarios — dead context, idempotent retry, unsafe single attempt, unavailable —
against REST, gRPC and SOAP and asserts the shared `CallContext` semantics; `link:soap:gen`
compiles a WSDL into a committed module that contains no reflection and is gated by
`--check` (ADR-0024).

Criterion 1 is met in code (`capability.test.ts` fails when a ❌ is not a refusal or a ✅
entrypoint gains a `node:`/`bun:` import) with one deliberate gap: **the deploy half of the
matrix needs a real target**, so it closes with `DPL-LNK` in Phase 6, where `deploy:build`
produces the artifacts that criterion 2's "works on all three targets" claim can be booted
from. Until then `make verify-dist` bundles each target and proves the bundle graph, not
the boot.

`LNK-025` (Durable Object rooms) shipped here rather than after `DPL-010`: the room model is
written against the shape of the Durable Object API (ADR-0025), so it is testable without a
Workers runtime, and what remains for the deploy phase is the binding and the class export —
the part that was never `@tsir/link`'s to own.

---

### Phase 6 — Deploy (Workers & Lambda)

**Goal:** `tsir deploy:plan/build` produces separate deployable units by default, with `single` as opt-in.

**Scope:** `@tsir/deploy` (unit graph, adapters, artifact emitters, manifests), `tsir.js` deploy automation, `make deploy-*` targets.

**Exit criteria (Gate P6)**

1. Unit graph resolution is deterministic and snapshot-tested; `separate` and `single` topologies both produce runnable artifacts for a sample app.
2. Artifacts boot with correct bindings: D1/Hyperdrive (Workers) and RDS proxy semantics (Lambda), verified by smoke deploy in CI (scheduled, not per-PR).
3. Request-scoped state, cancellation, and timeouts behave identically across targets (shared conformance suite).
4. Secrets never land in artifacts; deploy manifests reference secret names only.
5. `tsir deploy:plan --explain` prints why each unit was created.

**Status (2026-10-28):** the graph and the emitter are built. `@tsir/deploy` resolves units
from declarations, applies the `separate`/`single` topology, validates them against each
target's capabilities and bindings, and commits `unit-graph.json` so a change in deploy shape
is a diff in review (ADR-0026). `tsir deploy:plan` / `deploy:diff` / `deploy:build` exist,
`deploy:invoke` runs a unit through the entry's own handler, and `make codegen-check` gates
the snapshot.

`deploy:build` emits one bundle per unit for Workers (`browser` target) and Lambda (`node`,
ESM), a per-unit `wrangler.*.toml` with secrets as comments only, and a single
`dist/bun/server.mjs` — plus `dist/build.json` with every artifact's bytes, gzipped bytes and
size budget. The tests import the emitted bundles and call them: the Worker answers
`GET /api/users`, the Lambda handler answers an API Gateway v2 event, the Bun server boots.

`deploy:validate` is the release gate: it reads `dist/build.json`, re-checks every artifact's
bytes and budget, scans all emitted files for secret shapes and for the project's declared
secret names (`DPL_SECRET_LEAK`), and re-validates the graph against the emitted targets.
`make check` runs build-then-validate for the HTTP example.

What this is **not** yet: a deployment. No artifact has been through `wrangler dev`,
`wrangler deploy --dry-run` or a real Lambda invoke, so `DPL-008`, `DPL-009`, `DPL-013` and
`DPL-014` stay `[~]` in `tasks/07-deploy.md`. SAM/CDK templates, the secret scanner and
`deploy:validate` are still open, and Gate P6's "both topologies deploy a sample app" is
unmet.

---

### Phase 7 — Capabilities

**Goal:** the optional application modules, each independently adoptable.

**Scope:** `@tsir/auth`, `@tsir/policy`, `@tsir/cache`, `@tsir/queue`, `@tsir/events`, `@tsir/schedule`, `@tsir/mail`, `@tsir/notify`, `@tsir/storage`, `@tsir/pulse`. Driver model, defaults and capability rules are specified in [`15-capabilities.md`](../modules/15-capabilities.md).

**Exit criteria (Gate P7)**

1. Auth and policy are separate packages with a documented seam; a policy can be enforced in a service (not just a controller) and tested without HTTP.
2. Queue has durable backends with retries, backoff, DLQ, idempotency keys, graceful worker drain. **D1 outbox + Cloudflare Queues is the default path** (ADR-0016 § 1.5); the outbox is mandatory there, not optional.
3. Events support transactional outbox; sync vs async listener semantics are explicit and tested.
4. Scheduler refuses to run without a distributed lock provider when more than one instance is detected.
5. Cache and storage are driver-based with explicit serialization; no implicit `JSON.parse` of unknown payloads.
6. **Named stores and connections (ADR-0019):** `cache.stores` and `queue.connections` are registries with an explicit `default`; `cache.store(name)` / `queue.connection(name)` are typed and throw `CAP_UNKNOWN_STORE` / `CAP_UNKNOWN_CONNECTION` on a name that was never declared; capabilities are validated **per store** at boot; `drivers.gen.ts` emits one import per driver however many stores use it; the deploy graph emits one queue trigger per connection.

---

**Status (2026-10-30): gate closed, with caveats.** All ten modules ship and are tested —
`auth` 88, `policy` 32, `queue` 126, `events` 40, `schedule` 59, `cache` 106, `storage` 71,
`mail` 106, `notify` 78, `pulse` 123, which is 829 tests in the workspace run. Each has a driver
model, a conformance kit where it has drivers, and CLI commands where it has state. The mechanism is
[ADR-0027](../decisions/0027-capability-drivers.md); the task ledger is
[`tasks/07-capabilities.md`](../tasks/07-capabilities.md) and its nine per-module files. The last open
ledger row, `CACHE-7` (the `redis` driver), was already built and tested, and is now closed.

The gate review is [`reviews/2026-10-29-capabilities-review.md`](../reviews/2026-10-29-capabilities-review.md).
It found two defects and fixed them: a `__Host-` session cookie that a browser silently drops
when `secure: false` (`AUTH_CONFIG_INVALID` now refuses the combination), and a public
`presignUrl` that would sign an `X-Amz-Expires` S3 rejects at use time. Criterion 4 is restated
rather than met literally — an instance count is not knowable, so the scheduler refuses a
non-shared lock in production instead.

**Criteria, checked against tests on 2026-10-30:**

1. **Met.** `auth` and `policy` are separate packages. `policy` decides without HTTP, and its
   `http.ts` is an adapter on top. `auth` depends only on the container.
2. **Met.** The queue has retries with backoff, idempotency keys, a dead-letter store, `stop()`
   drain, and `queue:retry` / replay / discard (`queue.test.ts`). A non-transactional driver
   without an outbox is refused at boot (`config.test.ts`), so the outbox is mandatory there.
   Cloudflare Queues is a driver (`drivers/cloudflare-queues.ts`).
3. **Met.** `events` has sync and queued listeners whose mode is declared, never inferred. A
   failing sync listener stops the dispatch, and an undeclared event is refused (`bus.test.ts`).
   The transactional outbox is covered by `outbox.test.ts`.
4. **Met, as restated.** `SCHED_LOCK_NOT_SHARED` refuses a per-process lock when a task needs
   non-overlap (`scheduler.test.ts`, `lock.test.ts`).
5. **Met.** `cache` owns serialization through explicit codecs and never parses an unknown
   payload. `storage` does not `JSON.parse` payloads. Its one `JSON.parse` is the local adapter's
   sidecar metadata, which is the adapter's own format.
6. **Met.** `cache.store(name)` throws `CAP_UNKNOWN_STORE` and `queue.connection(name)` throws
   `CAP_UNKNOWN_CONNECTION`, and both list what is declared (`stores.test.ts`, `errors.test.ts`).
   Capabilities are validated per store at boot, and `CAP-003` and `CAP-004` cover the single
   generated import and the one trigger per connection.

What is **not** true, and is why this gate is not a deployment claim:

- **no cross-target boot proof.** `make coverage` proves per-package lines; `make verify-dist`
  proves bundles. No capability module has been started on a real Worker or Lambda.
- **no brute-force protection** in `@tsir/auth` (`CAP-P7 F3`) — the primitive exists, the policy
  is the application's decision.
- **the reviewer is the author**, like every review in this repository so far.
- Gate P6's cloud half is still open and does not gate this phase: nothing here touches a
  deployment adapter until `CAP-004`.

**Gate P7 evidence (re-checked 2026-10-30).** The suites for `auth`, `policy`, `queue`, `events`, `schedule`, `cache` and `storage` pass: 522 tests, 0 failing, 5 skipped. The deploy, config, console, router, http and container suites pass too: 1010 tests, 0 failing.

| #   | Criterion                                                                                                                                                                           | Evidence                                                                                                                                                                                                             | Status                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | Auth and policy are separate packages; policy enforced in a service, tested without HTTP                                                                                            | `policy/src/registry.test.ts`: `authorizeService` is tested in its own block, with no request object. The HTTP adapter is tested separately.                                                                         | Met. The seam is documented in `policy.md` and the policy tests. No dedicated ADR records it. |
| 2   | Queue: durable backends, retries, backoff, DLQ, idempotency, drain; D1 outbox and Cloudflare Queues as default                                                                      | `queue/src/queue.test.ts` (retry, backoff, dead letter, idempotency), `config.test.ts` (outbox mandatory and refused at boot). `drivers/cloudflare-queues.ts` is documented as the production default on Workers.    | Met                                                                                           |
| 3   | Events: transactional outbox; sync vs queued semantics explicit and tested                                                                                                          | `events/src/bus.test.ts` (mode declared, sync throws stop dispatch, queued needs a queue), `publish.test.ts` (outbox record, relay, idempotency).                                                                    | Met                                                                                           |
| 4   | Scheduler refuses without a distributed lock when more than one instance exists                                                                                                     | Restated, as above. `scheduler.test.ts` ("a per-process lock is refused when a task relies on it") shows that production refuses a per-process lock when a task needs overlap prevention. Instances are not counted. | Met as restated                                                                               |
| 5   | Cache and storage are driver-based with explicit serialization; no implicit `JSON.parse`                                                                                            | `cache/src/stores.test.ts` (codec round-trip, a value from another codec is `CAP_CODEC_FAILED`), `storage` codec tests.                                                                                              | Met                                                                                           |
| 6   | Named stores and connections (ADR-0019): typed lookup, `CAP_UNKNOWN_STORE` / `CAP_UNKNOWN_CONNECTION`, per-store boot validation, one import per driver, one trigger per connection | `cache/src/stores.test.ts`, `queue/src/errors.test.ts`, `queue/src/config.test.ts`, `console/src/drivers.test.ts`, `console/src/commands/deploy-build.test.ts`, `config/src/config.fields.test.ts`.                  | Met                                                                                           |

Caveats that stay open: brute-force protection is not in `@tsir/auth` (CAP-P7 F3), and the Phase 8 external security review is separate.

### Phase 8 — Production readiness

**Goal:** evidence, docs, and release mechanics.

**Scope:** benchmarks, security review, docs site, compatibility policy, upgrade guide, release automation, `src/apps`, **and infrastructure hardening (`INF-*`)** — added 2026-11-08 by the infrastructure audit, because the audit's P0 findings are production-readiness findings, not a separate phase.

**Exit criteria (Gate P8)**

1. Benchmarks for router matching, validation throughput, encryption round-trip, and cold start on each target — published with hardware/version metadata.
2. External security review completed; findings triaged; `SECURITY.md` and disclosure policy published.
3. Docs site covers every public package and every error code.
4. Compatibility policy: SemVer for `1.0`, documented support window, deprecation process.
5. Release automation publishes **signed** artifacts and generates changelogs. _(Landed early in Phase 1: `.github/workflows/release.yml` + `make release-pack` already build both artifacts — `dist/` tree and per-package tarballs — with checksums, a tag/version guard, and a double-gated npm publish that emits provenance (ADR-0014). Gate P8 still owes artifact signing and generated changelogs.)_
6. **Every `P0` finding in [`../tasks/16-infrastructure-hardening.md`](../tasks/16-infrastructure-hardening.md) is closed** (`INF-001`–`INF-005`): the Postgres auth path works, `@tsir/database` bundles without `bun:sqlite`, the Cloudflare Queues consumer does not drop messages, and the SAM template is valid. A phase whose exit criteria are "production readiness" cannot be signed off while the default queue driver loses messages.
7. **The provider matrix in [`../architecture/17-infrastructure-philosophy.md`](../architecture/17-infrastructure-philosophy.md) § 16 matches reality**: no row says `[VERIFIED]` unless a test proves it, and every `[PARTIAL]` row names its `INF-*` task.

**Phase 8 state (2026-11-08).** Criteria 1, 2, 3, 4 and 6 are the open ones; 5 is partly landed; 7 is now mechanically checkable because the status register exists. The audit added `INF-001`…`INF-020`; the `P0` set is the gate blocker.

---

### Phase 9 — Laravel ecosystem decoupling & `@tsir/*` rebranding

**Goal:** establish an independent TypeScript ecosystem under the `@tsir/*` namespace, with no Laravel-derived naming, terminology, or branding. A deliberate ecosystem-wide rebranding that renames Laravel-inspired packages and replaces Laravel-specific terminology in APIs, comments, docs, and UI copy, with no behavior change.

**Scope:** `@tsir/nightwatch`, `@tsir/pennant`, `@tsir/cashier`, `@tsir/forge`, `@tsir/socialize`, `@tsir/scout`, `@tsir/pulse` are renamed to functionally accurate names; `@tsir/broadcast`'s `Echo`-named symbols are renamed; `@tsir/telemetry` keeps its name (generic) but drops "Telescope-style"/"Horizon-style" wording. Generic industry terms (`auth`, `cache`, `queue`, …) are **not** touched.

**Exit criteria (Gate P9)**

1. No Laravel-specific branding or terminology remains in source, docs (except explicitly historical notes), config, or UI.
2. All Laravel-inspired `@tsir/*` package names replaced with approved independent names; imports/exports/dependencies consistent.
3. Public API and internal naming consistent; docs, examples, comments, and config references updated.
4. Existing functionality preserved — full `make check` passes.
5. Final repository-wide search for Laravel terms conducted; remaining references individually reviewed.

Full task ledger: [`plans/tasks/14-laravel-decoupling.md`](../tasks/14-laravel-decoupling.md). This phase is **planning-only** until Phase 8 closes.

---

### Phase 10 — `@tsir/*` feature parity

**Goal:** establish 1:1 functional feature coverage between `@tsir/*` packages and their Laravel ecosystem counterparts, using authoritative Laravel documentation and verifiable implementation evidence. Parity is about user-facing behavior, not internal architecture.

**Scope:** every `@tsir/*` package with a Laravel counterpart (foundational services + first-party packages). `@tsir/link` and `@tsir/media` are out of scope (no direct Laravel first-party analog).

**Exit criteria (Gate P10)**

1. Every relevant `@tsir/*` package has a feature-by-feature mapping with a status and (for verified features) source + test + doc evidence.
2. All missing/partial features translated into `PARITY-*` tasks with acceptance criteria.
3. No feature marked verified without traceable evidence (source file, test case, official Laravel doc URL).
4. Aggregate verified parity ≥ 80% (excluding deliberately-different rows).
5. This document is the single source of truth for parity.

Full task ledger: [`plans/tasks/15-feature-parity.md`](../tasks/15-feature-parity.md). This phase is **planning-only** until Phase 9 closes.

---

## 4. Cross-cutting constraints (apply to every phase)

| Constraint         | Rule                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime neutrality | No `node:` import in `@tsir/core`, `@tsir/router`, `@tsir/http`, `@tsir/vault` outside of explicit adapter files. Enforced by lint rule `no-restricted-imports` per package. |
| Determinism        | Anything that reads time or randomness accepts an injected clock/RNG.                                                                                                        |
| Bundle size        | Adapters report bundle size; a regression > 10 % fails CI (Phase 6+).                                                                                                        |
| Error stability    | Error codes are append-only; renaming requires a deprecation cycle.                                                                                                          |
| Docs-in-PR         | A public API change without a docs diff fails review.                                                                                                                        |

---

## 5. Milestones and tags

| Tag              | Meaning                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `v0.1.0-alpha.1` | After Gate P2 — HTTP works on Bun; explicitly not production-ready |
| `v0.2.0-alpha.1` | After Gate P4 — DB + encryption; internal evaluation only          |
| `v0.3.0-beta.1`  | After Gate P6 — edge/serverless targets usable                     |
| `v0.4.0-beta.2`  | After Gate P7 — capability modules                                 |
| `v1.0.0`         | After Gate P8 — compatibility promise begins                       |

---

## 6. Definition of Done

A module is **not** done because the happy path works. It is done when all of the following are true and linked in its task file:

1. Public API contract documented (types + example + failure modes).
2. Strict type-check clean; no `any`, no non-null assertions in non-test code.
3. Runtime validation at every trust boundary it owns.
4. Unit tests, plus integration tests for anything with I/O.
5. Failure modes table complete with error codes.
6. Security considerations paragraph reviewed by `SEC`.
7. Lifecycle: acquisition/disposal, shutdown timeout, cancellation semantics.
8. Compatibility: what may change in a minor vs major.
9. Dependency budget: no new runtime dependency without an ADR.
10. No `TODO` without a task ID.

---

## 7. Task index

| Phase | Task files                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | [`tasks/01-foundation.md`](../tasks/01-foundation.md)                                                                                  |
| 1     | `01-foundation.md`, `02-core.md`                                                                                                       |
| 2     | `03-http.md`                                                                                                                           |
| 3     | `04-database.md`                                                                                                                       |
| 4     | `05-vault.md`                                                                                                                          |
| 5     | `06-link.md`                                                                                                                           |
| 6     | `07-deploy.md`, `09-frontpage.md`                                                                                                      |
| 7     | `07-capabilities.md`, `queue.md`, `events.md`, `schedule.md`, `storage.md`, `mail.md`, `notify.md`, `policy.md`, `auth.md`, `pulse.md` |
| 8     | `08-dx.md`, `11-observability.md`, `12-security.md`                                                                                    |
| 9     | [`14-laravel-decoupling.md`](../tasks/14-laravel-decoupling.md)                                                                        |
| 10    | [`15-feature-parity.md`](../tasks/15-feature-parity.md)                                                                                |
