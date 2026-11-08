# Tasks

> Executable work items. Each task is small enough to review in one sitting and has acceptance criteria that can be checked by a test, a command, or a diff.

---

## 1. Rules

1. **One task, one PR** where practical. If a task needs to be split, split the task file — do not ship half a task marked `[x]`.
2. **Status discipline.** `[ ]` → `[~]` when a branch exists → `[x]` only when acceptance criteria are met _and_ linked.
3. **No orphan TODOs.** Any `TODO` in code carries a task id (`// TODO(VLT-012): …`).
4. **Blocked tasks say why.** `[!]` requires a one-line reason and a link to the blocking task or decision.
5. **Plan-first.** A task that contradicts a plan amends the plan in the same PR.

---

## 2. Index

The files below are ordered by **execution sequence**. Each phase depends on the phases
before it; do not start a later phase while an earlier one still has open `[ ]` or `[~]`
items that block it. The dependency arrows note the hard gates.

### Phase 1–2 — Foundation & core

| File                                     | Covers                                                 | Task range                               |
| ---------------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| [`01-foundation.md`](./01-foundation.md) | Repo, tooling, CI, Makefile, dev server                | `FND-001`…`FND-024`, `DXS-001`…`DXS-008` |
| [`02-core.md`](./02-core.md)             | Container, config, lifecycle, errors, `tsir.js` loader | `CTN-*`, `CFG-*`, `APP-*`, `ERR-*`       |

### Phase 3–6 — Infrastructure

| File                                 | Covers                                                   | Task range                |
| ------------------------------------ | -------------------------------------------------------- | ------------------------- |
| [`03-http.md`](./03-http.md)         | Router, HTTP pipeline, validation, OpenAPI               | `RTR-*`, `HTP-*`, `VLD-*` |
| [`04-database.md`](./04-database.md) | Drizzle integration, migrations, seeders                 | `DB-*`, `MIG-*`, `SED-*`  |
| [`05-vault.md`](./05-vault.md)       | Envelope, keyring, codec, rotation                       | `VLT-*`                   |
| [`06-link.md`](./06-link.md)         | REST, gRPC, SOAP, WebSocket                              | `LNK-*`                   |
| [`07-deploy.md`](./07-deploy.md)     | Unit graph, Workers, Lambda, `tsir.js` deploy automation | `DPL-*`                   |

`07-deploy.md` has a sidecar: [`07-deploy-cloud-checks.md`](./07-deploy-cloud-checks.md)
holds the Phase 6 criteria that **cannot** be met in this repository — they need a
Cloudflare or AWS account, or a wall clock. They are tracked separately so the main
table never has to lie about what is proven. [`manual-verification.md`](./manual-verification.md)
is the handoff list for those checks plus the Windows run and maintainer decisions.

### Phase 7 — Capabilities

One file per module, grouped because they ship together and share the mechanism in
[ADR-0027](../decisions/0027-capability-drivers.md). The phase foundation is
[`07-capabilities.md`](./07-capabilities.md); every per-module file builds on `CAP-001`…`CAP-005`.

| File                                         | Covers                                                 | Task range         |
| -------------------------------------------- | ------------------------------------------------------ | ------------------ |
| [`07-capabilities.md`](./07-capabilities.md) | The registry, conformance kit, `drivers.gen.ts`        | `CAP-*`            |
| [`queue.md`](./queue.md)                     | Queue port, worker, drivers, `queue:*`, triggers       | `QUEUE-*`          |
| [`events.md`](./events.md)                   | Typed events, sync/queued listeners, the outbox writer | `EVT-*`            |
| [`schedule.md`](./schedule.md)               | Cron tasks, the tick, the lock port, `schedule:*`      | `SCHED-*`          |
| [`storage.md`](./storage.md)                 | Object-storage disks, drivers, `storage:*`, SigV4      | `STOR-*`           |
| [`mail.md`](./mail.md)                       | Mailers, transports, templates, MIME, `mail:*`         | `MAIL-*`           |
| [`notify.md`](./notify.md)                   | Channels, notifications, queued delivery, `notify:*`   | `NOTIFY-*`         |
| [`policy.md`](./policy.md)                   | Roles, permissions, policies, `authorize`/`require`    | `POL-*`            |
| [`auth.md`](./auth.md)                       | Passwords, sessions, tokens, API keys, guards, CSRF    | `AUTH-*`           |
| [`pulse.md`](./pulse.md)                     | Logging, redaction, metrics, tracing, health           | `PULSE-*`, `OBS-*` |

