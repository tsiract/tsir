# 00 — Foundation

> What Tsir is, what it refuses to be, and the vocabulary used across every other plan.

---

## 1. Product thesis

Tsir is a **strictly typed, backend-only TypeScript framework** for Bun and Cloudflare Workers, built on Drizzle ORM, with decorator-driven routing and explicit constructor-based dependency injection. **D1 is the default database engine**; Postgres is a fully supported alternative driver (ADR-0016).

It exists because two things are simultaneously true in the TypeScript ecosystem:

1. Node/Bun backend tooling has matured enough that a cohesive framework is realistic (types, ORM, runtime performance, edge deployment).
2. The frameworks that offer cohesion usually buy it with implicit resolution — global containers, magic discovery on every request, unstructured stringly-typed config, and frontend concerns welded into the server.

Tsir takes the _cohesion_ and rejects the _implicitness_. The intended user is a senior engineer who wants to know, at review time and at 3 a.m., exactly which code runs for a request, which key encrypted a column, and which process will restart a failed job.

### 1.1 Three promises

| Promise                            | How it is kept mechanically                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Predictable execution**          | Routes, providers, listeners, and jobs are compiled into immutable registries at build/boot. Production requests never trigger discovery.                            |
| **Correctness over convenience**   | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; every trust boundary validated at runtime; no silent fallback on missing dependencies.         |
| **One application, many surfaces** | One `tsir.js` describes http, console, and deploy units. The same handler code runs on `bun`, Cloudflare Workers, and AWS Lambda through adapters, not conditionals. |

### 1.2 Explicitly not the thesis

- Not a beginner framework. Documentation assumes HTTP, SQL, and DI literacy.
- Not a full-stack framework. No view layer, no SSR, no browser bundling.
- Not a competitor to Drizzle. Tsir _wraps_ Drizzle's ergonomics; it does not re-skin the query builder.
- Not a PaaS. Deploy support means _generating first-class artifacts_ for Cloudflare and AWS, not hosting them.
- Not a claim machine. No "blazing fast", no "most secure" until benchmarks and security review exist (`SEC`, `DOC` tasks).

---

## 2. Principles, mapped to enforcement

The brief's core principles are architectural requirements, so each has an enforcement mechanism. A principle without enforcement is a slogan.

| #   | Principle                                      | Enforced by                                                                                                                                                                                       |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Type safety first                              | `tsconfig.base.json` flags; `tsc -b` in CI; ban on `any` via lint; type-level tests in `@tsir/testing`                                                                                            |
| 2   | Standard TypeScript, not a dialect             | No custom transformer, no macro system, no `emitDecoratorMetadata` dependency ([ADR-0001](../decisions/0001-decorator-model.md))                                                                  |
| 3   | Compile-time guarantees before runtime guesses | Build-time route/registry compilation (`tsir build`, `tsir route:compile`); bootstrap validation                                                                                                  |
| 4   | Decorators for declarative metadata only       | Decorators write to a `MetadataRegistry`; they never patch classes or wrap methods at runtime                                                                                                     |
| 5   | Constructor injection, no facades              | Container resolves only at defined boundaries; `resolve()` is not exported for app code paths                                                                                                     |
| 6   | Explicit boundaries                            | Untrusted input typed `unknown`; `@tsir/validate` at the boundary; explicit transactions via `withTransaction`                                                                                    |
| 7   | Drizzle is the ORM                             | `@tsir/database` exposes Drizzle instances and types; it defines no independent model layer                                                                                                       |
| 8   | Bun-native tooling                             | `bun test`, Bun workspaces, `Bun.serve`, Bun as the dev runner; Node compat only where a deploy target forces it                                                                                  |
| 9   | Backend only                                   | No frontend packages in `src/framework/*`; the frontpage is static HTML with zero runtime framework                                                                                               |
| 10  | Established libraries                          | Zod, Drizzle, `postgres.js`, `@grpc/grpc-js`, `fast-xml-parser` — with an ADR per choice and an exit path                                                                                         |
| 11  | No excess abstraction                          | Every package must own a distinct boundary; a package with one trivial export is merged or deleted                                                                                                |
| 12  | Modular ecosystem                              | Optional modules are peer-dependency-based; `@tsir/core` + `@tsir/http` must run with nothing else installed                                                                                      |
| 13  | A modular monolith, not a pile of folders      | One module owns its routes, providers and unit (`routeModule`); `make modules` rejects cross-module internals; extraction is a `tsir.js` topology change ([16](../architecture/16-modularity.md)) |

