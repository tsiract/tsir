# Tasks — Link (Phase 5)

> REST, gRPC, SOAP, WebSocket — clients and servers over a shared `CallContext`.

**Plan:** [`../07-link.md`](../modules/07-link.md)

---

## Shared core

| ID        | Title                                                 | Status | Depends | Acceptance criteria (summary)                                    |
| --------- | ----------------------------------------------------- | ------ | ------- | ---------------------------------------------------------------- |
| `LNK-001` | `CallContext`, `CallResult`, `CallError` types        | `[x]`  | —       | `CallResult` exhaustively narrows; no throwing for remote errors |
| `LNK-002` | Deadline → per-protocol deadline conversion           | `[x]`  | LNK-001 | Expired ctx aborts before any I/O                                |
| `LNK-003` | Cancellation composition (`ctx.signal` + timeout)     | `[x]`  | LNK-002 | Both sources abort the underlying call                           |
| `LNK-004` | Retry policy (idempotency-aware, jitter, budget)      | `[x]`  | LNK-001 | Non-idempotent without key → no retry (test)                     |
| `LNK-005` | Circuit breaker per target host                       | `[x]`  | LNK-004 | Half-open probe; no leaked timers on shutdown                    |
| `LNK-006` | Trace/log propagation (`traceparent`, correlation id) | `[x]`  | LNK-001 | Outbound headers asserted                                        |
| `LNK-007` | `ServiceCredentialProvider` + `CallMeta.credentialId` | `[x]`  | LNK-001 | Secret never logged                                              |
| `LNK-008` | Error-kind normalization table (all protocols)        | `[x]`  | LNK-001 | Table test covers every mapping                                  |

## REST

| ID        | Title                                      | Status | Depends | Acceptance criteria (summary)                   |
| --------- | ------------------------------------------ | ------ | ------- | ----------------------------------------------- |
| `LNK-009` | `createRestClient` (fetch-based)           | `[x]`  | LNK-004 | Request/response schema validation before/after |
| `LNK-010` | `Idempotency-Key` support                  | `[x]`  | LNK-009 | Retries allowed only with key or safe method    |
| `LNK-011` | Response size limits + content-type checks | `[x]`  | LNK-009 | Oversize → `LNK_PROTOCOL`                       |

## gRPC

| ID        | Title                                                | Status | Depends | Acceptance criteria (summary)                     |
| --------- | ---------------------------------------------------- | ------ | ------- | ------------------------------------------------- |
| `LNK-012` | `buf generate` pipeline → committed `.ts` contracts  | `[x]`  | LNK-001 | No runtime reflection; generated files lint-clean |
| `LNK-013` | `createGrpcClient` (mTLS, deadlines, status mapping) | `[x]`  | LNK-012 | Conformance test against local server             |
| `LNK-014` | `attachGrpcServer`                                   | `[x]`  | LNK-012 | Same auth/policy principals as HTTP               |
| `LNK-015` | Workers limitation + capability probe                | `[x]`  | DPL-003 | Boot fails with matrix row on Workers             |

## SOAP

| ID        | Title                                        | Status | Depends | Acceptance criteria (summary)                     |
| --------- | -------------------------------------------- | ------ | ------- | ------------------------------------------------- |
| `LNK-016` | `tsir link:soap:gen` WSDL → typed operations | `[x]`  | LNK-001 | Generated types compile; no WSDL fetch at runtime |
| `LNK-017` | `createSoapClient` (1.1/1.2, fault mapping)  | `[x]`  | LNK-016 | Faults → `LNK_SOAP_FAULT` with mapped kind        |
| `LNK-018` | XML hardening (XXE, DTD, entity expansion)   | `[x]`  | LNK-017 | Negative tests for each attack class              |
| `LNK-019` | WS-Security username token (TLS-protected)   | `[x]`  | LNK-017 | Digest + plaintext-over-TLS tested                |
| `LNK-020` | SOAP server on `@tsir/http` (`text/xml`)     | `[x]`  | HTP-018 | WSDL-served document validates                    |

## WebSocket

| ID        | Title                                                   | Status | Depends | Acceptance criteria (summary)             |
| --------- | ------------------------------------------------------- | ------ | ------- | ----------------------------------------- |
| `LNK-021` | `defineWsHandler` + per-frame schema validation         | `[x]`  | LNK-001 | Malformed frame → close 1008              |
| `LNK-022` | `createWsClient` (reconnect, backoff, no silent replay) | `[x]`  | LNK-021 | Backoff jitter; at-most-once documented   |
| `LNK-023` | Heartbeat, idle timeout, backpressure close (1013)      | `[x]`  | LNK-021 | Load test asserts close codes             |
| `LNK-024` | Graceful drain (1001 with reason)                       | `[x]`  | LNK-021 | In-flight messages flushed before close   |
| `LNK-025` | Durable Objects room model (Workers)                    | `[x]`  | DPL-010 | Cross-instance fan-out via DO, documented |