[`_capabilities.md`](./_capabilities.md) is **superseded** (2026-10-28) and kept only as the
record of the module map and the scope guard. Read `07-capabilities.md` instead.

### Phase 8 — Cross-cutting

| File                                           | Covers                                         | Task range                  |
| ---------------------------------------------- | ---------------------------------------------- | --------------------------- |
| [`08-dx.md`](./08-dx.md)                       | CLI, generators, Makefile evolution, bootstrap | `CLI-*`, `DXS-*`, `CFG-1xx` |
| [`09-frontpage.md`](./09-frontpage.md)         | Frontpage, docs site, naming checks            | `DOC-*`                     |
| [`10-testing.md`](./10-testing.md)             | Test harness, matrices, concurrency            | `TST-*`                     |
| [`11-observability.md`](./11-observability.md) | Logging, metrics, tracing, health              | `OBS-*`                     |
| [`12-security.md`](./12-security.md)           | Threat model, review, secrets                  | `SEC-*`                     |
| [`13-modularity.md`](./13-modularity.md)       | Module ownership, boundaries, DX               | `MOD-*`                     |

### Phase 9 — Rebranding (depends on Phase 8 closing)

| File                                                     | Covers                                          | Task range |
| -------------------------------------------------------- | ----------------------------------------------- | ---------- |
| [`14-laravel-decoupling.md`](./14-laravel-decoupling.md) | Laravel-ecosystem package & terminology renames | `RBR-*`    |

### Phase 10 — Feature parity (depends on Phase 9 rebranding)

| File                                             | Covers                                   | Task range |
| ------------------------------------------------ | ---------------------------------------- | ---------- |
| [`15-feature-parity.md`](./15-feature-parity.md) | 1:1 feature mapping vs Laravel ecosystem | `PARITY-*` |

The per-module Phase 10 files track the post-rebrand packages (see `14-laravel-decoupling.md`
for the rename map):

| File                             | Covers (← legacy name)                                               | Task range |
| -------------------------------- | -------------------------------------------------------------------- | ---------- |
| [`search.md`](./search.md)       | Search engine port, drivers, queue sync (← scout)                    | `SRCH-*`   |
| [`telemetry.md`](./telemetry.md) | Request/queue logs, exception + cache/DB/mail tracking (← telemetry) | `TEL-*`    |
| [`billing.md`](./billing.md)     | Billing provider port, Stripe + Paddle (← cashier)                   | `BILL-*`   |
| [`servers.md`](./servers.md)     | Server management, SSH/local/cloud providers (← forge)               | `SRV-*`    |
| [`oauth.md`](./oauth.md)         | Social login providers, OAuth 1.0a, stateless auth (← socialize)     | `OAUTH-*`  |
| [`browser.md`](./browser.md)     | Browser automation, assertions, page objects (← nightwatch)          | `BROW-*`   |

[`15-feature-parity-audit.md`](./15-feature-parity-audit.md) is the source-verification audit
for the parity doc. It found the parity doc **under-reports** implementation status for six
packages (cache tags/increment/remember, scout in-memory engine, cashier subscriptions/invoices,
mail attachments, queue delayed/unique jobs, deploy custom domains). The audit is the evidence
record; the parity doc's statuses should be updated from `[ ]`/`[~]` to `[x]`/`[~]` per its
recommendations.

### Phase 8 — Infrastructure hardening

