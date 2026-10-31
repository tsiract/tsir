# 13 — Logging, Observability & Health

> Structured logs, correlation, metrics, tracing, and health — vendor-neutral, OpenTelemetry-compatible, and cheap enough to leave on in production.

---

## 1. Package placement

`@tsir/pulse` owns:

| Concern             | Detail                                                             |
| ------------------- | ------------------------------------------------------------------ |
| Structured logging  | JSON lines, level filtering, redaction, child loggers with context |
| Request/job context | correlation id, trace id, unit, route, principal id (never PII)    |
| Metrics             | Counter/histogram/gauge facade over an OTel-compatible exporter    |
| Tracing             | Span helpers; auto-instrumentation for HTTP, DB, queue, link       |
| Health              | `/health` (liveness), `/ready` (readiness), dependency checks      |
| Error reporting     | Adapter interface (`SentryAdapter`, `OTLPAdapter`, `NoopAdapter`)  |

`@tsir/core` depends on a **`Logger` contract only** (an interface with `debug/info/warn/error/child`), so nothing is mandatory. `@tsir/pulse` provides the implementation; apps that want a different logger inject their own.

This keeps core small (brief: "core must remain small") and avoids forcing every app to adopt the observability module.

---

## 2. Logging

```ts
logger.info('invoice.paid', {
  invoiceId: invoice.id,
  amountCents: invoice.amountCents,
  // context is inherited, not repeated:
  // requestId, traceId, unit, route, principalId
});
```

**As built (2026-10-29) — `@tsir/pulse` implements § 2, § 4, § 5 and § 6 of this document.**
Nine modules, **123 tests**, **97.27 % lines / 97.39 % functions**, and `@tsir/container` as its only
dependency ([`tasks/pulse.md`](../tasks/pulse.md)). What ships is the layer this document describes
and the _mapping_ to four wire formats; the vendor **transports** (`otlp-http`, `opensearch`, `loki`,
`cloudwatch-logs`, Sentry) are separate tasks, and § 2.4.6 still governs them — a protocol and a
`fetch`, never an SDK.

Three deviations from the text below are recorded rather than hidden:

1. **There is no `Logger` contract in `@tsir/core`** (§ 1 said there would be). Nothing in core logs,
   and an interface there would be a dependency on observability for every package that wants none.
   The contract is structural: `@tsir/pulse` exports `Logger`, and a package that wants to log takes
   the three methods it uses.
2. **`pii: 'hash'` uses a synchronous SHA-256** shipped in `pulse/src/hash.ts`, because
   `crypto.subtle.digest` is asynchronous and a `logger.info()` cannot be. It is vector-tested and
   used only for pseudonyms and fingerprints; password hashing stays on WebCrypto.
3. **Dedup reports at `flush()`** rather than emitting a record with `occurrences` per window: a
   second line per window is a second line per window. `flush()` is the end of the invocation, which
   is where the plan already puts the summary record.

### 2.1 Record shape

```json
{
  "ts": "2026-10-27T01:22:41.913Z",
  "level": "info",
  "msg": "invoice.paid",
  "requestId": "01J9Z6…",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "unit": "http",
  "route": "POST /invoices",
  "invoiceId": "inv_123",
  "amountCents": 4200,
  "v": 1
}
```

Rules:

- **Event names, not sentences.** `dot.case` names (`db.query.slow`, `vault.rotation.batch`), message text reserved for human-only warnings.
- `v` is the log schema version; adding fields is compatible, renaming is not.
- No `console.log` in framework code — lint-enforced.
- Level is per-package configurable; production default `info`, framework internals `warn` unless `pulse.debugPackages` is set.
- Non-serializable values are summarized (`{ type: 'Buffer', bytes: 1024 }`), never `JSON.stringify`-ed blindly (cycles, secrets, huge payloads).

### 2.2 Redaction

Three layers, defense in depth:

