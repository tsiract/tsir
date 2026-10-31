# ADR-0017 — Error and log sinks: one record, driver adapters, Cloudflare first

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related:** [ADR-0012](./0012-dependency-policy.md) (dependency policy), [ADR-0015](./0015-capability-drivers.md) (capability drivers), [ADR-0016](./0016-cloudflare-first-and-d1.md) (Cloudflare-first)

## Context

Applications do not read their own logs; people read them in whatever their
organisation already runs — CloudWatch, Kibana/OpenSearch, Grafana/Loki, Datadog,
or the Cloudflare dashboard. The framework decides how errors are _shaped_, and
that shape determines whether those tools can do anything with them.

Three failure modes are common in frameworks and all three are avoidable:

1. **Vendor SDKs in the runtime path.** They install global handlers, patch
   `console`, hold sockets open, and add hundreds of kilobytes to a bundle that
   has to boot on Workers.
2. **Per-destination field naming.** One backend wants `@timestamp`, another wants
   `timestamp`, a third wants `timeUnixNano`. When each driver re-maps, redaction
   and correlation get re-implemented per driver and drift.
3. **Errors as prose.** `console.error(err)` produces a multi-line string that no
   query language can filter by `code`, `route` or `fingerprint`.

Tsir also has a stated deployment bias: Cloudflare Workers first, D1 by default
([ADR-0016](./0016-cloudflare-first-and-d1.md)). Whatever the logging design is,
it must cost nothing for a Worker that only wants its logs in the dashboard.

## Decision

**One normalized record, formatted once, delivered by a driver.**

- The framework defines a versioned JSON record (`v: 1`) with structured `err`
  (`type`, `message`, `code`, `stack[]`, `cause`), correlation fields
  (`requestId`, `traceId`, `route`, `unit`) and a stable `fingerprint`.
- The record is **redacted before it reaches a driver**. Drivers accept a
  `SafeRecord` type; they cannot re-introduce secrets.
- Wire shape is chosen once per process by `pulse.format`: `tsir` (canonical),
  `ecs` (Kibana/OpenSearch), `cloudwatch` (Logs Insights), `otlp-json` (any OTel
  collector). Drivers do not re-map fields.
- Delivery is **fail-open and off the request path**: bounded queue, drop-oldest,
  drop metric, one `warn` when a driver is disabled.
- **Cloudflare-first, in this order:** `stdout` (Workers Logs, zero config) →
  `logpush` (account-level retention/fan-out) → `tail` (per-request shaping) →
  `analytics-engine` (counts, not prose). External sinks — `otlp-http`,
  `cloudwatch-logs`, `opensearch`, `loki`, `sentry` — are opt-in drivers shipped
  by the observability package, never transitive dependencies of the HTTP stack.
- Drivers are **protocols plus `fetch`/bindings**, not SDKs: SigV4 for CloudWatch
  is signed with Web Crypto; OpenSearch is `_bulk` NDJSON; Loki is its push API.

## Consequences

**Good**

- A Worker with no observability configuration produces readable structured logs
  in the Cloudflare dashboard at zero cost, and the same records are already in a
  shape Logpush or a collector can carry onward.
- Adding a backend is a driver, not a change to `@tsir/core` or `@tsir/http`; the
  dependency budget stays at one runtime dependency ([ADR-0012](./0012-dependency-policy.md)).
- Deduplication, sampling and redaction are implemented once and apply to every
  destination, including ones added later.
- Anything an ECS- or OTLP-compatible backend can ingest, Tsir can produce.

**Costs**

- A formatter layer exists that a single-destination application never thinks
  about; `tsir` format must remain the default so it stays free.
- Some backends want features the normalized record lacks (Datadog's reserved
  attributes, CloudWatch embedded metric format). Each is handled in a formatter
  or driver with an explicit mapping test, not by widening the core record.
- "Fail-open" means a broken sink can silently lose logs. That is deliberate —
  losing telemetry must not lose revenue — but it makes `required: true` and the
  drop metric part of the contract, and readiness is where a required sink fails.

## Alternatives rejected

| Alternative                                                | Why not                                                                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adopt a logging library (pino, winston) and its transports | Pulls Node-specific dependencies into runtime-neutral packages; pino's transports assume worker threads and `node:stream`.                           |
| Ship Sentry/Datadog SDKs for "first-class support"         | Global handlers, sockets and size; the Cloudflare path becomes an afterthought. Adapters over HTTP keep the contract small.                          |
| Emit only OTLP and call it universal                       | Requires a collector inside the Worker runtime — an extra hop and a deployment. OTLP is one format among four, not the base.                         |
| Per-sink record shapes                                     | Redaction and correlation would be re-implemented per sink, and the security property (no secrets in logs) would depend on which sink is configured. |
| Log only to `console.log` strings                          | Not queryable by `code`, `route` or `fingerprint`; dedup and sampling become impossible in every backend.                                            |

## Open questions

- `Q7` (naming/trademark) still gates the public driver names.
- Whether `sentry` stays an error-only adapter or also accepts log records —
  decided when `OBS-020` is implemented against the current Sentry envelope spec.
- Cloudflare plan availability for Logpush destinations and Analytics Engine
  quotas must be re-checked when `OBS-028` is implemented; no limit is asserted
  in this ADR on purpose.
