# Tasks — `@tsir/telemetry` (Phase 10)

> Telescope-style request logging and Horizon-style queue monitoring. The package already records
> HTTP requests (method, path, status, duration, principal) and tracks queue jobs (counts by state,
> list, detail, retry, dead-letter). The remaining work is the deeper Telescope-style tracing:
> failed-job detail, exception tracking, and cache/DB/mail/notification event capture.
>
> **Plan:** [`13-observability.md`](../operations/13-observability.md) · **Related:**
> [`queue.md`](./queue.md) (queue monitor), [`pulse.md`](./pulse.md) (logging primitives).

**Status: in progress.** Request logging and queue monitoring are complete. Four features remain:
failed-job detail, exception tracking, and cache/DB/mail event capture.

## Tasks

| ID      | Task                                                          | Status | Depends           | Acceptance                                                                                                                      |
| ------- | ------------------------------------------------------------- | ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `TEL-1` | `createRequestLogger` — method/path/status/duration/principal | `[x]`  | —                 | Every recorded row is queryable; duration is wall-clock; a principal is redacted before storage                                 |
| `TEL-2` | `requestLogs` table + DDL                                     | `[x]`  | `TEL-1`           | `requestLogTableDdl` prints exactly the columns the logger queries                                                              |
| `TEL-3` | `createQueueMonitor` — counts/list/detail/retry               | `[x]`  | —                 | `countsByState`, `list`, `get`, `retry`; a retry re-dispatches the job through the queue                                        |
| `TEL-4` | `queueJobs` / `queueDead` tables + DDL                        | `[x]`  | `TEL-3`           | Dead-letter rows are never auto-deleted; a retry moves a row back to `queueJobs`                                                |
| `TEL-5` | Failed-job detail — full payload + error + stack trace        | `[ ]`  | `TEL-3`           | A failed job stores the serialized payload, the error code, and the stack trace (redacted); `get(deadId)` returns them          |
| `TEL-6` | Exception tracking — `createExceptionTracker`                 | `[ ]`  | `TEL-1`           | Records `{ type, message, stack, context, occurredAt }`; `list`/`get`; redacts secrets in the stack via `@tsir/pulse` redaction |
| `TEL-7` | Cache event tracking — hits, misses, writes, deletes          | `[ ]`  | `TEL-1`, cache    | A `cacheEventSink` records `{ key, event, latencyMs, store }`; wired into `@tsir/cache` observers; queryable by key/time range  |
| `TEL-8` | DB query tracking — slow queries, errors                      | `[ ]`  | `TEL-1`, database | Records `{ sql, durationMs, rows, error }` for queries above a threshold; `@tsir/database` provides a hook                      |
| `TEL-9` | Mail/notification tracking — sent/failed deliveries           | `[ ]`  | `TEL-1`, mail     | Records `{ channel, recipient, event, error }` for mail and notification sends; queryable                                       |

## Design notes

**Event sinks, not interceptors.** Each tracker is a sink that `@tsir/cache`, `@tsir/database`, and
`@tsir/mail` call when something notable happens. The alternative — monkey-patching drivers — is
fragile and couples telemetry to driver internals. A sink is a tiny interface each package already
has the hook for (or needs a one-line addition).

**Redaction is the rule.** Exception stacks, query parameters, and mail recipients may carry
secrets. Every tracker routes through `@tsir/pulse`'s redaction before storage, so a Telescope-like
view never leaks a token or a password reset link.

**Failed-job detail is opt-in per job.** Storing the full payload of every failed job is a privacy
footgun. Jobs declare `storePayloadOnFailure: true` (or a redaction function); the default stores
only the error and the job name.

**What the gates check.** `bun test src/framework/telemetry` covers the request logger and queue
monitor. The remaining trackers are verified against in-memory stores with redaction assertions.