1. **Typed**: `Redacted<T>` values can only be unwrapped explicitly (`reveal()`), which logs a warning in dev.
2. **Path-based**: `pulse.redact.paths = ['body.password', 'user.email']` applied to structured context.
3. **Pattern-based**: keys matching `/(password|secret|token|authorization|cookie|key)/i` redacted by default; values matching JWT/base64-key heuristics redacted even under an innocuous key.

A test asserts that a synthetic object containing every secret kind logs zero plaintext bytes.

### 2.3 PII

`principalId` is logged (an opaque id); email, name, IP are **not** logged by default. `pulse.log.pii: 'hash' | 'omit' | 'allow'` makes the policy explicit per app; `'allow'` is rejected in production unless acknowledged in config.

### 2.4 Error handling, log sinks and drivers

Tsir's error handling has to be _useful outside Tsir_. An application's errors
are read in CloudWatch, Kibana, OpenSearch, Grafana/Loki, Datadog or the
Cloudflare dashboard — by people who are not running Tsir and should not need to
know what a `TsirError` is. Two rules follow from that, and they are the whole
design:

1. **One normalized record, many sinks.** The framework decides the record's
   shape; a sink driver decides where it goes. Field naming never depends on the
   destination, so adding a vendor cannot leak into `@tsir/core` or `@tsir/http`.
2. **Cloudflare first, not Cloudflare only.** The Cloudflare path must work with
   zero dependencies and zero code (stdout → Workers Logs). Everything else is a
   driver, and a driver is a few hundred lines of protocol, not an SDK.

#### 2.4.1 What an error record is

An error is a log record with `level: "error"` (or `"fatal"`), an event name and
a serialized `err` — not a string, and not a vendor payload:

```json
{
  "ts": "2026-10-27T04:11:02.004Z",
  "level": "error",
  "event": "http.request.failed",
  "err": {
    "type": "ValidationError",
    "message": "Request body failed validation",
    "code": "HTP_VALIDATION_FAILED",
    "stack": ["at UsersController.create (users.controller.ts:42:11)", "…5 more"],
    "cause": { "type": "ZodError", "code": "invalid_type" }
  },
  "requestId": "01J9Z6…",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "route": "POST /api/users",
  "status": 422,
  "fingerprint": "HTP_VALIDATION_FAILED:request.body.email",
  "occurrences": 1,
  "v": 1
}
```

Rules that make the record ingestible everywhere:

- `err` is always an **object** with `type`, `message`, `stack[]`, `cause` (recursive,
  depth-capped), never a pre-formatted multi-line string. CloudWatch search,
  Kibana filters and LogsQL queries all index fields; none of them index prose.
- `fingerprint` is stable across occurrences (error code + origin + route, no ids),
  so deduplication is possible in every backend, not only in ours.
- The record already carries its **correlation** fields (`requestId`, `traceId`,
  `route`, `unit`), so no backend needs Tsir to reconstruct context.
- The record is **redacted before it reaches any driver** — see § 2.2 and § 8.
  A driver receives a `SafeRecord`; it cannot accidentally re-introduce secrets.

#### 2.4.2 Formats

`pulse.format` selects the wire shape once per process; drivers do not re-map.

| Format       | Shape                                                                                                          | Read by                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `tsir`       | the record above, JSON lines (default)                                                                         | anything; the canonical form                         |
| `ecs`        | Elastic Common Schema field names (`@timestamp`, `log.level`, `error.stack_trace`, `service.name`, `trace.id`) | Kibana, OpenSearch, Elastic Agent                    |
| `cloudwatch` | CloudWatch Logs JSON (`timestamp`, `level`, `message` + flattened extras)                                      | CloudWatch Logs Insights, Lambda stdout              |
| `otlp-json`  | OTLP `LogRecord` (`timeUnixNano`, `severityNumber`, `attributes`)                                              | any OTel collector → Loki, Tempo, Datadog, Honeycomb |

The `ecs` mapping is the compatibility bridge the ask implies: Kibana and
OpenSearch understand ECS natively, Grafana Loki understands JSON lines with
labels, and an OTel collector accepts OTLP and speaks to nearly everything else.
We do not invent a field vocabulary that only Tsir can read.

