# Tasks — `@tsir/pulse` (Phase 7)

> Logging, metrics, tracing and health — the implementation `13-observability.md` describes, with one
> rule that shapes every module: **telemetry never fails a request**.
>
> **Plan:** [`13-observability.md`](../operations/13-observability.md) · **Related:**
> [`11-observability.md`](./11-observability.md) (`OBS-*`), [`12-security.md`](./12-security.md)
> (logs as a leak vector), [`0017-error-and-log-sinks.md`](../decisions/0017-error-and-log-sinks.md).

**Status: complete for this phase — 2026-10-29.** Nine modules, six test files, one type-test file.
Tests: **123**, and the coverage gate reports **97.27 % lines / 97.39 % functions**. Dependency set:
`@tsir/container` only — no SDK, no `node:` import, no global patched.

Built: `OBS-001`…`OBS-009` (logging, redaction, PII, volume), `OBS-010`/`OBS-011` (context and
`traceparent` parsing — the request header wiring lives in `@tsir/http`), `OBS-013`/`OBS-015`
(metrics facade and the cardinality guard), `OBS-016`/`OBS-017` (spans, sampling, a buffered
exporter), `OBS-018` (health, readiness, timeouts) and `OBS-021` (`stdout`/`memory`/`fanout` sinks).
Not built in this batch, and named rather than implied: the vendor drivers (`ecs` _mapping_ ships,
the `opensearch`/`loki`/`cloudwatch-logs`/`otlp-http` **transports** do not), `OBS-026`, the
`logpush`/`tail`/`analytics-engine` shaping, and `OBS-020`'s Sentry adapter.

## Tasks

