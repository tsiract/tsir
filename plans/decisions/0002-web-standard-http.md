# ADR-0002 — Web-Standard `Request`/`Response` HTTP Core with Runtime Adapters

- **Status:** Accepted
- **Date:** 2026-10-27
- **Affects:** `@tsir/http`, `@tsir/deploy`, `@tsir/link/rest`

---

## Context

Tsir must run on three structurally different targets:

| Target             | Native HTTP primitive                                                          | Node APIs available                                 |
| ------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------- |
| Bun                | `Bun.serve` / `fetch` handler with Web `Request`/`Response`                    | Almost all                                          |
| Cloudflare Workers | `fetch(request, env, ctx)` — Web standards only (plus `nodejs_compat` subset)  | Partial                                             |
| AWS Lambda         | API Gateway events (`APIGatewayProxyEventV2`) translated by us or by a library | Full Node, but the handler signature is event-based |

A core built on `node:http`'s `IncomingMessage`/`ServerResponse` would need an emulation layer on Workers (large, fragile) or a fork. A core built on Web standards needs a **translation** layer on Lambda (small, well-understood) and nothing at all on Bun/Workers.

## Decision

1. The HTTP pre-handler (`@tsir/http`) consumes a standard `Request` and returns a standard `Response`. Nothing else.
2. Runtime specifics live in adapters:
   - `@tsir/http/bun` — thin wrapper over `Bun.serve`.
   - `@tsir/deploy/cloudflare` — exports `fetch`, `queue`, `scheduled` from the unit.
   - `@tsir/deploy/lambda` — translates API Gateway v2 events ↔ `Request`/`Response`.
3. The core entrypoint of `@tsir/http` imports **no** `node:*` or `bun:*` module. Enforced by lint and a bundle test.
4. Anything that is genuinely unavailable on a target is declared through `RuntimeCapabilities` and fails at boot with `DPL_CAPABILITY_MISSING` — never at request time with a `TypeError`.

## Consequences

**Positive**

- One pipeline implementation, one test suite, identical semantics on three targets (conformance suite `DPL-024`).
- Bun and Workers need no translation at all — the common path is zero-overhead.
- Streaming request/response bodies work where the runtime supports them, with a documented buffering fallback on API Gateway.

**Negative / costs**

- Lambda adds a translation layer with edge cases: base64 bodies, multi-value headers, cookies, binary content types. These get a dedicated, heavily tested module.
- Web-standard `Request` cannot be constructed from a socket on Bun in the same way Node's streams can; Bun-specific features (e.g. `Bun.serve`'s `websocket` option) live in the adapter.
- `AbortSignal` support differs slightly (`request.signal` on Workers vs Bun); adapters normalize it.

## Alternatives considered

| Alternative                                 | Why rejected                                                                                                                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:http` core + Workers shim             | Large shim surface, high per-request overhead, constant breakage risk                                                                                                                                                              |
| Separate HTTP cores per target              | Three implementations, three bug surfaces, violates "predictable execution"                                                                                                                                                        |
| Adopt an existing server (Hono as the core) | Reasonable, but it would make a third-party router the framework's foundation and blur our metadata/compile model; we prefer explicit control over the request lifecycle. Re-evaluated only if our adapter burden proves too large |

## Revisit conditions

If Cloudflare or Lambda change their handler signatures, only the adapter changes; the decision itself stands.