#### 2.4.3 Drivers (`pulse.sinks[]`)

| Driver             | Where it runs        | Transport                                                      | Notes                                                                              |
| ------------------ | -------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `stdout`           | everywhere (default) | process stdout, JSON lines                                     | Cloudflare Workers Logs, Lambda → CloudWatch, containers → anything                |
| `tail`             | Workers              | Tail Worker binding, event stream                              | transform/route before data leaves the account; no network in the request path     |
| `logpush`          | Cloudflare account   | Logpush job → R2, S3, GCS, Datadog, Splunk, Elastic, New Relic | configured at the account level; Tsir shapes the record so the job is usable as-is |
| `analytics-engine` | Workers              | `ANALYTICS` binding, `writeDataPoint`                          | metrics and counters, not free-text logs                                           |
| `otlp-http`        | anywhere             | OTLP/HTTP (protobuf or JSON)                                   | one driver, many backends (Loki, Tempo, Datadog, Honeycomb, …)                     |
| `cloudwatch-logs`  | Lambda / ECS / EC2   | `PutLogEvents`, SigV4-signed `fetch`                           | no AWS SDK; signed with Web Crypto                                                 |
| `opensearch`       | anywhere             | `_bulk` NDJSON                                                 | the Kibana/OpenSearch path for non-Cloudflare deployments                          |
| `loki`             | anywhere             | `POST /loki/api/v1/push`                                       | Grafana directly, without a collector                                              |
| `sentry`           | anywhere             | envelope endpoint (error events only)                          | errors and breadcrumbs only; logs stay on `pulse` sinks                            |
| `noop`             | everywhere           | —                                                              | tests and benchmarks                                                               |

**Cloudflare-first ordering.** In a Worker the default is `stdout`: Workers Logs
collects it with no configuration, no dependency and no extra bytes. Reach for,
in order: `logpush` when the account needs retention or fan-out to an existing
SIEM; `tail` when records must be shaped per-request before leaving the account;
`analytics-engine` when the question is "how many/how fast", not "what happened".
An external sink (Datadog, OpenSearch, CloudWatch) is a driver the application
opts into — never a transitive dependency of `@tsir/http`.

On AWS Lambda the same `stdout` driver already lands in CloudWatch Logs; the
`cloudwatch-logs` driver exists for the case where an application wants structured
events from a _container_ or wants to write to a different log group/stream.

#### 2.4.4 Delivery semantics

- **The request path never blocks on a sink.** Records go into a bounded queue;
  the flush happens at the end of the invocation (Workers `waitUntil`, Lambda
  extension/handler exit, Bun idle). When the queue is full: drop-oldest, count
  `pulse_sink_dropped_total{driver}`, emit one summary record per window.
- **Fail-open.** A sink that throws is disabled for the rest of the invocation and
  reported once at `warn`; it never turns a 200 into a 500. `pulse.sinks[].required:
true` is available for audit-driven applications and is the only way to invert
  this — and it fails _readiness_, not requests.
- **Deduplication.** Identical `fingerprint` within `pulse.errorWindowMs`
  (default 10 s) collapses into one record with `occurrences: n`. Every sink gets
  the collapsed record, so CloudWatch/Kibana see the same shape Tsir sees.
- **Sampling.** `pulse.errorSampleRate` (default 1) applies to `error`; `fatal`,
  boot failures and the first N errors per window per fingerprint are never
  sampled. Sampled-out records still increment a counter so the volume is visible.
- **Ordering is not promised.** Sinks are independent; a driver that needs
  ordering (CloudWatch sequence tokens) buffers internally.

#### 2.4.5 Configuration

```ts
export default {
  pulse: {
    format: 'ecs', // 'tsir' (default) | 'ecs' | 'cloudwatch' | 'otlp-json'
    sinks: [
      { kind: 'stdout' },
      // Cloudflare: account-level Logpush carries stdout/Tail events onward.
      // The app names the destination so misconfiguration is a boot warning.
      { kind: 'logpush', destination: 'r2://acme-logs' },
    ],
    errorSampleRate: 1,
    errorWindowMs: 10_000,
    flushTimeoutMs: 2_000,
  },
};
```

