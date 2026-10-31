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

### Core phases (0–6)

| File                                                 | Covers                                                     | Task range                               |
| ---------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| [`01-foundation.md`](./01-foundation.md)             | Repo, tooling, CI, Makefile, dev server                    | `FND-001`…`FND-024`, `DXS-001`…`DXS-008` |
| [`02-core.md`](./02-core.md)                         | Container, config, lifecycle, errors, `tsir.js` loader     | `CTN-*`, `CFG-*`, `APP-*`, `ERR-*`       |
| [`03-http.md`](./03-http.md)                         | Router, HTTP pipeline, validation, OpenAPI                 | `RTR-*`, `HTP-*`, `VLD-*`                |
| [`04-database.md`](./04-database.md)                 | Drizzle integration, migrations, seeders                   | `DB-*`, `MIG-*`, `SED-*`                 |
| [`05-vault.md`](./05-vault.md)                       | Envelope, keyring, codec, rotation                         | `VLT-*`                                  |
| [`06-link.md`](./06-link.md)                         | REST, gRPC, SOAP, WebSocket                                | `LNK-*`                                  |
| [`07-deploy.md`](./07-deploy.md)                     | Unit graph, Workers, Lambda, `tsir.js` deploy automation   | `DPL-*`                                  |
| [`08-dx.md`](./08-dx.md)                             | CLI, generators, Makefile evolution, bootstrap             | `CLI-*`, `DXS-*`, `CFG-1xx`              |
| [`09-frontpage.md`](./09-frontpage.md)               | Frontpage, docs site, naming checks                        | `DOC-*`                                  |
| [`10-testing.md`](./10-testing.md)                   | Test harness, matrices, concurrency                        | `TST-*`                                  |
| [`11-observability.md`](./11-observability.md)       | Logging, metrics, tracing, health                          | `OBS-*`                                  |
| [`12-security.md`](./12-security.md)                 | Threat model, review, secrets                              | `SEC-*`                                  |
| [`13-modularity.md`](./13-modularity.md)             | Module ownership, boundaries, DX                           | `MOD-*`                                  |
| [`manual-verification.md`](./manual-verification.md) | Handoff: cloud checks, Windows check, maintainer decisions | `C1`…`C8` (from 07), `CLI-018`           |

[`07-deploy-cloud-checks.md`](./07-deploy-cloud-checks.md) holds the Phase 6 criteria that
**cannot** be met in this repository — they need a Cloudflare or AWS account, or a wall clock.
They are tracked separately so the main table never has to lie about what is proven.

### Phase 7 — capabilities

One file per module, grouped because they ship together and share the mechanism in
[ADR-0027](../decisions/0027-capability-drivers.md).

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
| [`auth.md`](./auth.md)                       | Passwords, sessions, tokens, API keys, guards          | `AUTH-*`           |
| [`pulse.md`](./pulse.md)                     | Logging, redaction, metrics, tracing, health           | `PULSE-*`, `OBS-*` |

[`_capabilities.md`](./_capabilities.md) is **superseded** (2026-10-28) and kept only as the
record of the module map and the scope guard. Read `07-capabilities.md` instead.

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
