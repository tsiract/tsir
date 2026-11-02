# Tasks — HTTP (Phase 2)

> Router metadata → compiled routes → request pipeline → validated responses.

**Plan:** [`../04-http.md`](../modules/04-http.md)

---

## Router (`@tsir/router`)

| ID        | Title                                                                                             | Status | Depends | Acceptance criteria (summary)                                               |
| --------- | ------------------------------------------------------------------------------------------------- | ------ | ------- | --------------------------------------------------------------------------- |
| `RTR-001` | `MetadataRegistry` (immutable entries, no class mutation)                                         | `[x]`  | CTN-001 | Decorating a class leaves the class untouched (test)                        |
| `RTR-002` | `@Controller(path, { unit?, ... })`                                                               | `[x]`  | RTR-001 | Class-level metadata readable from registry                                 |
| `RTR-003` | `@Route({...})` + sugar `@Get/@Post/@Put/@Patch/@Delete/@Head/@Options`                           | `[x]`  | RTR-002 | Sugar produces identical metadata to `@Route`                               |
| `RTR-004` | Type-safe route metadata (`RouteMeta` generics)                                                   | `[x]`  | RTR-003 | `RouteArgs<typeof options>` types the handler; decorators cannot (ADR-0001) |
| `RTR-005` | Path parser + segment model                                                                       | `[x]`  | RTR-003 | Reserved chars rejected; `:id` params extracted                             |
| `RTR-006` | Matcher (trie, static > param > wildcard)                                                         | `[x]`  | RTR-005 | 10k-route benchmark < 2 µs/match                                            |
| `RTR-007` | Compiler: discovery → validation → `routes.gen.ts`                                                | `[x]`  | RTR-006 | Deterministic output (same input → same bytes)                              |
| `RTR-008` | Compile-time diagnostics (`RTR_DUPLICATE`, `RTR_ARITY`, `RTR_UNRESOLVED_TOKEN`, `RTR_BAD_STATUS`) | `[x]`  | RTR-007 | Each has a failing fixture                                                  |
| `RTR-009` | Route registry type consumed by bootstrap                                                         | `[x]`  | RTR-007 | Runtime boot reads data only                                                |
| `RTR-010` | `tsir route:list` / `route:compile` integration                                                   | `[x]`  | RTR-007 | CLI prints table; `--json` schema stable                                    |
| `RTR-011` | Unit attribution (`unit` metadata, default `http`)                                                | `[x]`  | RTR-002 | Feeds the deploy unit graph                                                 |
| `RTR-012` | Trailing-slash policy                                                                             | `[x]`  | RTR-006 | `strict` → `/x` and `/x/` differ; `ignore` → same                           |

---

## HTTP lifecycle (`@tsir/http`)

| ID        | Title                                                      | Status | Depends | Acceptance criteria (summary)                                                  |
| --------- | ---------------------------------------------------------- | ------ | ------- | ------------------------------------------------------------------------------ |
| `HTP-001` | Web-standard handler core (`Request → Response`)           | `[x]`  | RTR-009 | No `node:`/`bun:` imports in core entry                                        |
| `HTP-002` | Bun adapter (`@tsir/http/bun`)                             | `[x]`  | HTP-001 | `Bun.serve` integration; identical conformance suite                           |
| `HTP-003` | Request context (id, clock, signal, logger, startedAt)     | `[x]`  | HTP-001 | Context available in middleware and handler                                    |
| `HTP-004` | Binder: `params`                                           | `[x]`  | VLD-001 | Schema output types flow to handler (`number` for `IntParam`)                  |
| `HTP-005` | Binder: `query`                                            | `[x]`  | VLD-001 | Repeated keys only arrays when schema says so                                  |
| `HTP-006` | Binder: `body` (JSON) with content-type enforcement        | `[x]`  | VLD-002 | Wrong CT → 415; malformed JSON → 400 problem                                   |
| `HTP-007` | Binder: `headers` (case-insensitive, trimmed)              | `[x]`  | VLD-001 | Case-insensitive lookup test                                                   |
| `HTP-008` | Binder: `ctx` and `principal`                              | `[x]`  | HTP-003 | `principal` requires guard; otherwise boot error                               |
| `HTP-009` | Middleware runner (global then route order)                | `[x]`  | HTP-003 | Order assertion test; short-circuit works                                      |
| `HTP-010` | Guards → `Principal \| null`                               | `[x]`  | HTP-008 | `null` → 401 with `WWW-Authenticate` (added `authChallenge`, default `Bearer`) |
| `HTP-011` | Policies → `Decision`                                      | `[x]`  | HTP-010 | Denied → 403; `audit: true` emits audit event                                  |
| `HTP-012` | Response serialization + status contract                   | `[x]`  | HTP-001 | Body on 204 → `HTP_BODY_NOT_ALLOWED`                                           |
| `HTP-013` | Response validation modes (`dev`/`always`/`never`)         | `[x]`  | HTP-012 | Mode respected; invalid response in `always` → 500 + log                       |
| `HTP-014` | RFC 9457 problem responses (`issues[]`, `requestId`)       | `[x]`  | ERR-006 | Snapshot test of each error                                                    |
| `HTP-015` | Timeouts + `AbortSignal` composition                       | `[x]`  | HTP-003 | Handler continues? No — signal aborted, 504 returned                           |
| `HTP-016` | Client disconnect → abort                                  | `[x]`  | HTP-015 | Downstream link call cancelled (test)                                          |
| `HTP-017` | Body limits + JSON depth limit + prototype-pollution guard | `[x]`  | HTP-006 | 413 / `HTP_BODY_TOO_DEEP` / `__proto__` rejected                               |
| `HTP-018` | Content negotiation + `406`                                | `[x]`  | HTP-012 | `Accept: application/xml` on JSON route → 406                                  |
| `HTP-019` | CORS (opt-in allowlist)                                    | `[x]`  | HTP-009 | Wildcard+credentials → boot error                                              |
| `HTP-021` | Protocol conformance suite (ADR-0018)                      | `[x]`  | HTP-009 | HEAD fallback, 405+`Allow`, trailing slash, `%2F`, repeated keys               |
| `HTP-020` | OpenAPI 3.1 generation + validation test                   | `[x]`  | RTR-007 | Document validates; `operationId` stable                                       |