Sink credentials come from configuration validated at boot (`@tsir/config`), never
from `process.env` in application code, and are `Redacted<T>` wherever they are
held in memory.

#### 2.4.6 What we deliberately do not do

- **No vendor SDK in the runtime path.** A driver is a protocol and a `fetch`
  call. An SDK that installs a global handler, patches `console`, or keeps a
  socket open is rejected by the dependency policy (ADR-0012) and by the Workers
  environment anyway.
- **No re-formatting per sink.** If two backends disagree about a field name, the
  formatter handles it, not the driver — otherwise every new sink re-implements
  redaction.
- **No claims about plan availability or ingestion limits.** Logpush destinations,
  Workers Logs retention and Analytics Engine quotas vary by plan and change.
  Each driver task must cite the current documented limits at implementation time
  rather than baking a number into the plan (`OBS-023` … `OBS-028`).

---

## 3. Context propagation

```
HTTP request ──► ctx.requestId (generated or from trusted header)
              ──► ctx.traceId (W3C traceparent if present and valid, else new)
              ├── logger.child({ requestId, traceId })
              ├── DB span (child)
              ├── link calls   (traceparent injected outbound)
              └── job enqueue  (requestId stored on the job record)
Job execution ──► new span linked to enqueue trace (not parented — async boundary)
```

- Inbound `traceparent` is trusted only from `pulse.trustedTraceOrigins` (default: any, since traces are not authorization) but **validated** for format; malformed headers are replaced, not propagated.
- Correlation ids are returned in `X-Request-Id` and included in problem responses as `requestId`.
- Cross-runtime: on Workers/Lambda, context lives in the request handler scope, not `AsyncLocalStorage` (which is unavailable or partial). The framework passes context explicitly through `ctx`; `AsyncLocalStorage` is used on Bun only as an ergonomic layer for the logger, never as a source of truth.

---

## 4. Metrics

| Metric                     | Type      | Labels                                        |
| -------------------------- | --------- | --------------------------------------------- |
| `http_requests_total`      | counter   | `method`, `route` (templated), `status_class` |
| `http_request_duration_ms` | histogram | `method`, `route`                             |
| `db_query_duration_ms`     | histogram | `driver`, `operation`                         |
| `db_pool_connections`      | gauge     | `state`                                       |
| `vault_operations_total`   | counter   | `op`, `result`                                |
| `vault_rotation_remaining` | gauge     | `table`, `column`                             |
| `queue_jobs_total`         | counter   | `queue`, `result`                             |
| `queue_depth`              | gauge     | `queue`                                       |
| `link_calls_total`         | counter   | `protocol`, `kind`                            |
| `link_call_duration_ms`    | histogram | `protocol`                                    |

Cardinality rules: `route` is always the **template** (`/api/users/:id`), never the concrete path; ids never become labels; a label exceeding 10 000 distinct values triggers a dev-time warning.

---

## 5. Tracing

- OpenTelemetry API is the contract; exporters are adapters (`otlp-http`, `console`, `noop`).
- Auto-instrumentation: HTTP server span, outbound link call, DB query (with SQL summarized and parameters omitted), queue publish/consume, scheduled task, vault rotation batch.
- Sampling: configurable (`always`, `ratio`, `parent-based`), default `parent-based` with 10 % root ratio in production.
- Span attributes follow OTel semantic conventions (`http.request.method`, `db.system`, `messaging.operation`) — no invented conventions without a note.

---

## 5.1 As built: the tracer in one paragraph

`parseTraceparent` → `createSampler` → `startSpan`/`withSpan` → a buffered exporter, all injectable
(clock, id source, sampler). The two rules that matter: a malformed header is **replaced, not
forwarded** (version `ff`, all-zero ids, wrong lengths, non-hex — all start a new trace), and
parent-based sampling obeys the parent in **both** directions, because respecting only the positive
case is how a 10 % head sample becomes a 100 % tail in the next service. An unsampled span still runs;
it is simply not exported.