| ID         | Task                                                    | Status | Depends        | Acceptance                                                                                                                           |
| ---------- | ------------------------------------------------------- | ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PULSE-1`  | The record: `ts`, `level`, `event`, `v`, flat fields    | `[x]`  | —              | JSON lines, event names enforced as `dot.case`, reserved keys unforgeable through `fields`, no `undefined` written                   |
| `PULSE-2`  | Error normalisation — `err` as an object, not a string  | `[x]`  | `PULSE-1`      | `type`/`message`/`code`/`stack[]`/recursive `cause`; stack capped at 10 frames and `cause` at depth 3, each saying it was truncated  |
| `PULSE-3`  | Non-serializable values are summarised                  | `[x]`  | `PULSE-1`      | `Buffer` → `{type:'bytes',bytes}`, cycles → `[circular]`, depth → `[depth]`, a throwing getter → `[unreadable]`, never an exception  |
| `PULSE-4`  | `fingerprint` — stable across occurrences               | `[x]`  | `PULSE-2`      | Code + origin + route + event, never an id or a timestamp; the same error twice is one group                                         |
| `PULSE-5`  | Redaction layer 1 — `Redacted<T>` + `reveal()`          | `[x]`  | —              | JSON, a template literal and string concatenation all see `[redacted]`; `reveal()` reports itself so a log-path use is greppable     |
| `PULSE-6`  | Redaction layer 2 — paths, with `*` and `**`            | `[x]`  | `PULSE-5`      | `body.pin` is redacted although the key looks harmless; `items[*].card` and `vault.**` both work, and a path is matched on the graph |
| `PULSE-7`  | Redaction layer 3 — key and value patterns              | `[x]`  | `PULSE-5`      | A JWT, a PEM key, a `Bearer`, a `tsk_…` key and a long base64 blob are redacted **under an innocent key**                            |
| `PULSE-8`  | The leak test                                           | `[x]`  | `PULSE-5`…`7`  | One synthetic object containing every secret kind, through the real logger, then a byte scan of the line — zero plaintext            |
| `PULSE-9`  | PII policy — `omit` (default) / `hash` / `allow`        | `[x]`  | `PULSE-6`      | Person-shaped keys only; `hash` produces a salted, stable, 64-bit pseudonym; `allow` has to be written down                          |
| `PULSE-10` | Volume — per-event rate limit with one summary line     | `[x]`  | `PULSE-1`      | A 10-record storm writes 3 and **one** `pulse.log.dropped` line per second with the counts; another event is unaffected              |
| `PULSE-11` | Dedup — `fingerprint` within a window                   | `[x]`  | `PULSE-4`      | Repeated identical errors collapse and are reported at `flush()` as `pulse.log.repeated` with `occurrences`                          |
| `PULSE-12` | Sinks — `stdout`, `memory`, `fanout`, fail-open         | `[x]`  | `PULSE-1`      | A sink receives a `SafeRecord`; a throwing sink is latched off, reported once, counted, and never reaches the caller                 |
| `PULSE-13` | Formats — `tsir`, `ecs`, `cloudwatch`, `otlp-json`      | `[x]`  | `PULSE-1`      | The mapping is asserted table-for-table; a driver never re-maps, so a new sink cannot re-implement redaction                         |
| `PULSE-14` | Metrics — counter, histogram, gauge + exporter          | `[x]`  | —              | OTel-shaped points; a counter cannot decrease; names are `_total`/unit-suffixed by kind; an exporter that throws is fail-open        |
| `PULSE-15` | Cardinality guard + route-template guard                | `[x]`  | `PULSE-14`     | A label past its budget drops the series and counts it; a concrete `route` becomes `[templated]`, warned once                        |
| `PULSE-16` | `traceparent` — parse, validate, format                 | `[x]`  | —              | Version `ff`, all-zero ids, wrong lengths and non-hex are all `undefined`; a future version with the same layout parses              |
| `PULSE-17` | Sampler — always, never, ratio, parent-based            | `[x]`  | `PULSE-16`     | Parent-based is the default and obeys a parent in **both** directions; a ratio outside 0…1 is a boot error                           |
| `PULSE-18` | Spans, `withSpan`, buffered exporter                    | `[x]`  | `PULSE-17`     | `end()` is idempotent; a child joins the trace and records `parentSpanId`; an unsampled span runs but is not exported                |
| `PULSE-19` | Health — `liveness` and `ready` with per-check timeouts | `[x]`  | —              | Liveness touches nothing; a non-critical failure is `degraded`/200, a critical one is `failed`/503; a hang is `reason: 'timeout'`    |
| `PULSE-20` | Type tests                                              | `[x]`  | `PULSE-1`…`19` | A sink cannot be given raw fields, `Redacted<T>` is not `T`, and the level/format unions are closed                                  |

## As built: `emit` cannot throw

The one invariant everything else is arranged around. `logger.info()` is a `void` statement in the
middle of business logic; if it can throw, a telemetry bug becomes a 500 in a request that had
already decided its answer. So:

- the **sink** is wrapped: a throw is reported through `onSinkError`, counted, and swallowed;
- the **redactor** is wrapped per field: a failing pattern writes `[redaction-error]` — refusing
  beats guessing, and a redaction bug must never be the reason a secret is written;
- the **clock** is injected (`() => number`), so a test never sleeps and a span's duration is an
  exact number;
- only `PULSE_CONFIG_INVALID` escapes, and only from a _configuration_ mistake (`level: 'verbose'`,
  `event: 'Invoice paid'`), because that one is worth failing loudly at boot.

## As built: redaction is three layers because each one alone has a hole

| Layer   | Catches                                                   | The hole it covers                                                |
| ------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| Typed   | `Redacted<T>` — a token the application passes on purpose | A heuristic cannot know that _this_ string is a credential        |
| Path    | `redact.paths: ['body.password', 'items[*].card']`        | A field whose **key** looks harmless (`body.pin`, `payload.iban`) |
| Pattern | `/(password                                               | secret                                                            | token | authorization | cookie | api[-_]?key | …)/i` and value shapes | A credential under an innocent key (`q: 'eyJhbGci…'`) |

The leak test is the one that matters: a synthetic object holding every secret kind goes through the
real logger, and the assertion is a byte scan of the output line. `OBS-007` is a release blocker for
the same reason — a log leak is not a bug you find in review.

PII is a **separate** policy, not part of the secret rules, because the failure modes differ: a
leaked secret is a breach, a leaked email is a GDPR finding, and an application may legitimately keep
one and not the other. Bare `name` is deliberately **not** in the PII key list — it is a route, a
channel and a metric far more often than it is a person; `fullName`/`firstName`/`lastName` are.

## As built: a summary line, not a summary per record

Two mechanisms, one shape: a storm must not become a storm of summaries.

- **Rate limit** — `perSecond` per _event name_ (default 1 000). Drops are counted per name, and one
  `pulse.log.dropped` line reports the counts **once per second**. Per name matters: a noisy event
  must not silence a quiet one, and `pulse.log.dropped` is exempt so it cannot drop itself.
- **Dedup** — the same `fingerprint` within `dedupeWindowMs` (default 10 s) collapses into
  `pulse.log.repeated` at `flush()`, with `occurrences`. `flush()` also forces the rate-limit
  summary, which is why it belongs at the end of an invocation (`waitUntil`, handler exit, Bun idle).

## As built: metrics are guarded twice

A metric label is a promise to a time-series database: every distinct value is a stored series,
forever. So `createMetrics` enforces two rules mechanically rather than documenting them:

- **A budget per label name** (`maxCardinality`, 10 000). Past it the series is dropped and
  `pulse_metric_cardinality_dropped_total` counts it. Ten thousand is the point where one careless
  `userId` label turns a dashboard into a bill.
- **`route` is a template.** `/api/users/123` and `/api/users/456` are one series; a concrete path is
  replaced with `[templated]`, warned about once. The heuristic is conservative: a template has `:`
  or `{}`, and `/api/users/me` is bounded, so it is not flagged.

Names are checked too, following Prometheus conventions: a **counter** ends `_total`, a
**histogram** carries its unit (`_ms`), a **gauge** is the quantity itself (`queue_depth`) — requiring
a suffix there would rename the metrics `§ 4` fixes. `METRIC_NAMES` lists those names so
instrumentation and dashboards cannot drift.

## As built: tracing is `traceparent`, a sampler and spans

- **A malformed `traceparent` is replaced, never forwarded** — version `ff`, an all-zero trace or span
  id, a wrong length or non-hex all produce a new trace. A future version with the same layout parses
  (W3C says to read the first 55 characters), which is why `01-…` is accepted and `ff-…` is not.
- **Sampling is parent-based by default and obeys the parent in both directions.** Respecting only
  the positive case is how a 10 % head sample becomes a 100 % tail in the next service.
- **An unsampled span still runs** — it is just not exported. A span that throws on sampling is a
  span nobody dares leave on.
- Attributes are OTel semantic conventions (`http.request.method`, `db.system`,
  `messaging.operation`), listed in `SPAN_ATTRIBUTES`; a custom one should be namespaced `tsir.…`.

## As built: health has three states, not two

`degraded` is what makes a readiness probe usable: a failing **optional** dependency (a cache, an
exporter) is not a reason to pull a healthy instance out of rotation, so it reports `degraded` and
keeps the `200`; a `critical: true` check failing is `failed`/`503`, with the failing checks named.
The declaration sits next to the check, where the person who knows the answer can see it.

Liveness never touches a dependency — a liveness probe that pings the database restarts every worker
during a database incident. Every readiness check runs under a timeout, and a check that hangs is
`failed` with `reason: 'timeout'` rather than a probe that outlives its own deadline.

## Files

| File             | What it is                                                                |
| ---------------- | ------------------------------------------------------------------------- |
| `src/errors.ts`  | `PULSE_*`: config invalid, sink failed, redaction failed, metric invalid  |
| `src/hash.ts`    | A synchronous SHA-256 for PII pseudonyms and fingerprints (vector-tested) |
| `src/redact.ts`  | The three layers, `PiiPolicy`, bounded traversal                          |
| `src/record.ts`  | Levels, `SafeRecord`, `serializeError`, `summarize`, `fingerprintOf`      |
| `src/formats.ts` | `tsir`, `ecs`, `cloudwatch`, `otlp-json`                                  |
| `src/limits.ts`  | The per-event, per-second limiter                                         |
| `src/sinks.ts`   | `stdout`, `memory`, `fanout` (fail-open, latched)                         |
| `src/logger.ts`  | `createLogger`, `child`, the summary logic, the two `error` shapes        |
| `src/metrics.ts` | Counter/histogram/gauge, exporter, cardinality and route guards           |
| `src/tracing.ts` | `traceparent`, samplers, spans, `withSpan`, buffered exporter             |
| `src/health.ts`  | Liveness, readiness, per-check timeouts, `toResponse`                     |
| `src/index.ts`   | The public surface                                                        |

## Why the SHA-256 is hand-written

`crypto.subtle.digest` is asynchronous and a log call cannot be: making every `logger.info()` await
would change every function signature in an application, or produce unhandled promises. So
`src/hash.ts` implements FIPS 180-4 § 6.2 — 70 lines, checked against the published vectors including
the million-`a` case — and is used **only** for pseudonymising PII and for stable fingerprints.
Passwords are hashed by `@tsir/auth` with WebCrypto, because a password hash must be slow and this
one is deliberately not.

## Tests

`redaction.test.ts` (SHA-256 vectors, the three layers, PII, bounds, hostile inputs),
`record.test.ts` (error normalisation, summaries, fingerprints, all four formats),
`logger.test.ts` (record shape, levels, context, the leak test, fail-open sinks, volume),
`metrics.test.ts` (three kinds, both guards, export), `tracing.test.ts` (`traceparent` matrix,
samplers, spans), `health.test.ts` (liveness, readiness, timeouts, `Response`) — **123 tests**.
`type-tests/pulse.types.ts` is compiled by `make typecheck`.

## Not built

- **Vendor transports.** `ecs` **mapping** ships because it is a rename table and it is what Kibana
  and OpenSearch need. The `opensearch`, `loki`, `cloudwatch-logs` and `otlp-http` **drivers** are
  protocols plus a `fetch` and are a later task; `13-observability.md § 2.4.6` explains why no SDK
  will be added alongside them.
- **Auto-instrumentation.** A span per HTTP request, DB query and queue publish belongs to the
  packages that own those operations (`@tsir/http`, `@tsir/database`, `@tsir/queue`), each taking an
  optional tracer. This package deliberately does not monkey-patch anything to get them.
- **A `Logger` contract in `@tsir/core`.** `OBS-001` said core would own the interface. Building it
  showed that nothing in core logs, and an interface in core would be a dependency on observability
  for packages that want none. The contract is **structural**: `@tsir/pulse` exports `Logger`, and a
  package that wants to log takes `Pick<Logger, 'warn' | 'error'>` (or its own three-method type).