---

## Validation (`@tsir/validate`)

| ID        | Title                                                     | Status | Depends          | Acceptance criteria (summary)                      |
| --------- | --------------------------------------------------------- | ------ | ---------------- | -------------------------------------------------- |
| `VLD-001` | Standard Schema adapter (Zod 4 first)                     | `[x]`  | —                | Zod/Valibot/ArkType all accepted via one interface |
| `VLD-002` | `Issues` normalization                                    | `[x]`  | VLD-001          | Path arrays stable across validators               |
| `VLD-003` | Param schemas: `IntParam`, `UuidParam`, `SlugParam`       | `[x]`  | VLD-001          | `"1e3"`, `" 3"`, `"0x10"` rejected                 |
| `VLD-004` | Query helpers: `PageQuery`, `SortQuery`, `DateRange`      | `[x]`  | VLD-001          | Max page size enforced; impossible dates rejected  |
| `VLD-005` | Unknown-key policy (`strip` default, `strict` opt-in)     | `[x]`  | VLD-001          | Policy reported in OpenAPI `additionalProperties`  |
| `VLD-006` | Multipart + `FileConstraints` (sniffed MIME, size, count) | `[x]`  | VLD-001          | Oversize → 413; MIME mismatch → 422                |
| `VLD-007` | No implicit coercion audit                                | `[x]`  | VLD-001          | Numeric strings not coerced without `z.coerce`     |
| `VLD-008` | `issues[]` → problem mapping                              | `[x]`  | VLD-002, HTP-014 | 422 body snapshot                                  |
| `VLD-009` | Response schema helpers                                   | `[x]`  | VLD-001          | Reused by HTP-013                                  |
| `VLD-010` | Coverage + negative matrix                                | `[x]`  | VLD-001…009      | Meets `12-testing.md § 7`                          |

---

## Gate P2 checklist

- [x] All binders typed and validated end to end — `params`/`query`/`body`/`headers`, 422 with `issues[]`.
- [x] `routes.gen.ts` compiled; boot performs zero reflection (APP-011). The HTTP example boots from
      the generated table; the decorator registry is a compile-time input only, and no `reflect-metadata`
      is installed anywhere in the workspace.
- [x] Errors 404/405/415/422/413/406/504/500 covered by integration tests.
- [x] OpenAPI document validates — generated from the table and checked against the 3.1 meta-schema. Serving it in dev at `/__tsir/openapi.json` is still missing (the `tsir openapi:generate` command does not exist).
- [x] Middleware/guard/policy order asserted.
- [x] `HTP-001` core has zero runtime-specific imports (lint-enforced, `check-boundaries`).

### Where Phase 2 actually stands

Landed: decorators, registry, path validation, trie matcher with backtracking, compile-time
diagnostics, response serialization, RFC 9457 problems, binders, middleware, guards, policies,
timeouts, body/JSON-depth/pollution guards, content negotiation, the Bun adapter, and the
`@tsir/validate/http` helpers.

Landed since this paragraph was first written, and now closed: route codegen (`routes.gen.ts`),
OpenAPI document generation (`@tsir/http/openapi`), response contracts and their validation
(`VLD-009`, `HTP-013`), multipart uploads (`VLD-006`), `tsir route:list`, audit events on denied
policies (`HTP-011`), and CORS _denial_ semantics (`HTP_CORS_WILDCARD_CREDENTIALS`).

Still not landed, and the only reason the gate above stays qualified:

- **OpenAPI served in dev.** `tsir openapi:generate` builds the document to a file (DXS-011), and
  the library asserts it against the meta-schema, but `/__tsir/openapi.json` is not yet served by
  the dev server.

Streaming request bodies landed (`meta.stream: true` hands the handler a size-limited
`ReadableStream<Uint8Array>`; the limit is enforced mid-stream and a 413 is returned).

Measured cost: a complete HTTP app (decorators + table + matcher + pipeline) bundles to
**23.5 KiB** on a browser target, and **does not pull zod** — a probe asserts `ZodError` is absent.
