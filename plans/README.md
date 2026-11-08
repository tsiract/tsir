# Tsir — Engineering Plans

This directory is the **source of truth for design, sequencing, and acceptance criteria** of the Tsir framework. Framework code must not be merged ahead of the plan that describes it; instead, when implementation teaches us something the plan got wrong, the plan is amended in the same pull request.

The product requirements live in the project brief. This directory turns that brief into decisions, specifications, and trackable tasks.

---

## 1. What is in here

| Directory       | Holds                                                                             |
| --------------- | --------------------------------------------------------------------------------- |
| `roadmap/`      | the thesis, the glossary, the risk register and the phase plan with its gates     |
| `architecture/` | package boundaries, the dependency DAG, module rules and tooling decisions        |
| `modules/`      | one document per feature area: public surface, failure modes, security, tasks     |
| `operations/`   | config, developer experience, testing, observability and security practice        |
| `tasks/`        | the task ledger — one file per area, `PREFIX-NNN` ids, committed acceptance tests |
| `decisions/`    | ADRs, `0001`–`0031`, each with status, context, decision and consequences         |
| `reviews/`      | gate reviews: what was checked, what was waived, who signed off                   |

Nothing outside this directory links into it, and no code imports from it — the ids
(`HTP-013`, `ADR-0027`) are the only thing that crosses the boundary, which is why they
appear in source comments and error hints.

Ideas for **new features, breaking changes or tooling that improves the project** go to the
[`rfc/`](../rfc/README.md) directory at the repository root, not here. Bugs go to the issue
tracker: an RFC is a proposal, never a bug report.

---

## 2. How to use this directory

| If you want to…                                      | Read                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Understand what Tsir is and is not                   | [`00-foundation.md`](./roadmap/00-foundation.md)                                    |
| Know what is built next, and in what order           | [`01-roadmap.md`](./roadmap/01-roadmap.md)                                          |
| Understand package boundaries and tooling            | [`02-monorepo.md`](./architecture/02-monorepo.md)                                   |
| Work on the application lifecycle, DI, or config     | [`03-core.md`](./modules/03-core.md)                                                |
| Work on HTTP, routing, validation, OpenAPI           | [`04-http.md`](./modules/04-http.md)                                                |
| Work on Drizzle, migrations, seeders                 | [`05-database.md`](./modules/05-database.md)                                        |
| Work on encryption and key rotation                  | [`06-vault.md`](./modules/06-vault.md)                                              |
| Work on REST / gRPC / SOAP / WebSocket service calls | [`07-link.md`](./modules/07-link.md)                                                |
| Work on Cloudflare Workers and AWS Lambda            | [`08-deploy.md`](./modules/08-deploy.md)                                            |
| Work on `tsir.js`, presets, and bootstrap automation | [`09-tsir-config.md`](./operations/09-tsir-config.md)                               |
| Work on the framework welcome page                   | [`10-frontpage.md`](./modules/10-frontpage.md)                                      |
| Work on the Makefile, CLI, or generators             | [`11-dx.md`](./operations/11-dx.md)                                                 |
| Write tests                                          | [`12-testing.md`](./operations/12-testing.md)                                       |
| Work on logs, metrics, tracing, health               | [`13-observability.md`](./operations/13-observability.md)                           |
| Review security implications                         | [`14-security.md`](./operations/14-security.md)                                     |
| Work on cache, queue, mail, notifications, drivers   | [`15-capabilities.md`](./modules/15-capabilities.md)                                |
| Work on modules, boundaries, or developer experience | [`16-modularity.md`](./architecture/16-modularity.md)                               |
| Choose a substrate, a cloud, or a deployment profile | [`17-infrastructure-philosophy.md`](./architecture/17-infrastructure-philosophy.md) |
| Work on the admin app (`admin.product.com`)          | [`16-admin-frontend.md`](./modules/16-admin-frontend.md)                            |
| Decide what belongs in the core repo vs. `dist/`     | [`18-core-vs-distribution.md`](./architecture/18-core-vs-distribution.md)           |

Task tracking: [`tasks/`](./tasks/README.md). Architectural decisions: [`decisions/`](./decisions/README.md).
Gate reviews (what was checked, what was waived): [`reviews/`](./reviews/README.md).

