# Tasks — Observability (Phases 1–8)

> Logging, context propagation, metrics, tracing, health.

**Plan:** [`../13-observability.md`](../operations/13-observability.md)

---

## Logging

| ID        | Title                                                       | Status | Depends     | Acceptance criteria (summary)                |
| --------- | ----------------------------------------------------------- | ------ | ----------- | -------------------------------------------- |
| `OBS-001` | `Logger` contract in core + default implementation in pulse | `[x]`  | APP-012     | Core compiles with no pulse dependency       |
| `OBS-002` | JSON-lines record format + `v` field                        | `[x]`  | OBS-001     | Snapshot test of record shape                |
| `OBS-003` | Child loggers with inherited context                        | `[x]`  | OBS-002     | Context preserved through async calls on Bun |
| `OBS-004` | Redaction layer 1: `Redacted<T>`                            | `[x]`  | CFG-004     | `reveal()` warns in dev                      |
| `OBS-005` | Redaction layer 2: path-based                               | `[x]`  | OBS-002     | `body.password` never logged                 |
| `OBS-006` | Redaction layer 3: key/value patterns                       | `[x]`  | OBS-002     | JWT-shaped values redacted under any key     |
| `OBS-007` | Redaction test: synthetic secret object → zero leakage      | `[x]`  | OBS-004…006 | Byte-level scan of output                    |
| `OBS-008` | PII policy (`omit` default)                                 | `[x]`  | OBS-002     | `allow` rejected in production               |
| `OBS-009` | Rate limiter for log volume per event                       | `[x]`  | OBS-002     | Storm produces one summary line              |

## Context

| ID        | Title                                              | Status | Depends | Acceptance criteria (summary)                                                                                                                                                                                                   |
| --------- | -------------------------------------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OBS-010` | Request id generation/propagation + `X-Request-Id` | `[x]`  | HTP-003 | Returned on every response — incoming `X-Request-Id` is propagated (sanitized, length-capped) when present, else a UUID is generated; set on responses and problem bodies                                                       |
| `OBS-011` | W3C `traceparent` parse/validate/propagate         | `[x]`  | OBS-010 | Malformed header replaced, not forwarded                                                                                                                                                                                        |
| `OBS-012` | Job context (requestId stored on job record)       | `[x]`  | —       | Worker logs carry origin request id — `requestId` is an optional field on `JobMessage` and `JobContext`, threaded through `DispatchOptions`, the database/outbox drivers, and the worker; absent when the dispatch carried none |

## Metrics & tracing

| ID        | Title                                       | Status | Depends | Acceptance criteria (summary)                  |
| --------- | ------------------------------------------- | ------ | ------- | ---------------------------------------------- |
| `OBS-013` | Metric facade (counter/histogram/gauge)     | `[x]`  | OBS-001 | OTel-compatible exporter interface             |
| `OBS-014` | HTTP/DB/queue/link/vault instrumentations   | `[ ]`  | OBS-013 | Metric names per `13-observability.md § 4`     |
| `OBS-015` | Route-template label cardinality guard      | `[x]`  | OBS-014 | Concrete ids never used as labels              |
| `OBS-016` | Tracing spans + sampling config             | `[x]`  | OBS-013 | Parent-based default; OTel semconv attributes  |
| `OBS-017` | Export queue with drop-oldest + drop metric | `[x]`  | OBS-016 | Exporter outage does not backpressure requests |

## Health

| ID        | Title                                               | Status | Depends | Acceptance criteria (summary)                                                                                                                                                             |
| --------- | --------------------------------------------------- | ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OBS-018` | `/health`, `/ready`, check registry, timeouts       | `[x]`  | OBS-013 | 503 with failing check list; degraded semantics                                                                                                                                           |
| `OBS-019` | Admin unit placement (private by default)           | `[x]`  | DPL-022 | Not publicly routable by default — closed by `DPL-022`: `private: true` units emit no HTTP API, and `deploy:validate` fails with `DPL_PRIVATE_EXPOSED` if a private unit becomes routable |
| `OBS-020` | Error reporting adapters (`noop`, `otlp`, `sentry`) | `[ ]`  | OBS-016 | Bodies/headers stripped before send                                                                                                                                                       |