---

## 3. Glossary

Precise words prevent sloppy architecture. These terms are used with exactly these meanings everywhere.

| Term               | Meaning                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Application**    | The instantiated Tsir runtime: config + container + registries + lifecycle state. One per process (or per isolate).                                                                                                                                                                         |
| **Module**         | A declared unit of ownership: providers, routes, listeners, jobs, migrations, and lifecycle hooks, with an explicit `name`. Its routes live in its own registry and it may deploy as its own `unit`; other modules may only import its `index.ts` ([16](../architecture/16-modularity.md)). |
| **Provider**       | A container registration `{ token, lifetime, factory \| class, deps }`. The only way to obtain a dependency.                                                                                                                                                                                |
| **Token**          | A branded, typed key identifying a provider (`Token<UserRepository>`). Strings are permitted only as `Symbol`-backed constants declared centrally.                                                                                                                                          |
| **Contract**       | An interface describing a collaborator's behavior (`UserRepository`). Concrete classes are bound to contracts at composition time.                                                                                                                                                          |
| **Binder**         | Metadata describing how a request field becomes a method argument: `Param`, `Query`, `Body`, `Header`, `Ctx`, `Principal`.                                                                                                                                                                  |
| **Route registry** | The immutable, compiled list of `{ method, path, matcher, handler, binders, guards, policies, schemas }` entries.                                                                                                                                                                           |
| **Unit**           | A deployable function of the application: `http`, `ws`, `queue`, `schedule`, `console`. Units are the deploy topology's atoms.                                                                                                                                                              |
| **Target**         | A deploy destination: `bun`, `cloudflare`, `lambda`.                                                                                                                                                                                                                                        |
| **Topology**       | How units map onto targets: `separate` (default) or `single`.                                                                                                                                                                                                                               |
| **Envelope**       | The versioned ciphertext wrapper in `@tsir/vault`: identifies algorithm, key id, nonce, and tag.                                                                                                                                                                                            |
| **Keyring**        | The manifest of key ids and their rotation states (`staged` → `active` → `decrypt-only` → `retired`).                                                                                                                                                                                       |
| **Trust boundary** | A point where data changes from untrusted to trusted: HTTP body/params/headers, env vars, queue payloads, decrypted values, upstream service responses.                                                                                                                                     |
| **Bootstrap**      | The single function that loads config, validates it, builds the container, compiles registries, and returns a runnable app.                                                                                                                                                                 |
| **Public surface** | A module's `index.ts`: everything another module is allowed to import. Reaching past it is a `make modules` failure, not a code-review preference.                                                                                                                                          |
| **Seam**           | A boundary designed to be cut: module → deploy unit, in-process call → contract or event. A seam is only real if cutting it needs no code change.                                                                                                                                           |
| **Governed file**  | A file Tsir generates and may rewrite (`tsir.js` managed regions, deploy manifests) — always with markers, never silently.                                                                                                                                                                  |

---

## 4. Quality bars

These are the thresholds a module must clear before it is marked complete. They are qualitative on purpose; the quantitative ones live in the module plan.

