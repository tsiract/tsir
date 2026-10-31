# ADR-0018 — HTTP layer: own the router and the pipeline, interoperate at the fetch boundary

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related:** [ADR-0002](./0002-web-standard-http.md) (web-standard HTTP core), [ADR-0001](./0001-decorator-model.md) (decorator model), [ADR-0012](./0012-dependency-policy.md) (dependency policy)

## Context

The question was whether `@tsir/http` should be built on Hono, on another
existing router, or stay ours. It is a fair question: `@tsir/validate` is
deliberately a thin layer over Zod ([ADR-0010](./0010-validate-is-a-thin-wrapper.md)),
and the project prefers extending established libraries over reinventing them.

But "extend an established library" applies when the library solves a generic
problem behind a thin seam. It does not apply when the library's model _is_ the
model being built. `@tsir/http` does not parse HTTP — the runtime does that —
it owns **routing and the request pipeline**, which is where this framework's
semantics live: decorator registration, compile-time diagnostics, constructor
DI, typed `Ctx<P, B, Q, H>` and `RTR-007` codegen.

The decision was taken on measurements rather than preference. All sizes are
browser-target, minified, `Bun.build` — the same harness as `make verify-dist`.
Hono 4.13.14, resolved 2026-10-28.

| Probe                                                | Size          |
| ---------------------------------------------------- | ------------- |
| Hono/tiny, two routes, no framework concerns         | 11.9 KiB      |
| Hono/tiny + request id + 404/500 problem responses   | 12.2 KiB      |
| **`@tsir/http` complete app**                        | **23.5 KiB**  |
| Hono/tiny + `@hono/zod-validator` + Zod (parity app) | 95.0 KiB      |
| **`@tsir/http` + Zod full**                          | **102.0 KiB** |
| **`@tsir/http` + `zod/mini`**                        | **37.9 KiB**  |

Cost at the floor is ~11 KiB; the gap is under 7 % once validation is included,
and the `zod/mini` path ships a validated edge app at a third of the Hono+Zod
equivalent. Size is not an argument for switching.

Behaviour differs in kind, not degree. Same three probes against both:

| Behaviour                         | Hono                      | `@tsir/http`                         |
| --------------------------------- | ------------------------- | ------------------------------------ |
| `POST` to a `GET`-only route      | 404, no `Allow`           | **405 + `allow: GET, HEAD`**         |
| Same method+path registered twice | keeps the first, silently | **`RTR_DUPLICATE`, at compile time** |
| `/users/:id` and `/users/:slug`   | keeps the first, silently | **`RTR_AMBIGUOUS`, at compile time** |

## Decision

**The router, the matcher and the request pipeline stay inside the framework.
Third-party HTTP code is accepted only at the `(Request) => Response` boundary.**

Adopting Hono as the core was rejected on four counts:

1. **Two contexts.** Hono's `c.req` / `c.set` / `c.json` would sit beside the
   typed `Ctx` derived from the route's schemas. Maintaining both is the
   NestJS-on-Express adapter problem, and its failure mode — middleware mutating
   a context the types cannot see — is exactly what this framework exists to
   remove.
2. **DI collapses into a service locator.** Hono has no container; the idiom is
   `c.set('db', db)`. Constructor injection would have to be re-imposed on top
   of the thing that replaced it.
3. **`RTR-007` becomes impossible.** `routes.gen.ts` emits a compiled table so
   boot performs no reflection. Hono apps are constructed imperatively at import
   time; there is no table to emit.
4. **The pipeline gets rewritten anyway.** The 12.2 KiB parity probe above is
   request ids, problem responses and method handling — the same code that would
   have to be written inside `onError` and middleware. That is not a saving, it
   is the same work plus a dependency.

**Interop is a supported surface.** `createFetchHandler` takes a `Request` and
returns a `Response`; the same signature is what Workers, Lambda, Bun and a Hono
middleware all speak. Any third-party HTTP code can therefore run inside a
single Tsir route, wrap the handler, or be mounted as a sub-app, without
adopting Hono's router, context or DI. If a capability proves genuinely
expensive to own (three or more middleware of real complexity), it is vendored
at that seam — one file, attributable, deletable — before the core is replaced.

## Consequences

- `@tsir/http` and `@tsir/router` carry no HTTP runtime dependency. The only
  runtime dependency in the workspace stays `zod`.
- We own the middleware catalogue. CORS is partial today (`HTP-019`), CSRF,
  compression, ETag/304 and JWKS are not built. Each is ~150 lines against the
  standard `Request`/`Response` and is tracked in `plans/tasks/03-http.md`.
- We own runtime adapters. `bun.ts` exists; `aws-lambda` and
  `cloudflare-workers` land in Phase 6 with the deploy work.
- The conformance risk — edge cases a mature router has already absorbed — is
  owned by `HTP-021` (protocol conformance suite): HEAD fallback, `405` +
  `Allow`, trailing slash, `%2F` in segments, repeated keys, content
  negotiation, `304`/`ETag`, oversized bodies.
- **Revisit trigger:** if two of {CSRF, compression, JWT/JWKS, ETag/304,
  body streaming} cannot be justified as roughly 150 lines each, the third-party
  implementation is vendored at the fetch boundary. Replacing the router itself
  is the last resort, not the first.

## Alternatives

| Option                      | Outcome                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Hono as core**            | Best fit for a framework without a decorator model. Here it doubles the context model and blocks codegen.                     |
| **Hono for middleware**     | Rejected: middleware never ships without a router in practice; the seam rule covers the real need.                            |
| **Elysia**                  | Bun-first by design, conflicts with Workers/Lambda first-class; its typing assumes its own schema layer, not Standard Schema. |
| **Fastify / Koa / Express** | Bound to `node:http`; fails the edge target.                                                                                  |
| **itty-router / worktop**   | Small, but no compile-time diagnostics; guards, policies, timeouts and error mapping would be rebuilt.                        |
| **oRPC / tRPC**             | RPC semantics, not REST; wrong shape for a general backend framework.                                                         |
