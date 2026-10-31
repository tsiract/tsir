# ADR-0004 — One `@tsir/link` Package with Per-Protocol Entrypoints

- **Status:** Accepted
- **Date:** 2026-10-27
- **Affects:** `@tsir/link`, `@tsir/deploy`, bundle budgets

---

## Context

The brief adds "known service-to-service invocation using REST API, SOAP API, gRPC, WebSocket." Four protocols, each with:

- a client and (for REST/SOAP/WS) a server side,
- different transport libraries (`fetch`, `@grpc/grpc-js`, `fast-xml-parser`, `WebSocket`),
- different error taxonomies (HTTP status, gRPC status codes, SOAP faults, WS close codes),
- different runtime support.

The obvious alternative is four packages: `@tsir/rest`, `@tsir/grpc`, `@tsir/soap`, `@tsir/ws`.

## Decision

Ship **one package, `@tsir/link`**, with subpath entrypoints:

```
@tsir/link          shared types: CallContext, CallResult, CallError, retry, breaker
@tsir/link/rest     fetch-based client; server helpers on @tsir/http
@tsir/link/grpc     @grpc/grpc-js client + server attach
@tsir/link/soap     WSDL-compiled client + server
@tsir/link/ws       WebSocket handlers + client with reconnect
```

Each subpath has an independent dependency closure enforced by a bundle test: importing `/soap` must not include gRPC.

## Rationale

Roughly 60–70 % of the code for these protocols is **shared and hard**: deadline propagation, cancellation, retry with idempotency awareness, circuit breaking, credential attachment, correlation/trace propagation, error normalization, metrics/spans. Four packages would mean four implementations of that core or a fifth "link-core" package that everything depends on anyway.

Shared core + thin protocol adapters also guarantees the promise from the brief: _the same `CallContext` behavior everywhere._

## Consequences

**Positive**

- One place to fix a retry bug; one conformance suite; one capability matrix.
- Subpath entrypoints avoid forcing unused dependencies on consumers.
- Cross-protocol features (fallback REST → gRPC, protocol-agnostic service clients) become natural instead of requiring glue.

**Negative / costs**

- One package with four heavy optional dependencies requires discipline in `exports`, peer dependencies, and bundle tests. gRPC and SOAP deps are optional and must be documented as required only when that subpath is imported.
- Version lockstep means a SOAP fix bumps the package version for everyone (acceptable at lockstep versions).

## Alternatives considered

| Alternative                           | Why rejected                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Four independent packages             | Duplicated core; inevitable drift in retry/timeout semantics                                              |
| Four packages + a shared core package | The core package would be an implementation detail with no independent users, i.e. artificial abstraction |
| One package, one entrypoint           | Would force gRPC and XML parsers into REST-only bundles                                                   |

## Revisit conditions

If SOAP or gRPC grows to a size where it clearly deserves independent release cadence, split it out with a new ADR — the shared core stays.