Three documents carry the infrastructure position, and they are meant to be read in this order:

1. [`reviews/2026-11-07-infrastructure-agnosticism-audit.md`](./reviews/2026-11-07-infrastructure-agnosticism-audit.md)
   — what the code actually does, package by package, with the `INF-001`…`INF-018` findings.
2. [`architecture/17-infrastructure-philosophy.md`](./architecture/17-infrastructure-philosophy.md)
   — what the framework intends to support: Cloudflare-first, AWS-compatible, hybrid by design,
   five deployment profiles over seven runtime seams.
3. [`decisions/0030-hybrid-cloud-and-workload-substrates.md`](./decisions/0030-hybrid-cloud-and-workload-substrates.md)
   — the decision that ratifies 2, with
   [`tasks/16-infrastructure-hardening.md`](./tasks/16-infrastructure-hardening.md) as the ledger
   that makes it true.

Infrastructure prose in this directory carries one of six status labels — `[VERIFIED]`,
`[PARTIAL]`, `[PLANNED]`, `[PROPOSED]`, `[LIMITATION]`, `[PROVIDER-SPECIFIC]` — defined in
[`17-infrastructure-philosophy.md § 16`](./architecture/17-infrastructure-philosophy.md#16-capability-status-register).
A declared provider that does not work is `[PARTIAL]`, never "supported".

---

## 3. Conventions

### Requirement language

- **MUST** — required for the module to be considered complete.
- **SHOULD** — required unless a documented reason (ADR or code comment linking to a task) says otherwise.
- **MAY** — optional, safe to defer.

This follows RFC 2119 semantics. "Complete" is defined in [`01-roadmap.md § 6`](./roadmap/01-roadmap.md#6-definition-of-done).

### Question identifiers

`Qnn`, numbered **globally** across the whole plan set, not per document. `Q12` means one
question in this repository.

- **Define once.** A question gets a table row in exactly one document — usually the one that
  owns the decision, or `00-foundation.md § 6` for a cross-cutting one.
- **Reference by id.** Another document that needs the same question writes `` `Q12` `` in a
  row (backticks, not a bare `Q12`), which marks it as a pointer rather than a second answer.
- **Answer in place.** Strike the question through and say what answered it and when —
  `~~the question~~ **Answered: …** ([ADR-0027](./decisions/0027-capability-drivers.md))` —
  rather than deleting the row. The id keeps meaning the same thing forever, and an id is
  never reused for a new question.

`make plans` fails the build when an id is defined twice. The next free id is the highest one
in the set plus one — check before adding.

### Task identifiers

`PREFIX-NNN`, where prefix identifies the owning module:

| Prefix | Module                      | Prefix | Module                                                             |
| ------ | --------------------------- | ------ | ------------------------------------------------------------------ |
| `FND`  | Foundation / repo / tooling | `MIG`  | Migrations                                                         |
| `CTN`  | Container (DI)              | `SED`  | Seeders                                                            |
| `CFG`  | Configuration & `tsir.js`   | `VLT`  | Vault (encryption)                                                 |
| `APP`  | Core application lifecycle  | `LNK`  | Link (REST/gRPC/SOAP/WS)                                           |
| `ERR`  | Error model                 | `DPL`  | Deploy (Workers/Lambda)                                            |
| `RTR`  | Router & decorators         | `CAP`  | Capabilities (auth, cache, queue, events, schedule, mail, storage) |
| `HTP`  | HTTP lifecycle              | `OBS`  | Observability                                                      |
| `VLD`  | Validation                  | `TST`  | Testing                                                            |
| `DB`   | Database / Drizzle          | `SEC`  | Security                                                           |
| `CLI`  | Console & generators        | `DOC`  | Docs & frontpage                                                   |

Status markers used in task files:

```
[ ] todo   [~] in progress   [x] done   [!] blocked   [–] deliberately deferred
```

### Plan documents

Every numbered plan document in `modules/`, `operations/` and `architecture/` ends with these
four sections, in this order — and `make plans` fails the build when one is missing:

1. **Failure modes** — what breaks, how it is reported, and what the caller can do.
2. **Security considerations** — the trust boundaries this area introduces, and what it does
   _not_ defend against.
3. **Open questions** — anything not yet decided, numbered so a task can cite it.
4. **Task index** — links into `tasks/`.

A plan without an explicit failure-mode section is considered incomplete. The same rule is why
every package under `src/framework/` carries a `README.md` with the same shape: **public
surface and lifecycle live there**, next to the code they describe, not in this directory.

The `roadmap/`, `tasks/`, `decisions/` and `reviews/` folders follow their own conventions — an
ADR is Context / Decision / Consequences, a task is a table with acceptance criteria, and
neither is a plan document.

---

## 4. Current state

**Milestone:** Phase 7 — capabilities (cache, queue, events, schedule, storage, mail, notify,
policy, auth, pulse), gate reviewed 2026-10-29.

The machine-readable copy of this line is the root [`status.json`](../status.json): `make readme`
reads the phase from there, so the README badge and this section cannot disagree.
**Framework version:** `0.0.0` (pre-alpha; no public API stability guarantees yet)

What exists today:

| Artifact                                                                                      | Status                                                                  |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| This documentation set                                                                        | ✅ complete for Phases 0–7, Phase 8 in progress                         |
| Root `Makefile` (`dev`, `kill`, `check`, `dist`, `verify-dist`, …)                            | ✅ verified                                                             |
| Development server (`src/tools/dev.ts`) + graceful shutdown                                   | ✅ verified                                                             |
| Framework frontpage (`src/apps/frontpage/public/index.html`)                                  | ✅ served, dark + light                                                 |
| Boundary enforcement — packages (`check-boundaries`) + app modules (`check-modules`)          | ✅ both enforced in `make check` and CI                                 |
| `@tsir/container` — DI, scopes, diagnostics, disposal                                         | ✅ implemented, tested (22 tests, 94.6 % lines)                         |
| `@tsir/config` — typed env, redaction, all-issues reporting                                   | ✅ implemented, tested (55 tests, 99.6 % lines)                         |
| `@tsir/core` — lifecycle, modules, manifest, capabilities, typed `defineApp`                  | ✅ implemented, tested (38 tests, 96.5 % lines)                         |
| `@tsir/validate` — Zod 4 foundation, Standard Schema interop, issue normalization             | ✅ implemented, tested (17 tests, 100 % lines)                          |
| `@tsir/router` — decorators, route table, trie matcher, module-owned registries               | ✅ implemented, tested (39 tests)                                       |
| `@tsir/http` — pipeline, binders, guards/policies, RFC 9457 problems, Bun adapter             | ✅ implemented, tested (99 tests, 94.7 % lines)                         |
| `@tsir/http/openapi` — OpenAPI 3.1 documents generated from the route table                   | ✅ implemented, meta-schema validated                                   |
| `@tsir/testing` — harness, `only` filter, per-module tables, `createTestDatabase` (subpath)   | ✅ implemented, tested (20 tests)                                       |
| `@tsir/database` — D1 + Postgres, Drizzle, logging, tx, codec, pinned connections             | ✅ implemented, tested (99 tests, 94.3 % lines)                         |
| `@tsir/database/postgres` — Postgres driver, pool rules, Hyperdrive (ADR-0009)                | ✅ implemented, tested (7 integration tests)                            |
| `@tsir/migrate` — journal, advisory lock, drift, rollback, verify, pre-flight guidance        | ✅ implemented, tested (51 unit + 7 integ.)                             |
| `@tsir/seed` — seeder contract, ordering, env gating, idempotency harness, fixtures           | ✅ implemented, tested (33 unit + 3 integ.)                             |
| `@tsir/console` — `dev`, `build`, `doctor`, `config:dump`, `new`, `make:module`, `migrate*`   | ✅ implemented, `db:seed`, `storage:*`, `mail:*`, `notify:*`            |
| `src/apps/minimal` — the smallest complete application                                        | ✅ boots and shuts down cleanly                                         |
| `src/apps/http` — two modules (`users`, `media`), guards, fetch handler                       | ✅ 16 tests, module tables + `unit: media`                              |
| `tsir route:list` (aligned table + versioned `--json`)                                        | ✅ verified against the HTTP example                                    |
| `tsir route:compile` — deterministic `routes.gen.ts`, `--check` drift gate                    | ✅ generated table boots the HTTP example                               |
| Guards + `principal` binding, 401 challenge, CORS preflight, response contracts               | ✅ `contracts.test.ts` (13 cases)                                       |
| Multipart uploads with sniffed MIME + route limits (VLD-006)                                  | ✅ 11 unit + 2 end-to-end cases                                         |
| Unknown-key policy `strip`/`strict`/`passthrough`, published in OpenAPI (VLD-005)             | ✅ 5 validate + 3 OpenAPI cases                                         |
| Protocol conformance suite (HTP-021), deploy-unit attribution (RTR-011)                       | ✅ 17 + unit-resolution cases                                           |
| Response helpers `ok`/`created`/`accepted`/`noContent` (VLD-009)                              | ✅ enforced by HTP-013 tests                                            |
| Authorization audit trail, opt-in per policy (HTP-011)                                        | ✅ 4 policy tests                                                       |
| `make coercion` gate + negative matrix (VLD-007, VLD-010)                                     | ✅ 23 tool + 37 validate cases                                          |
| `dist/` distributable — per-file ESM, export maps, LICENSE per package (ADR-0011)             | ✅ generated by `make dist`, gitignored                                 |
| Distribution verification — boots from `dist/` only, DCE + Workers/Lambda probes              | ✅ `make verify-dist`                                                   |
| Dependency policy — allowlisted, ESM, `sideEffects` declared (ADR-0012)                       | ✅ `make deps`                                                          |
| CI (`typecheck · lint · boundaries · license · deps · format · test · frontpage`)             | ✅ workflow committed                                                   |
| Type-level tests (token variance, inject arity, config inference, validator output)           | ✅ compiled in CI                                                       |
| Coverage gate per package (`src/tools/coverage-gate.ts`, `make coverage`)                     | ✅ enforced                                                             |
| Documentation link + anchor check (`src/tools/check-links.ts`, `make links`)                  | ✅ 84 files, CI-enforced                                                |
| Public API snapshot (`src/docs/api-surface.json`, `make surface`)                             | ✅ refreshed by `make surface`, gate in `make check`                    |
| Gate reviews — vault (P4) and capabilities (P7)                                               | ✅ [`reviews/`](./reviews/README.md); both author-reviewed, not audited |
| This directory stays internal (`src/tools/check-plan-refs.ts`, `make plan-refs`)              | ✅ no path into it survives outside `plans/` (DOC-016)                  |
| Lockstep versioning + changesets (`src/tools/version.ts`)                                     | ✅ `make changeset` / `make release-version`                            |
| Benchmarks with committed baseline (`src/tools/bench.ts`, `make bench`)                       | ✅ 5 micro-benchmarks, no baseline drift                                |
| Package scaffolder (`src/tools/new-package.ts`)                                               | ✅ manifest, barrel, test, task stub                                    |
| Runtime floor enforcement (`@tsir/console` boot guard, `engines`)                             | ✅ bun ≥ 1.2, node ≥ 21                                                 |
| Postgres integration job (CI service container)                                               | ✅ 3 suites / 17 tests green (PG 17.6)                                  |
| OpenAPI served at `/__tsir/openapi.json` in dev                                               | ⛔ the only Phase 2 item left (`tasks/03-http.md`)                      |
| Migrate unit in the deploy graph (MIG-012)                                                    | ✅ Phase 6 — `migrate:<connection>` script                              |
| Managed regions + `tsir bootstrap --plan/--yes` (`CFG-104`, `CFG-107`, `CFG-115`)             | ✅ deploy block, fenced and idempotent                                  |
| Vault-backed column encryption (DB-010)                                                       | ✅ closed by `VLT-008` (2026-10-28)                                     |
| Vault (`@tsir/vault`)                                                                         | ✅ Phase 4 — envelope, keyring, codec, rotation                         |
| Link (`@tsir/link`)                                                                           | ✅ Phase 5 — REST, gRPC, SOAP, WS, rooms                                |
| Cache (`@tsir/cache`) — port, codecs, 5 drivers, `cache:*`, conformance kit                   | ✅ Phase 7 — 95.95 % lines, gate passed                                 |
| Queue (`@tsir/queue`) — port, worker, 5 drivers, outbox, `queue:*`, triggers, conformance kit | ✅ Phase 7 — 97.47 % lines; `@tsir/events` next (`QUEUE-18`)            |
| Events (`@tsir/events`) — typed events, sync/queued listeners, outbox writer                  | ✅ Phase 7 — `DPL_EVENTS_OUTBOX_MISSING`                                |
| Schedule (`@tsir/schedule`) — cron, task registry, tick, lock port, `schedule:*`, triggers    | ✅ Phase 7 — 2 lock drivers, `DPL_CRON_NOT_UTC`                         |
| Storage (`@tsir/storage`) — disk registry, 3 drivers, `storage:*`, SigV4, conformance kit     | ✅ Phase 7 — 97.03 % lines, R2 by endpoint, no SDK                      |
| Mail (`@tsir/mail`) — mailers, 7 transports, templates, `mail:*`, conformance kit             | ✅ Phase 7 — 93.77 % lines, no SDK, address injection locked            |
| Notify (`@tsir/notify`) — 6 channels, queue-by-default, `notify:*`, conformance kit           | ✅ Phase 7 — 96.02 % lines, signed webhooks, allowlisted hosts          |
| Policy (`@tsir/policy`) — roles, permissions, gates, `authorize`/`require`, `toHttpPolicies`  | ✅ Phase 7 — 92.96 % lines, fixed order, no `after` hook                |
| Auth (`@tsir/auth`) — PBKDF2 + argon2id, sessions, API keys, guards, two stores               | ✅ Phase 7 — 95.85 % lines, `__Host-` cookies, hashes at rest           |
| Pulse (`@tsir/pulse`) — logger, 3-layer redaction, metrics, tracing, health                   | ✅ Phase 7 — 97.27 % lines, 4 formats, fail-open sinks                  |
| Deploy unit graph (`@tsir/deploy`) — units, graph, queue triggers, emitters                   | 🟡 Phase 6 — graph, plan/diff, invoke, emitter, `[[queues.consumers]]`  |
| Workers/Lambda emitters, capability boot proof                                                | 🟡 Phase 6 — emit, validate, answer; no deploy                          |

### What "runs on Workers and Lambda" means today

Phase 1 has measured _bundling_ evidence, not deployment evidence:

- the packages bundle for `target: 'browser'` (the Workers constraint) and `target: 'node'`
  (Lambda) with no `node:` or `bun:` imports surviving;
- a Workers-shaped handler and a Lambda-shaped handler stay inside recorded byte budgets;
- importing a single symbol from a package costs ~0.1 KiB instead of the whole package.

Since `deploy:build` (2026-10-28) there _is_ an adapter, and the emitted artifacts are imported
by the test suite and asked real requests: a Workers bundle answers `GET /api/users`, a Lambda
bundle answers an API Gateway v2 event, and the Bun server boots. What is **not** true yet: no
Worker or Lambda has been deployed, no `wrangler dev` / `--dry-run` run is recorded, and no
cold-start or throughput number has been measured. Emitting a bundle is not a deployment
guarantee; the deploy layer is Phase 6 (`08-deploy.md`).

What must not be implied anywhere in docs or marketing: an HTTP surface, published packages,
benchmarks, a docs site, or any runtime guarantee on Cloudflare Workers and AWS Lambda.

## 5. Decisions in force

Short form; each links to its ADR.

| #   | Decision                                                                                                                                                                                                | ADR                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | **Standard ECMAScript decorators**, no `experimentalDecorators`. Parameter decorators do not exist in that model, so request binding is expressed as route metadata, not `@Param` parameter decorators. | [0001](./decisions/0001-decorator-model.md)          |
| 2   | HTTP core is built on Web `Request`/`Response`; runtimes are adapters (Bun, Cloudflare Workers, AWS Lambda).                                                                                            | [0002](./decisions/0002-web-standard-http.md)        |
| 3   | Validation defaults to Zod 4 behind a Standard Schema adapter; the framework accepts any Standard Schema validator.                                                                                     | [0003](./decisions/0003-validation-library.md)       |
| 4   | One service-to-service package `@tsir/link` with `rest`, `grpc`, `soap`, `ws` entrypoints — not four packages.                                                                                          | [0004](./decisions/0004-link-package-shape.md)       |
| 5   | Deploy topology defaults to **separate units** (one worker/lambda per concern), `single` is opt-in.                                                                                                     | [0005](./decisions/0005-deploy-topology-default.md)  |
| 6   | `tsir.js` is the canonical config filename; it is a generated-and-owned file with managed regions and presets.                                                                                          | [0006](./decisions/0006-tsir-js-config.md)           |
| 7   | Drizzle's migration journal stays authoritative; Tsir adds locking, status, and safety gates rather than a parallel journal.                                                                            | [0007](./decisions/0007-migrations-over-drizzle.md)  |
| 8   | Vault keys are identified by **key id** carried in the ciphertext envelope; `APP_KEY_NOW`/`APP_KEY_NEXT` carry material, while a keyring manifest carries state.                                        | [0008](./decisions/0008-vault-key-state.md)          |
| 9   | A runtime dependency may be **scoped to a subpath entrypoint** (`@tsir/link/grpc`), proven by the package's import graph and a bundle proof — so REST users never carry a gRPC runtime.                 | [0022](./decisions/0022-subpath-dependency-scope.md) |

---

## 6. Non-negotiables

These are restated in every relevant plan and must survive every refactor:

1. **No global service locator.** Dependencies arrive through constructors from an explicit container built at bootstrap.
2. **No `any`.** External data is `unknown` until a schema proves otherwise.
3. **No reflection on the hot path.** Routes are compiled at build time into an immutable registry.
4. **No custom crypto.** AES-256-GCM (or ChaCha20-Poly1305) from the runtime, versioned envelopes, fail closed.
5. **No silent fallbacks.** Missing providers, missing keys, ambiguous routes, and invalid config fail at boot with actionable errors.
6. **No unverified claims.** Performance or security comparisons require a committed benchmark or test.

---

## 7. Contributing to the plans

1. Pick a task in `tasks/` that is `[ ]` and not blocked.
2. If the task contradicts a plan, **amend the plan first** (same PR).
3. If the task requires a new architectural decision, add an ADR with status `Proposed`; the maintainer flips it to `Accepted` or `Rejected`.
4. Keep task acceptance criteria testable. "Works well" is not acceptance criteria; "returns 422 with `issues[]` for three malformed bodies" is.

---

## 8. Authority map — which document owns which statement

`plans/` has ~94 documents and several of them touch the same subject. When two disagree, this table
decides which one is wrong. It was added on 2026-11-08 because the queue, real-time, database-dialect
and deploy stories were each described in three places with different statuses.

| Subject                                         | **Authoritative document**                                                                                                          | Others may only…                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| What the code actually does, package by package | [`reviews/2026-11-07-infrastructure-agnosticism-audit.md`](./reviews/2026-11-07-infrastructure-agnosticism-audit.md)                | cite it; never restate a finding with a different severity                   |
| Capability status labels (`[VERIFIED]` … )      | [`architecture/17-infrastructure-philosophy.md § 16`](./architecture/17-infrastructure-philosophy.md#16-capability-status-register) | reference the label, not a paraphrase                                        |
| Substrate choice, profiles, cost, lock-in       | [`architecture/17-infrastructure-philosophy.md`](./architecture/17-infrastructure-philosophy.md)                                    | link to a section                                                            |
| Package boundaries and the dependency DAG       | [`architecture/02-monorepo.md`](./architecture/02-monorepo.md)                                                                      | link                                                                         |
| Module boundaries and extraction                | [`architecture/16-modularity.md`](./architecture/16-modularity.md)                                                                  | link                                                                         |
| HTTP pipeline, binders, OpenAPI                 | [`modules/04-http.md`](./modules/04-http.md)                                                                                        | link; the task ledger owns status only                                       |
| Database engines, connections, transactions     | [`modules/05-database.md`](./modules/05-database.md)                                                                                | link                                                                         |
| Vault envelope and rotation                     | [`modules/06-vault.md`](./modules/06-vault.md)                                                                                      | link                                                                         |
| Service-to-service protocols and rooms          | [`modules/07-link.md`](./modules/07-link.md) (rooms: [ADR-0025](./decisions/0025-rooms-are-durable-object-shaped.md))               | link                                                                         |
| Deploy units, emitters, artifacts               | [`modules/08-deploy.md`](./modules/08-deploy.md) (graph shape: [ADR-0026](./decisions/0026-deploy-graph-is-an-artefact.md))         | link                                                                         |
| Capability mechanism, drivers, conformance kits | [`modules/15-capabilities.md`](./modules/15-capabilities.md)                                                                        | link                                                                         |
| Admin app (`admin.product.com`)                 | [`modules/16-admin-frontend.md`](./modules/16-admin-frontend.md)                                                                    | link                                                                         |
| `tsir.js` shape, presets, bootstrap             | [`operations/09-tsir-config.md`](./operations/09-tsir-config.md)                                                                    | link                                                                         |
| Logging, metrics, tracing, health               | [`operations/13-observability.md`](./operations/13-observability.md)                                                                | link                                                                         |
| Testing strategy and harness                    | [`operations/12-testing.md`](./operations/12-testing.md)                                                                            | link                                                                         |
| Security practice and review requirements       | [`operations/14-security.md`](./operations/14-security.md)                                                                          | link                                                                         |
| Phase sequence and gates                        | [`roadmap/01-roadmap.md`](./roadmap/01-roadmap.md)                                                                                  | link; § 2.1 records stream state                                             |
| Glossary, requirements, exclusions              | [`roadmap/00-foundation.md`](./roadmap/00-foundation.md)                                                                            | link                                                                         |
| Task status and acceptance criteria             | the `tasks/` file that owns the prefix                                                                                              | never restate a status in a module doc — link to the row                     |
| Execution order across ledgers                  | [`tasks/README.md § 5`](./tasks/README.md#5-execution-order-dependency-driven-re-derived-2026-11-08)                                | link                                                                         |
| Architecture decisions                          | `decisions/NNNN-*.md` — one file, one decision, immutable once accepted                                                             | a later ADR supersedes; never edit an accepted one into a different decision |

Three rules that follow from it:

1. **A module document may not be the only place a status is stated.** Status lives in `tasks/`; the
   module document explains the _mechanism_ and links to the row. This was violated in at least four
   places before 2026-11-08 (`08-deploy.md` § 3.1, `15-capabilities.md § 4.2`, `05-database.md § 2.9`,
   `04-http.md § 9.1`) and each is now corrected with a dated note.
2. **A dated note beats a silent edit.** When a document's earlier claim was wrong, the correction is
   visible — "corrected 2026-11-08" — because a reader who trusted the old text needs to know it
   changed. Three such notes exist now, and that is deliberate.
3. **Historical material is kept only when it explains a decision.** `tasks/_capabilities.md` is kept
   as the record of the Phase 7 module map and marked superseded; `06-link.md`'s WSDL and SOAP
   sections are kept because ADR-0023/0024 rest on them. Nothing else is retained "for history".

### 8.1 Documents reviewed and left unchanged, and why

Every document in `plans/` was read for this pass. These were reviewed and deliberately **not**
edited, so a future reader does not re-do the work:

| Document                                                                                                                                                                        | Verdict                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `roadmap/00-foundation.md`                                                                                                                                                      | Accurate; the glossary and exclusion list still match the tree                             |
| `architecture/02-monorepo.md`                                                                                                                                                   | Accurate; the DAG matches `make boundaries`                                                |
| `modules/03-core.md`, `06-vault.md`, `07-link.md`, `10-frontpage.md`                                                                                                            | Accurate; their status claims match the ledgers                                            |
| `operations/11-dx.md`, `12-testing.md`, `14-security.md`                                                                                                                        | Accurate                                                                                   |
| `decisions/0001`–`0029`                                                                                                                                                         | Untouched by design — accepted ADRs are immutable; `0030` and `0031` are the only new ones |
| `reviews/2026-10-28-vault-design-review.md`, `2026-10-29-capabilities-review.md`                                                                                                | Historical gate reviews; still the record of those gates                                   |
| `tasks/01-foundation.md`, `06-link.md`, `07-capabilities.md`, `08-dx.md`, `events.md`, `mail.md`, `notify.md`, `policy.md`, `pulse.md`, `queue.md`, `schedule.md`, `storage.md` | Statuses verified against source; all correct                                              |
| `tasks/14-laravel-decoupling.md`                                                                                                                                                | Planning-only by design and honestly marked; gated on Phase 8                              |

The one document that was **wrong about the implementation in the other direction** — claiming less
than the code does — is `tasks/15-feature-parity-audit.md` (storage), corrected in place on 2026-11-08
with the reasoning preserved rather than deleted.