| File                                                                 | Covers                                                                                                                                   | Task range          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| [`16-infrastructure-hardening.md`](./16-infrastructure-hardening.md) | The `INF-001`…`INF-020` findings from the 2026-11-07 audit: dialect bugs, queue batch loss, `waitUntil`, hybrid unblocking, worker units | `INF-001`…`INF-020` |

These tasks cut across packages on purpose. They are the ledger for
[`../architecture/17-infrastructure-philosophy.md`](../architecture/17-infrastructure-philosophy.md)
and [ADR-0030](../decisions/0030-hybrid-cloud-and-workload-substrates.md), and they borrow ids from
no existing prefix — a fix that changes `@tsir/auth`, `@tsir/database` and `@tsir/deploy` at once
does not belong in three tables.

### Admin app

| File                                         | Covers                                                    | Task range          |
| -------------------------------------------- | --------------------------------------------------------- | ------------------- |
| [`admin-followups.md`](./admin-followups.md) | Remaining edge-case verifications for `admin.product.com` | `ADM-001`…`ADM-009` |

---

## 3. Task template

```markdown
### `PREFIX-000` — Short imperative title

- **Phase:** 1
- **Status:** `[ ]`
- **Depends on:** `PREFIX-001`, ADR-0003
- **Owner:** (unassigned)
- **Acceptance criteria:**
  - [ ] Behavior X observable via `command`
  - [ ] Negative case Y returns code `CODE_Y` (test link)
  - [ ] Docs updated in the package `README.md` / `src/docs/...`
```

---

## 4. Definition of done (per task)