## Error handling & sinks (`13-observability.md § 2.4`)

| ID        | Title                                                            | Status | Depends | Acceptance criteria (summary)                           |
| --------- | ---------------------------------------------------------------- | ------ | ------- | ------------------------------------------------------- |
| `OBS-021` | `SafeRecord` sink contract + `stdout` driver                     | `[x]`  | OBS-002 | Drivers receive redacted records; type-checked          |
| `OBS-022` | Error record normalization (`err` object, fingerprint, cause)    | `[x]`  | OBS-002 | Snapshot test incl. nested `cause` and stack truncation |
| `OBS-023` | `ecs` formatter (Kibana/OpenSearch)                              | `[x]`  | OBS-022 | Field mapping table asserted in a test                  |
| `OBS-024` | `otlp-json` formatter + `otlp-http` driver                       | `[~]`  | OBS-022 | Formatter done; driver needs a collector (cloud)        |
| `OBS-025` | `cloudwatch` formatter (Logs Insights JSON)                      | `[x]`  | OBS-022 | Timestamp in ms, message + flattened extras             |
| `OBS-026` | `cloudwatch-logs` driver (SigV4 via Web Crypto, no SDK)          | `[ ]`  | OBS-025 | Signed request verified against the published vector    |
| `OBS-027` | `opensearch` bulk driver + `loki` push driver                    | `[ ]`  | OBS-023 | Batched NDJSON / streams; 429 → retry with backoff      |
| `OBS-028` | Cloudflare path: `logpush` shaping + `tail` + `analytics-engine` | `[ ]`  | OBS-021 | Documented plan limits cited at implementation          |
| `OBS-029` | Dedup (`fingerprint` + window) and sampling policy               | `[x]`  | OBS-022 | Storm collapses to one record with `occurrences`        |
| `OBS-030` | Fail-open semantics, drop metric, `required` sink readiness      | `[x]`  | OBS-021 | A throwing sink never turns a 200 into a 500            |

---

## As built (2026-10-29)

`@tsir/pulse` is complete for this phase — the logging, redaction, metrics, tracing and health tasks
above are `[x]`; [`pulse.md`](./pulse.md) records what each one shipped as, with the file map.
Dependency set: `@tsir/container` only. Tests: **123**; **97.27 % lines / 97.39 % functions**.

Still open, and named rather than implied:

- `OBS-001` shipped **without** the `Logger` contract in `@tsir/core` — nothing in core logs, and an
  interface there is a dependency on observability for packages that want none. The contract is
  structural: `@tsir/pulse` exports `Logger`, and a package takes the three methods it uses. The
  `APP-012` dependency is therefore not consumed by this row, on the record.
- `OBS-010`/`OBS-012` are `[ ]`: the _parsing_ half (`traceparent` validate/replace) is in pulse,
  but returning `X-Request-Id` on every response and storing a request id on a job record belong to
  `@tsir/http` and `@tsir/queue` and are not part of this batch.
- `OBS-014` is `[ ]`: the facade ships, the per-package instrumentation calls do not — each belongs
  in the package that owns the operation, taking an optional tracer.
- `OBS-020` and the vendor transports (`OBS-024` driver, `OBS-026`, `OBS-027`, `OBS-028`) are `[ ]`/`[~]`.
  The `ecs`/`cloudwatch`/`otlp-json` **mappings** ship and are tested; the drivers that would POST
  them do not. `OBS-022` (error normalization), `OBS-023` (ecs), `OBS-025` (cloudwatch), `OBS-029`
  (dedup + sampling) and `OBS-030` (fail-open sinks) are implemented and tested in `@tsir/pulse`.

## Gate notes

- `OBS-001` must land in Phase 1 (interface only) so packages can log without pulling the implementation.
- `OBS-007` is a release blocker: a log-leak test failure blocks any tag.
