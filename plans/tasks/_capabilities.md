# Tasks — Capabilities (Phase 7, placeholder)

> **Superseded on 2026-10-28 by [`07-capabilities.md`](./07-capabilities.md).** This file is
> kept as the record of the module map and the scope guard; the task table, ordering and
> status live in the phase file.

**Plan:** [`15-capabilities.md`](../modules/15-capabilities.md) + [ADR-0027](../decisions/0027-capability-drivers.md).

---

## Scope guard

Phase 7 does not start until Gate P6 passes. **Amended 2026-10-28:** Gate P6 is satisfied for
every criterion this environment can satisfy (deterministic graph, both topologies emitting,
secrets, `--explain`); its cloud-scheduled half lives in `07-deploy-cloud-checks.md` and does
not gate capability work, which touches no deployment adapter until `CAP-004`. The guards
below still hold:

- No `src/framework/{auth,policy,cache,queue,events,schedule,mail,notify,storage}` directories.
- No frontpage card may claim these modules are available (they are `data-status="planned"`).
- No import of a capability package from any Phase 1–6 package.

---

## Module map (to be expanded)

| Module         | Package          | Boundary decision pending                | Notes                               |
| -------------- | ---------------- | ---------------------------------------- | ----------------------------------- |
| Authentication | `@tsir/auth`     | Session store per target (Q3)            | Separate from authorization, always |
| Authorization  | `@tsir/policy`   | Policy context without HTTP              | Enforceable at service boundary     |
| Cache          | `@tsir/cache`    | **started** — `memory`, `null` shipped   | Explicit serialization only         |
| Queue          | `@tsir/queue`    | Backend (Postgres first, SQS/Queues)     | Idempotency + DLQ + drain           |
| Events         | `@tsir/events`   | Outbox ownership                         | Sync vs async semantics explicit    |
| Scheduler      | `@tsir/schedule` | Distributed lock provider                | Overlap prevention                  |
| Mail           | `@tsir/mail`     | Transport list (SMTP, SES, Resend)       | Template ownership                  |
| Notify         | `@tsir/notify`   | Merge with mail?                         | Channel adapters                    |
| Storage        | `@tsir/storage`  | Drivers (S3, R2, local)                  | Signed URL policy                   |
| Pulse          | `@tsir/pulse`    | Already planned in `13-observability.md` | Health/metrics                      |

---

## Provisional task ids

`CAP-AUTH-001…`, `CAP-POL-001…`, `CAP-CACHE-001…`, `CAP-QUEUE-001…`, `CAP-EVT-001…`, `CAP-SCHED-001…`, `CAP-MAIL-001…`, `CAP-NOTIFY-001…`, `CAP-STOR-001…`.

Each will be expanded with acceptance criteria when its plan is written. Ids are reserved, not commitments.