| Dimension       | Bar                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Correctness** | Every documented behavior has a test; every failure mode has a negative test.                                                                                       |
| **Typing**      | Public API has explicit return types; no `any` in public signatures; type-level tests for generic relationships (binders → handler arity, config → typed accessor). |
| **Errors**      | Every error is a `TsirError` with `code`, `kind`, `message`, and a remediation hint. No bare `throw new Error("...")` in framework code.                            |
| **Lifecycle**   | Every resource acquisition has a matching disposal registered on the app; shutdown is bounded by a timeout.                                                         |
| **Docs**        | One page per package: install, minimal example, failure modes, security notes.                                                                                      |
| **Performance** | No reflection or full-registry scan per request; benchmarks committed for router matching, validation, encryption round-trip, and cold start.                       |

---

## 5. Risk register

| Risk                                                                                                         | Impact                                         | Mitigation                                                                                                                                                              | Owner |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Standard decorators cannot express parameter decorators, forcing an ergonomic change to the illustrative API | High — it changes the developer-facing surface | [ADR-0001](../decisions/0001-decorator-model.md) fixes the model now; binder metadata reproduces the same call shape; documented in `04-http.md`                        | RTR   |
| Edge runtimes lack Node APIs the framework assumes (`fs`, `net`, `async_hooks`)                              | High — would fork the codebase                 | Web-standard `Request`/`Response` core ([ADR-0002](../decisions/0002-web-standard-http.md)); capability probes at bootstrap; explicit `UnsupportedRuntimeFeature` error | DPL   |
| gRPC cannot run natively on Cloudflare Workers                                                               | Medium                                         | Documented capability matrix; Connect protocol fallback in `@tsir/link/grpc`                                                                                            | LNK   |
| Cryptography mistakes during rotation                                                                        | High — data loss or exposure                   | Versioned envelope, key id in payload, fail-closed tests, resumable batch job, runbook in `06-vault.md`                                                                 | VLT   |
| Package sprawl (24 packages) slows delivery and confuses users                                               | Medium                                         | Merge rule in `02-monorepo.md`; optional packages are peer-dep gated; only Phase 1–4 packages exist until Phase 5                                                       | FND   |
| Drizzle API churn breaks the wrapper                                                                         | Medium                                         | Thin surface, no query-builder reimplementation, single integration point                                                                                               | DB    |
| Scope creep from "Laravel parity"                                                                            | High                                           | Roadmap gates; capabilities are opt-in and may be deferred (`[–]` marker)                                                                                               | all   |

---

## 6. Open questions

Tracked here until an ADR resolves them. Blocking questions are marked.

| #   | Question                                                                                                            | Status                                                                                                                                 | Blocks |
| --- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Q1  | Do we ship an official Bun compile step for single-binary apps (`bun build --compile`) or leave it to users?        | Open                                                                                                                                   | DPL    |
| Q2  | Is `@tsir/validate` a wrapper package at all, or just a re-export of the Standard Schema adapter?                   | Open — leaning "thin wrapper that adds `HttpProblem` mapping"                                                                          | VLD    |
| Q3  | Session storage backend for auth on edge runtimes: Postgres vs KV vs Durable Object?                                | Open                                                                                                                                   | CAP    |
| Q4  | Does SOAP support include WS-Security, or is transport security considered out of scope?                            | Open                                                                                                                                   | LNK    |
| Q5  | Do we adopt a docs framework for `src/docs`, or keep it as static HTML built by the same pipeline as the frontpage? | Open                                                                                                                                   | DOC    |
| Q6  | Minimum Bun version: pin to an LTS-ish floor (1.2) or track latest?                                                 | Open — leaning floor 1.2 with CI on latest                                                                                             | FND    |
| Q7  | Do we publish the `@tsir` npm scope immediately or keep it private until Phase 4?                                   | Open — name/trademark availability check still required (`DOC-015`). Licensing itself is settled: **MIT** (`LICENSE`, `make license`). | DOC    |

---

## 7. Task index

| Task        | Description        | Phase |
| ----------- | ------------------ | ----- |
| `FND-001` … | Repo, tooling, CI  | 1     |
| `SEC-001` … | Threat model       | 1     |
| `DOC-001` … | Docs site skeleton | 6     |

See [`tasks/`](../tasks/README.md) for the full list.