Copy from [`../01-roadmap.md § 6`](../roadmap/01-roadmap.md#6-definition-of-done). A task cannot be `[x]` unless every applicable row is satisfied. The reviewer checks the task file's acceptance criteria against the diff, not the other way round.

---

## 5. Execution order (dependency-driven, re-derived 2026-11-08)

The phase tables above order **documents**; this section orders **work**. It is the section to read
when the question is "what do I do next", and it is derived from the actual `Depends` columns in every
ledger plus the `INF-*` sequencing graph, not from the phase numbering.

### 5.1 Tier 0 — correctness blockers (do first, in this order)

Nothing else is safe to build on top while these are open. Each is a stated prerequisite of at least
two other ledgers.

| Order | Task(s)   | Why it is first                                                                          | Blocks                                                                 |
| ----- | --------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1     | `INF-001` | The Postgres auth path emits `$1` twice; every P2/P3/P4 profile terminates in Postgres   | `DB-023`–`DB-026`, `MIG-016`, `INF-003`, `INF-010`, `INF-011`, `TEL-*` |
| 2     | `INF-002` | `@tsir/database`'s barrel imports `bun:sqlite`/`node:fs`; no Workers bundle can carry it | `INF-003`, `INF-012`, `INF-016`                                        |
| 3     | `INF-004` | The default queue driver drops messages on a multi-message batch                         | `INF-020`; any production queue claim                                  |
| 4     | `INF-005` | The AWS emitter drops three trigger kinds and writes an invalid SAM/WS template          | Gate P8 criterion 6; `DPL-016`                                         |
| 5     | `INF-003` | Postgres via `tsir.js`, request-scoped Hyperdrive, the MySQL status statement            | `INF-010`, `INF-011`, `INF-017`, `INF-019`                             |

### 5.2 Tier 1 — seams that unblock feature work

| Task(s)              | Unblocks                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `INF-006`            | `INF-009`, `INF-016`; `TEL-*` and `OBS-014` cannot be correct without `waitUntil`                |
| `INF-007`            | Deployment profile P3 (hybrid); `QUEUE-16`'s SDK-free claim                                      |
| `INF-008`            | R2 parity for `@tsir/storage`; presigned uploads used by the admin app (`ADM-*`)                 |
| `INF-009`            | Any multi-instance real-time claim; `AUTH-13`'s cookie/session story is adjacent but independent |
| `INF-012`            | Deployment profile P5; `INF-015`                                                                 |
| `HTP-023`, `HTP-024` | `AUTH-13`–`AUTH-15` (CSRF and email verification need cookie primitives and honest client IPs)   |
| `RTR-013`            | `AUTH-15` (a signed verification URL wants `route(name, params)`)                                |

### 5.3 Tier 2 — features, in dependency order

| Track                                        | Order                                                                        | Gate                       |
| -------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------- |
| HTTP & routing                               | `HTP-022`, `HTP-023`, `HTP-024`, `RTR-013`, `RTR-014`, `RTR-015`             | Gate P2 completion         |
| Data                                         | `DB-027`, `DB-028`, then the MySQL block `DB-023` → `DB-026` + `MIG-016`     | after `INF-001`/`INF-003`  |
| Auth & security                              | `AUTH-13` → `AUTH-14` → `AUTH-15`, then `SEC-015` (rate limiting)            | after `HTP-023`, `RTR-013` |
| Observability                                | `OBS-014` and `OBS-020`, then `OBS-024`, `OBS-026`–`OBS-028`                 | after `INF-006`            |
| Telemetry                                    | `TEL-5`–`TEL-9`                                                              | after `INF-010`            |
| Search / billing / servers / oauth / browser | `SRCH-4`–`SRCH-8`, `BILL-5`, `SRV-6`, `OAUTH-6`–`OAUTH-8`, `BROW-4`–`BROW-6` | all after Tier 0           |

### 5.4 Tier 3 — hardening and release gates

`INF-013` (PBKDF2 on Free), `INF-014` (stale constants), `INF-015` (native-binary attribution),
`INF-016` (edge-native admin app), `INF-017`/`INF-018` (Redis and workflow decisions),
`INF-019`/`INF-020` (replicas, queue policy), `SEC-006`, `SEC-007`, `SEC-017`, `SEC-018`,
`TST-016`, `TST-020`.

### 5.5 Safe parallelism

These sets touch disjoint files and can be reviewed concurrently:

- `INF-001` ‖ `INF-002` ‖ `INF-004` ‖ `INF-005` ‖ `INF-008` ‖ `INF-013` ‖ `INF-014`
- `SRCH-*` ‖ `BROW-*` ‖ `BILL-*` ‖ `SRV-*` ‖ `OAUTH-*` (five independent packages, one new driver each)
- `HTP-023` ‖ `RTR-013` ‖ `DB-027` ‖ `DB-028`
- Docs-only work (`DOC-015`, `DOC-016`, `OBS-028`'s documentation half) ‖ anything

### 5.6 Blocked, and by what

| Task(s)                      | Blocked by                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `DB-023`–`DB-026`, `MIG-016` | `INF-001` + `INF-003` — a MySQL adapter written first repeats the placeholder bug with `?`                  |
| `TEL-5`–`TEL-9`              | `INF-010` — the telemetry package cannot run on D1 or Postgres as it stands                                 |
| `AUTH-13`–`AUTH-15`          | `HTP-023` (cookie primitives), `AUTH-7` (session store)                                                     |
| `OBS-014`–`OBS-028`          | `INF-006` for the request-scoped half; cloud drivers additionally need `07-deploy-cloud-checks` credentials |
| `TST-016`                    | `DPL-024`; the three-target conformance suite needs one artifact per target                                 |
| Phase 9 (all `RBR-*`)        | Gate P8 closure — decoupling is a rename, and renaming unstable packages is churn                           |
| Phase 10 docs-only rows      | nothing — the parity tables are already being maintained inside Phase 8                                     |

### 5.7 Reading a `[~]` row

A `[~]` row in this directory means **a branch existed or part of the acceptance criteria is met**,
never "nearly done". Where a row is `[~]`, the row itself states which half is done and which is
outstanding — `DPL-013`–`DPL-018` (built and tested, cloud acceptance unproven), `VLT-023` (metrics
emitted, exporter missing), `CFG-002` (`Bun.env` banned, `process.env` not), `TST-010`/`TST-014`/`TST-015`
(harness built, matrix incomplete), `CLI-018` (generator built, Windows run unverified). If you find a
`[~]` whose remaining work is not written down, that is a documentation bug: fix the row first.