---

## Gate P5 checklist

- [x] Capability matrix (`07-link.md § 8`) asserted by a test: `capability.test.ts` checks
      that a ❌ for Workers is a refusal in code and that every ✅ entrypoint imports no
      `node:`/`bun:` module (the deploy half is `DPL-LNK`, phase 6).
- [x] Conformance suite runs per protocol per target: `conformance.test.ts` runs the same
      four scenarios against REST, gRPC and SOAP.
- [x] Retry/cancellation semantics identical across protocols: same file — dead context
      makes zero transport calls, an idempotent call spends the budget, an unsafe call does
      not, and "unavailable" is `unavailable` everywhere.
- [x] SOAP XML hardening negative tests green: `xml.test.ts` (DTD, XXE, billion laughs,
      bare `&`, NUL reference, depth, bytes, nodes).
- [x] No credential material in logs (LNK-007): `CallMeta` carries `credentialId` only, and
      `redactCredential` is the only projection that exists (`propagation.test.ts`).

---

## Status notes (2026-10-28)

**Done:** `LNK-001` … `LNK-025` — shared core, REST, gRPC, SOAP (client, code generation,
WS-Security and server), WebSocket, and rooms. The one inversion of the plan's dependency
graph: `LNK-025` shipped before `DPL-010`, because the room model is written against the
_shape_ of the Durable Object API rather than its types (ADR-0025). What is left for
`DPL-010` is the deployment half — the binding, the exported class, the `migrations` entry
— which is exactly what belongs to `@tsir/deploy`.

223 tests across 17 files; the package sits in the coverage gate at 94.0 % lines and
94.7 % functions. `tsir link:soap:gen` is covered by `soap-gen.test.ts`, which proves the
committed `tax.gen.ts` is byte-identical to a fresh compile, so `--check` is a real gate.

Choices worth knowing before continuing:

- **Transports are injected, never imported.** `RestClientOptions.deps` takes `fetch` /
  `now` / `sleep` / `random`; `WsClientOptions.deps` takes `connect` / `now` / `sleep` /
  `random`; the WS handler takes a `sink`. Every test but one is a scripted exchange; the
  exception opens one real `Bun.serve` socket to prove the default `connect` path.
- **A non-2xx that is not a SOAP envelope is an HTTP failure.** A gateway answering 503
  with an HTML page used to be a `LNK_PROTOCOL`; it now maps through `kindForHttpStatus`, so
  it is `unavailable` and retryable. A 2xx that is not an envelope stays a protocol failure.
- **A room is a coordinator, not a registry.** `createRoom` fans out through the runtime's
  own socket list, tagged `room:<id>`; per-connection state lives in the socket attachment,
  so hibernation costs nothing. The room's frame contract reuses the codes `defineWsHandler`
  already closes with (`1008`/`1009`/`1011`), and an unauthenticated upgrade is a `401` with
  no socket at all rather than a socket closed immediately.
- **The coercion guard caught the last two `Number(...)` calls in the new code**
  (`Content-Length`, `maxOccurs`); both now go through `parseDecimal`, which is the same
  rule the SOAP decoder follows (VLD-007).
- **Retry defaults to `NO_RETRY`; WebSocket defaults to no replay.** A send while the
  socket is closed fails with `LNK_WS_CLOSED` — nothing is queued and nothing is re-sent
  after a reconnect. That is the at-most-once promise `plans/modules/07-link.md § 6` asks for.
- **WebSocket servers reject the handshake, they do not open-then-close**: an
  `authenticate` returning `undefined` closes with `1008` before a session exists.
- **Frame sizes are counted in bytes** (`TextEncoder`), not UTF-16 code units — a 40-char
  frame of `é` is 80 bytes and a limit expressed in bytes must see 80.
- **`CallError` gained an optional `message`** — one framework-authored line for
  operators, safe to log. `kind`/`code`/`retryable` still carry the branching contract.
- **Bun's `toThrow` also passes when a function _returns_ an error**, so assertions on
  framework error builders use the returned value, and rejections are captured explicitly.

**Next:** `LNK-012` (`buf generate` → committed `.ts` contracts). The blocker is gone:
[ADR-0022](../decisions/0022-subpath-dependency-scope.md) lets a dependency be scoped to a
subpath entrypoint, and `make deps` now proves it from the import graph
(`src/tools/import-graph.ts`, `src/tools/dependency-policy.ts`). Adding
`@grpc/grpc-js` with `scope: ['@tsir/link/grpc']` is a policy entry, not an exception —
followed by the bundle proof in `verify-dist` that ADR-0022 § _not enforced here_ asks for.