## 6. Health & readiness

| Endpoint           | Purpose                          | Checks                                                                                                            |
| ------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /health`      | Liveness — process is up         | None (must not touch dependencies)                                                                                |
| `GET /ready`       | Readiness — can serve traffic    | Config loaded, container composed, DB reachable (if required), vault keys valid, migrations current (if required) |
| `GET /__tsir/info` | Build info (dev only by default) | Version, commit, unit graph hash, module list                                                                     |

`/ready` returns `200` with a check summary or `503` with failing checks. It is served by the `admin` unit in `separate` topology so it can be kept private.

Readiness semantics: a failing optional dependency (e.g. cache) marks `degraded`, not `not ready`, unless the module declares `critical: true`.

---

## 7. Failure modes

| Situation                       | Behavior                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Logger misconfigured (bad sink) | Boot warning; falls back to stdout sink, never crashes the request path                                |
| Exporter unreachable            | Bounded queue + drop-oldest; counter `pulse_export_dropped_total`; no backpressure on requests         |
| Sink driver throws              | Disabled for the invocation, one `warn`, `pulse_sink_dropped_total`; requests unaffected               |
| Sink queue full                 | Drop-oldest, counted, one summary record per window — never an unbounded memory buffer                 |
| Record too large for the sink   | Truncated at the driver boundary (`stack` to 10 frames, `cause` depth to 3); the record says truncated |
| Destination rejects credentials | Boot warning when detectable at startup; otherwise first flush fails open and reports once             |
| Redaction pattern throws        | Caught; the field is replaced with `"[redaction-error]"`; the incident is logged at `error`            |
| `/ready` check times out        | Check marked failed with `timeout` reason after `readiness.timeoutMs`                                  |
| Log volume explosion            | Per-second rate limiter per event name (default 1 000/s) with a single `pulse_log_dropped` summary     |
| Trace header malformed          | New trace started, header ignored, warning at debug                                                    |
| Clock skew detected in spans    | Emits `pulse_clock_skew` metric; does not adjust clocks                                                |

---

## 8. Security considerations

- Logs are a **primary leak vector**; redaction is on by default, not opt-in.
- Request bodies are never logged automatically (only route, status, duration, ids).
- SQL is logged with placeholders; `debug-params` requires `APP_ENV=development` **and** an explicit flag.
- `Authorization`, `Cookie`, and `Set-Cookie` headers are never logged, even at trace level.
- Error reporting adapters strip request bodies and headers before shipping events; `beforeSend` hooks are typed, not `any`.
- Metrics endpoints require authentication when exposed; `admin` unit is separate by default.

---

**As built (2026-10-29).** `liveness()` touches nothing — a liveness probe that pings the database
restarts every worker during a database incident. `ready()` runs every check under a per-check
timeout and answers in one of **three** states, not two: a failing _optional_ dependency is
`degraded`/200 (traffic keeps flowing), a `critical: true` failure is `failed`/503 with the failing
checks named. The `critical` flag is declared next to the check, where the person who knows the
answer can see it.

## 9. Open questions

| #   | Question                                                                                                             | Decides |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| Q52 | Does `@tsir/pulse` grow an OTLP **exporter**, or does an application supply a sink for every backend it talks to?    | Phase 8 |
| Q53 | Sampling: is a head-sampled trace ratio enough, or does the framework need tail sampling to keep error spans?        | Phase 8 |
| Q54 | Do metrics carry exemplars (a trace id on a histogram sample), given that a `pulse` metric is a plain counter today? | Phase 8 |
| Q55 | Is `health` allowed to call a driver (`cache.probe()`), or must readiness stay a pure boot-time assertion?           | review  |

The rotation metrics in `06-vault.md` are the concrete case behind Q52: the numbers are emitted
through an optional observer and go nowhere until an application supplies a sink.

---

## 10. Task index

[`tasks/11-observability.md`](../tasks/11-observability.md) — `OBS-001` … `OBS-030`; the as-built
status of each is in [`tasks/pulse.md`](../tasks/pulse.md).
