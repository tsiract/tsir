# 04 — HTTP, Router & Validation

> `@tsir/router`, `@tsir/http`, `@tsir/validate`. One request path, compiled ahead of time, identical on every target.
>
> **Status (2026-10-29):** implemented, with two exceptions named below. Decorators, registry,
> matcher, compiler diagnostics, the pipeline, binders, guards, policies, problems, route codegen,
> OpenAPI document generation, response contracts, multipart and CORS denial semantics are all real
> and tested — a complete HTTP app bundles to 23.5 KiB without pulling zod.
>
> Not written: the serving half of OpenAPI (`/__tsir/openapi.json` in dev). `tsir openapi:generate`
> exists and builds the document to a file. Streaming request bodies landed: a route declared with
> `stream: true` hands the handler a size-limited `ReadableStream<Uint8Array>`. See
> [`tasks/03-http.md`](../tasks/03-http.md) § "Where Phase 2 actually stands".

---

## 1. The decorator correction (read this first)

The brief's illustrative API used **parameter decorators**:

```ts
@Get('/:id')
async findOne(@Param('id', IntParam) id: number): Promise<UserResponse>
```

Standard ECMAScript decorators — the model Tsir adopts ([ADR-0001](../decisions/0001-decorator-model.md)) — **only decorate classes, methods, accessors, and fields**. There are no parameter decorators. Legacy `experimentalDecorators` would provide them, but requires `emitDecoratorMetadata` for types and drags in a second, older semantics that conflicts with the rest of the toolchain.

Tsir therefore expresses argument binding as **route metadata**, which yields the same call signature and the same types:

```ts
// features/users/users.controller.ts
import { Controller, Get, Post, Route } from '@tsir/router';
import { IntParam } from '@tsir/http';

@Controller('/api/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Route({ method: 'GET', path: '/:id', params: { id: IntParam } })
  async findOne({ params }: Ctx<{ id: number }>): Promise<UserResponse> {
    return this.users.findOne(params.id);
  }

  @Route({ method: 'POST', path: '/', body: CreateUserSchema, status: 201 })
  async create({ body }: Ctx<never, CreateUserInput>): Promise<UserResponse> {
    return this.users.create(body);
  }
}

// sugar for the 90% case; compiles to exactly the same metadata
@Get('/:id', { params: { id: IntParam } })
async findOne({ params }: Ctx<{ id: number }>) { … }
```

Why this is not a downgrade:

| Concern                 | Result                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type safety             | `Ctx<Params, Body, Query, Headers>` computes each field from the schema's **output type**. `params.id` is `number`, not `string`.                                    |
| Explicit dependencies   | A handler declares exactly what it consumes. No hidden `req`/`res` objects, no ambient decorators to remember.                                                       |
| Compile-time checking   | `@Route`'s type parameter requires the handler's first argument to accept the schemas you declared. A mismatch is a type error, checked by `tsc -b` and a type test. |
| Multi-argument handlers | Supported when declared: `@Route({ args: ['params', 'body'] })`. Default is a single context object.                                                                 |
| Roadmap                 | `03-core.md` Q12 keeps the door open; if the ecosystem standardizes parameter decorators we revisit with an ADR.                                                     |

> **Rule:** the docs, generators, and frontpage must never show `@Param`-style parameter decorators as the primary API.

---

## 2. Package split

| Package          | Contents                                                                                                                | Runtime-neutral                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `@tsir/router`   | `Controller`, `@Route`/`@Get`/`@Post`/…, metadata registry, path matcher, compile-time codegen, route table types       | Yes                             |
| `@tsir/http`     | Pipeline, binders, middleware, guards, response serialization, problem responses, OpenAPI, Bun adapter (`/bun` subpath) | Yes (adapter subpaths excluded) |
| `@tsir/validate` | Standard Schema interop, `IntParam`/`UuidParam`/etc., `Issues` → problem mapping, multipart helpers                     | Yes                             |

`@tsir/http` core imports **no** `bun:*` and no `node:*`. The Bun adapter lives at `@tsir/http/bun`; Workers and Lambda adapters at `@tsir/deploy/{cloudflare,lambda}`.

---

## 3. Routing model

### 3.1 Declaration

```ts
export interface RouteMeta<
  P extends PathSchema | undefined = undefined,
  Q extends ObjectSchema | undefined = undefined,
  B extends ObjectSchema | undefined = undefined,
  H extends ObjectSchema | undefined = undefined,
> {
  readonly method: HttpMethod;
  readonly path: `/${string}`;
  readonly params?: P;
  readonly query?: Q;
  readonly body?: B;
  readonly headers?: H;
  /**
   * Defaults to **200**, always. The first draft defaulted a non-GET route with no
   * request-body schema to 204; implementation showed that conflates "accepts no
   * body" with "returns no body", and silently shipped a 204 for a `@Post` that
   * returns the created resource. A route that wants 204 declares it.
   */
  readonly status?:
    | 200
    | 201
    | 202
    | 204
    | 206
    | 300
    | 301
    | 302
    | 304
    | 400
    | 401
    | 403
    | 404
    | 409
    | 422
    | 429
    | 500
    | 502
    | 503;
  readonly guards?: readonly GuardToken[];
  readonly policies?: readonly PolicyRef[];
  readonly middleware?: readonly MiddlewareToken[];
  readonly consumes?: readonly ContentType[];
  readonly produces?: readonly ContentType[];
  readonly timeoutMs?: number;
  readonly operationId?: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
}
```

Decorators **write immutable metadata** to a process-local `MetadataRegistry` (a `Map` of class-level entries). Importing a controller module is the only side effect; controllers are never instantiated at import time.

### 3.2 Compilation

`tsir build` (and `tsir dev` in watch mode) runs the **route compiler**:

1. Discover `*.controller.ts` files under `config.http.roots`.
2. Import each (in a sandboxed module registry), read metadata, merge class + method level.
3. Validate: duplicate `method + path` → `RTR_DUPLICATE`; unresolvable binder token → `RTR_UNRESOLVED_TOKEN`; handler arity mismatch → `RTR_ARITY`; invalid status → `RTR_BAD_STATUS`; unassignable handler type → type error at build.
4. Sort deterministically (path specificity, then declaration order) and emit
   `src/routes.gen.ts` (implemented as `tsir route:compile`):

```ts
// AUTO-GENERATED by `tsir route:compile` — do not edit. Regenerate instead.
// app: http-example · routes: 4
import { defineRoute, type RouteEntry } from '@tsir/router';
import {
  CreateUser,
  UserIdParams,
  UserPage,
  UsersController,
} from './controllers/users.controller.ts';

export const routes: readonly RouteEntry[] = [
  defineRoute({
    method: 'POST',
    path: '/api/users',
    segments: ['api', 'users'],
    controller: UsersController,
    handler: 'create',
    meta: { method: 'POST', path: '/', body: CreateUser, status: 201, tags: ['users'] },
    middleware: [],
    guards: [],
    policies: [],
  }),
];
```

The file emits **source, not JSON**, because a route holds two things JSON cannot
carry: the controller class and the Standard Schema validators. Both are emitted
as imports. That imposes one convention, enforced by a diagnostic rather than a
docs page:

> **A validator used in route metadata must be exported by name** from the
> controller module or from a module that module imports. Otherwise the compiler
> cannot emit an import for it and stops with
> `route schema is not exported: UsersController uses a validator that no module exports`.

Discovery, for the same reason, requires controllers to be exported by name from
a file matching `paths.controllers` (default `**/*.controller.ts`).

**The generated file is committed.** It is imported by application code, so it
must exist for `tsc`, and committing it makes staleness visible: `tsir route:compile
--check` is part of `make check`, and `src/apps/http/test/app.test.ts`
asserts the generated table still equals a fresh `compileRoutes()` of the
registry. A generator that is only ever run locally drifts silently; this one
cannot.

Output contains no timestamp and no absolute path — the same input produces the
same bytes, so a recompile is a no-op rather than a diff.

Production `bootstrap` consumes `routes.gen.ts` (or the manifest's serialized form for edge bundles). No `reflect-metadata` is installed and no `design:type` is read anywhere, so routing never inspects decorator metadata: the generated table is the only routing input.

### 3.3 Matching

- Trie/segment matcher built once at boot; `O(segments)` per request, no regex per request.
- Static segments beat parameters; parameters beat wildcards; ties broken by explicit priority then declaration order.
- `405` emitted with an `Allow` header when the path matches but the method does not.
- Trailing-slash policy is configuration (`http.trailingSlash: 'strict' | 'ignore'`), default `strict`.
- Parameter names do not participate in matching, so `/users/:id` and `/users/:slug` are the same
  route and are rejected as `RTR_AMBIGUOUS` rather than resolved by declaration order.
- `HEAD` is served from the `GET` handler when no `HEAD` route exists, and the body is discarded by
  the adapter (RFC 9110 § 9.3.2). An explicit `HEAD` route always wins.
- Encoded path separators (`%2F`) are rejected as a bad request rather than decoded into a new
  segment boundary.

---

## 4. Request pipeline

```
adapter (Bun | Workers | Lambda)
  └─► createContext()         id, clock, signal, startedAt, logger, scope
  └─► matchRoute()            route table lookup
  └─► runGlobalMiddleware()   ordered, may short-circuit
  └─► runRouteMiddleware()
  └─► authenticate()          @tsir/auth, if a guard requires it
  └─► authorize()             @tsir/policy, if declared
  └─► bind()                  params, query, body, headers — validated
  └─► handler()               user code
  └─► serialize()             contract-typed response
  └─► finalize()              headers, correlation id, timing, telemetry
  ╰─► onError()               never throws; always produces a response
```

Guarantees:

- Handler errors are caught by exactly one boundary; `onError` itself is wrapped so a mapper bug cannot leak an unhandled rejection.
- Request body size limit (`http.maxBodyBytes`, default 1 MiB) enforced before parsing — streaming bodies are counted, not buffered blindly.
- Every stage is cancellable via `ctx.signal`; a client disconnect aborts the signal and downstream `@tsir/link` calls. Verified: aborting the request signal reaches the handler, and a 504 is returned even if the handler ignores the signal.
- Timeout: `route.timeoutMs ?? config.http.defaultTimeoutMs` (default 30 000). On expiry the handler's signal aborts and a `504` problem is returned if headers were not sent.

---

## 5. Bindings and their types

| Binder      | Source                  | Output type      | Notes                                                      |
| ----------- | ----------------------- | ---------------- | ---------------------------------------------------------- |
| `params`    | path segments           | schema output    | Params are strings; coercion must be explicit (`IntParam`) |
| `query`     | URL search params       | schema output    | Repeated keys → array only if schema says so               |
| `body`      | JSON / form / multipart | schema output    | Content-Type must match `consumes`; else `415`             |
| `headers`   | selected headers        | schema output    | Header names case-insensitive; values trimmed per RFC      |
| `ctx`       | request context         | `RequestContext` | id, logger, signal, clock, principal (if authenticated)    |
| `principal` | auth result             | `Principal<T>`   | Requires a guard declaring the principal type              |

`principal` is opt-in per route (`principal: true`) and the router refuses it
without a guard (`RTR_PRINCIPAL_WITHOUT_GUARD`), so a handler that binds it
cannot be reached unauthenticated. When a route does not declare it, the
property is absent from the argument rather than present and `undefined`.

Unknown-body-property policy is **per schema**, default `strip`, with `strict` available. The policy is recorded in the compiled route table and in OpenAPI (`additionalProperties: false`).

---

## 6. Responses

```ts
export interface ResponseContract<T> {
  readonly status: HttpStatus;
  readonly body?: Schema<T>;
  readonly headers?: Readonly<Record<string, Schema<unknown>>>;
}
```

Phase 2 ships the body half: `@Get('/', { response: UserSchema })` validates the
value a handler returned, in one of three modes (`http.responseValidation`):

| Mode     | Invalid response                                    | Use                                     |
| -------- | --------------------------------------------------- | --------------------------------------- |
| `dev`    | logged via `onInvalidResponse`, body passed through | default — catch drift, keep serving     |
| `always` | `500 HTP_RESPONSE_INVALID`                          | services whose contract outranks uptime |
| `never`  | not checked                                         | latency-critical routes                 |

Validation runs on the returned **value**, before serialization, so the error
names the field rather than a byte offset in JSON. A handler returning a
`Response` opts out: the framework cannot see inside it.

- Handlers may return the body directly (status from route metadata) or `{ status, body, headers }` for variants.
- Serialization validates **in development and test** by default (`http.validateResponses: 'dev' | 'always' | 'never'`), and in production with `always`. The default is `dev` because response validation costs CPU; production opt-in is documented per route.
- `undefined` vs `null`: `204` and `304` must return no body; returning a value with a no-body status is `HTP_BODY_NOT_ALLOWED` (a framework error, not a 500).
- Content negotiation: `Accept` is matched against `produces`; `406` when unsatisfiable. JSON is the default; `text/plain` and `application/octet-stream` supported; `text/xml` supplied by `@tsir/link/soap` when enabled.

### Error responses

RFC 9457 (`application/problem+json`):

```json
{
  "type": "https://tsir.dev/errors/validation",
  "title": "Request validation failed",
  "status": 422,
  "code": "HTP_VALIDATION_FAILED",
  "instance": "/api/users",
  "requestId": "01J9Z6…",
  "issues": [{ "path": ["email"], "code": "invalid_format", "message": "Expected a valid email" }]
}
```

## 7. Validation

- All validators implement **Standard Schema** (`~standard.validate`), so Zod 4 (default), Valibot, and ArkType work without adapter code ([ADR-0003](../decisions/0003-validation-library.md)).
- `@tsir/validate` ships: `IntParam`, `UuidParam`, `SlugParam`, `PageQuery`, `SortQuery`, `DateRange`, `Multipart`, `FileConstraints`. **Implemented today:** `IntParam`, `UuidParam`, `SlugParam`, `PageQuery`, `SortQuery`. `DateRange`, `Multipart`/`FileConstraints` are not written.
- A route's `query` schema is a **record of fields** (`z.object({...})`); the binder builds it from `URLSearchParams`, where repeated keys become arrays. `PageQuery` is therefore usable directly, while `SortQuery` is a _field_ helper (`z.object({ sort: SortQuery([...]) })` → `?sort=-createdAt`). A string-rooted query schema can never match and is rejected rather than silently 422ing forever.
- Conversion rules are explicit: strings stay strings unless the schema coerces. `IntParam` accepts `/^-?\d+$/` only (no `"1e3"`, no `" 3"`, no `0x10`).
- Multipart: streams to a temp buffer with size/count limits; `FileConstraints` validates MIME (sniffed, not trusted from header), extension allowlist, and byte length.
- Validation never mutates input objects; it returns new values (avoids surprising shared references).

---

## 8. Middleware, guards, policies

| Kind       | Signature                                      | Runs                             | Can abort                                            |
| ---------- | ---------------------------------------------- | -------------------------------- | ---------------------------------------------------- |
| Middleware | `(ctx, next) => Promise<Response \| void>`     | Global → route order             | Yes, by returning a `Response`                       |
| Guard      | `(ctx) => Promise<Principal \| null>`          | After middleware, before binders | Yes, by returning `null` → `401`                     |
| Policy     | `(ctx, resource, action) => Promise<Decision>` | After guard, before handler      | Yes → `403` with reason (audited when `audit: true`) |

- Ordering is **declared**, not inherited implicitly: global middleware list first (config order), then route metadata order.
- Guards return `Principal`, not a boolean — there is no "authenticated" flag floating in context.
- `Decision` is a discriminated union: `{ allowed: true } | { allowed: false; reason: string; audit?: true }`.
- Business-critical rules must be callable without HTTP: policies are registered in the container and can be invoked from services via `PolicyContext` (see `_capabilities.md`).

---

## 8.1 What the CLI exposes today

`tsir route:list` (RTR-010) loads the project, imports the app entry — which is
what registers controllers — compiles the table and prints it, either aligned for
humans or as versioned JSON:

```
  GET     /api/users/:id  200  UsersController.findOne  tags:users
  DELETE  /api/users/:id  204  UsersController.remove   tags:users
  GET     /api/users      200  UsersController.list     tags:users
  POST    /api/users      201  UsersController.create   tags:users
```

`--json` emits `{ schemaVersion: 1, count, routes[] }`; the deploy planner in
Phase 6 consumes exactly this shape, so it is versioned from the start. A table
that fails to compile prints the diagnostic (`RTR_DUPLICATE`, `RTR_AMBIGUOUS`, …)
and exits non-zero rather than printing a partial list.

`route:compile` — emitting `routes.gen.ts` so boot needs no registry at all — is
`RTR-007` and still open.

---

## 8.2 CORS

Opt-in, configured by `cors: { origins, credentials?, headers?, exposeHeaders?, methods?, maxAgeSeconds? }`.
Answered by the pipeline rather than by middleware, because a preflight
`OPTIONS` matches no route and must not run guards (browsers send no
credentials on it).

- Exact origins only, echoed back with `vary: Origin` — never a bare `*` on a
  response that depends on the request, which would poison shared caches.
- `origins: ['*']` with `credentials: true` is a **boot error**
  (`HTP_CORS_WILDCARD_CREDENTIALS`): browsers reject the combination, so the
  service would appear configured and silently fail.
- A denied origin gets a normal response without CORS headers, and a denied
  preflight gets `204` with no allow headers. Neither is a `403`: the browser
  must be able to tell "not allowed" from "authorisation failed".

### 8.3 Multipart bodies (VLD-006)

`consumes: ['multipart/form-data']` plus a body schema whose file fields use
`FileField()` from `@tsir/validate/http`:

```ts
@Post('/', {
  consumes: ['multipart/form-data'],
  body: z.object({ caption: z.string().optional(), image: FileField({ mimeTypes: ['image/png'], maxBytes: 262_144 }) }),
  multipart: { maxFileBytes: 262_144, maxFiles: 1 },
})
```

Three checks, in this order, because each protects the next:

1. **Size** — the whole body is counted before `formData()` parses it, so an
   oversize upload is a `413` and never an allocation. Per-file size and file
   count are route-level (`multipart: {...}`) for the same reason.
2. **Contents** — a file's first bytes are compared with its declared media
   type (`PNG`, `JPEG`, `GIF`, `WebP`, `PDF`, `ZIP`, `Ogg`, `MP3`). A mismatch
   is `422 HTP_MIME_MISMATCH` naming the field and both types. A file whose
   declared type is empty adopts the sniffed one; a format with no reliable
   signature (SVG, CSV, text) is trusted as declared — sniffing says nothing
   about formats it cannot recognise, and pretending otherwise would be theatre.
3. **Schema** — `FileField` enforces the declared types, size bounds and
   non-emptiness, exactly like every other field.

Sniffing is a signal, not a scanner. It answers "are these bytes plausibly a
PNG", not "is this file safe".

### 8.4 Deploy units (RTR-011)

Every route belongs to a **unit** — the deployable it ships in (`plans/modules/08-deploy.md`).
`@Controller('/', { unit: 'media' })` sets it for a controller, `{ unit: ... }` on
a single route overrides it, and the default is `http`. The unit is resolved once
at compile time into `route.meta.unit`, printed by `tsir route:list` when it is
not the default, included in `--json`, and carried into `routes.gen.ts`. Nothing
reads it per request.

### 8.4.1 AWS event listener decorators (`DPL-026`)

The router also declares non-HTTP event listeners that the deploy layer turns into
SNS subscriptions, EventBridge rules, and Step Functions tasks (`08-deploy.md § 1.2`).
They live on `@Controller` classes alongside routes:

```ts
@Controller()
class OrdersController {
  @OnSns({ topic: 'orders.created' }) // → unit 'sns'
  onOrderCreated(message: unknown) {}

  @OnEventBridge({ detailType: 'OrderShipped' }) // → unit 'schedule'
  onOrderShipped(detail: unknown) {}

  @OnStepTask({ name: 'process-refund' }) // → unit 'admin'
  processRefund(input: unknown) {}
}
```

Each decorator records a `DeclaredListener` on the controller entry (kind, name, unit,
optional `body` schema, handler). The deploy layer reads `registry.entries()` and folds
them into the unit graph: SNS → `sns` trigger, EventBridge → `eventbridge` trigger,
StepTask → `manual` trigger in `admin`. `collectListeners()` walks the prototype chain so
inherited listeners are not lost; coexist with route decorators on the same class.

### 8.5 Conformance suite (HTP-021)

ADR-0018 accepts that owning the router means owning its edge cases. `conformance.test.ts`
is that debt's ledger — 17 assertions covering static-beats-parameter,
`405` + `Allow` (with `HEAD` advertised), `404` for a strict trailing slash,
`400` for encoded separators and empty segments, decode-once path parameters,
`HEAD` with no body, request ids on errors, `406`/`415` negotiation, and unknown
methods. Three of those assertions failed when first written and changed the
implementation: strict trailing slash was a `400` (now `404`), `Allow` omitted
`HEAD` (now exact), and `consumes` without a body schema was not enforced.

---

### 8.6 Response contract helpers (VLD-009)

Route options for the response side, so status and schema cannot drift apart:

```ts
@Post('/', { ...created(UserSchema), body: CreateUser })   // 201 + validated body
@Get('/', { ...ok(UserList) })                             // 200 + validated body
@Delete('/:id', { ...noContent() })                        // 204, body forbidden
```

`contract({ status, body })` is the general form; `ok`, `created`, `accepted`
and `noContent` are the four that cover almost every route. They return _route
options_, not a runtime object, so there is no second serialization path — the
value a handler returns still goes through the same `serialize()`.

### 8.7 Authorization audit (HTP-011)

A policy returns a `Decision`. A denial is a `403` carrying the reason, and is
**always** audited; an allowed decision is audited only when the policy is
declared `audit: true`, because logging every successful read is how audit
trails become too expensive to keep.

```ts
readonly onAudit?: (event: AuditEvent) => void;

interface AuditEvent {
  event: 'authz.decision'; ts: number; requestId: string; route: string;
  method: HttpMethod; subject: string | null; resource: string; action: string;
  allowed: boolean; reason?: string;
}
```

The record is flat and queryable — the shape `plans/operations/13-observability.md § 2.4`
requires, so it can go to any sink driver unchanged.

### 8.8 No implicit coercion, enforced (VLD-007)

The rule is not documentation, it is `make coercion` (in `make check`). It scans
framework and application source for the three ways coercion sneaks in:

| Pattern                   | Why it is refused                 |
| ------------------------- | --------------------------------- |
| `z.coerce.*`              | accepts `"1e3"`, `" 3"`, `""`     |
| `parseInt` / `parseFloat` | prefix parsing: `"12abc"` → `12`  |
| `Number(x)` on a variable | `Number("")` is `0`, not an error |

A line may opt out with a `coercion-ok:` comment (on the line or the two above
it) that states _why_ it is safe. The eight existing sites are all either
regex-guarded transforms (`IntParam`, `PageQuery`, `env.int`), Bun's own version
string, or a `content-length` hint that can only reject earlier than the reader
already does. Each carries its justification in the source.

### 8.9 Negative matrix (VLD-010)

`validate/src/negative.test.ts` asserts _rejections_, with reasons, across the
inputs that defeat sloppy parsers: `4.2`, `1e3`, `" 3"`, `"3 "`, `0x10`, `""`,
`+3`, unicode digits, `1,000`, `null`, `undefined`, booleans, arrays, objects,
unsafe integers, `page=0`, `perPage` above the cap, unknown sort fields, missing
keys, and wrong types. It also pins the normalization contract — every failure is
a `{ path, message, code }` triple, never a throw.

One case is deliberately _not_ a rejection: a validator that throws propagates.
A broken validator is a server bug; calling it a `422` would hand the client an
error they cannot fix. The pipeline answers `500` and logs it.

---

### 8.10 Typing the handler (RTR-004)

A method decorator cannot change a method's signature — ECMAScript decorators
return a function of the same type — so `@Get('/', { body: CreateUser })` cannot
make TypeScript infer `args.body`. Parameter decorators would allow it, and are
excluded (ADR-0001).

The route is therefore declared as a `satisfies` value, and the handler's
argument type is derived from it:

```ts
const createUser = { params: UserIdParams, body: CreateUser, status: 201 } satisfies RouteOptions;

@Post('/:id', createUser)
create(args: RouteArgs<typeof createUser>): unknown {
  return { id: args.params.id, name: args.body.name }; // both typed
}
```

One declaration drives runtime validation _and_ compile-time types, so the two
cannot disagree. `RouteArgs<O>` also carries `ctx`, and adds `principal` only
when the options say `principal: true` — the same condition the router enforces
at compile time. A `satisfies` typo (`statsu:`) fails the build before a test
runs, and the inference itself is asserted by `route-args.test.ts`, whose
type-level `Equals` checks fail `tsc` if `RouteArgs` degrades to `unknown`.

## 9. OpenAPI

- Generated from the compiled route table + schemas (via `z.toJSONSchema`) — never from decorators at runtime.
- OpenAPI 3.1 output; `operationId` defaults to `controllerName.method`; stable and used by client generators.
- Emitted by `tsir openapi:generate --out openapi.json` and served in dev at `/__tsir/openapi.json` (disabled in production by default).
- A CI test validates the document against the OpenAPI 3.1 schema and fails on unresolved `$ref`.

### 9.1 What is implemented

`createOpenApiDocument(table, options)` in `@tsir/http/openapi`. The document is a pure function of
the compiled table, so it is byte-identical across runs and safe to diff in CI.

Decisions worth recording, each made while building it:

| Decision                                      | Why                                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A **separate entry point** (`/openapi`)       | Schema conversion needs Zod. `@tsir/http` bundles without it (23.5 KiB, `ZodError` forbidden); only apps that publish a spec pay — 70.2 KiB measured.    |
| Schemas described at `io: 'input'`            | The document describes what a **client sends**. `IntParam` becomes `type: string, pattern: ^-?\d+$`, not `integer`: `4.0` and `4e3` really are rejected. |
| A non-object query schema is a **hard error** | The binder hands the query schema a record, so a string-rooted schema always 422s. Failing generation beats publishing a broken endpoint.                |
| `params` schema must match the path exactly   | A bound param the path lacks, or a path param with no schema, is an application bug — surfaced at generation time with the route named.                  |
| Responses carry **no schema**                 | Handlers declare none yet. The response description says so; an empty `{}` schema would be a plausible-looking lie.                                      |
| `4XX`/`5XX` → shared `Problem` component      | Every failure already speaks RFC 9457 problem+json, so it is referenced rather than restated per operation.                                              |
| `*` catch-all → `{wildcard}` path param       | OpenAPI has no catch-all; a required string parameter with a description is the closest honest spelling.                                                 |

Validation evidence: a generated document for a five-controller fixture (`users` list/get/create/
patch/delete, `search`, wildcard `files`) validates against the OpenAPI **3.1** meta-schema with
`@seriousme/openapi-schema-validator` (`valid: true`, `version: 3.1`). That validator is not a
repository dependency; it runs as a one-off check, so the dependency policy is untouched.

A snapshot of the output lives at [`openapi.example.json`](../../openapi.example.json) — regenerate it
by running the same fixture through `createOpenApiDocument`; it is a snapshot, not a source of truth.

Still absent: the `tsir openapi:generate` command, the dev-only `/__tsir/openapi.json` route,
response contracts, and a CI job that re-runs the meta-schema check on every commit (the validator
is a one-off, deliberately outside the dependency policy).

---

## 10. Failure modes

| Code                         | Status     | Cause                        | Client sees                        |
| ---------------------------- | ---------- | ---------------------------- | ---------------------------------- |
| `HTP_ROUTE_NOT_FOUND`        | 404        | No match                     | problem+json                       |
| `HTP_METHOD_NOT_ALLOWED`     | 405        | Path matched, method not     | `Allow` header                     |
| `HTP_UNSUPPORTED_MEDIA_TYPE` | 415        | Body with wrong content type | problem+json                       |
| `HTP_BODY_TOO_LARGE`         | 413        | Exceeds `maxBodyBytes`       | problem+json                       |
| `HTP_VALIDATION_FAILED`      | 422        | Schema rejection             | `issues[]`                         |
| `HTP_UNAUTHENTICATED`        | 401        | Guard returned null          | `WWW-Authenticate`                 |
| `HTP_FORBIDDEN`              | 403        | Policy denied                | reason (if `exposeReasons`)        |
| `HTP_NOT_ACCEPTABLE`         | 406        | No `produces` match          | problem+json                       |
| `HTP_TIMEOUT`                | 504        | Route timeout                | problem+json                       |
| `HTP_CLIENT_CLOSED`          | —          | Aborted                      | no response; logged                |
| `HTP_HANDLER_ERROR`          | 500        | Uncaught                     | generic problem+json + `requestId` |
| `RTR_DUPLICATE`              | boot fail  | Two routes same method+path  | dev report                         |
| `RTR_ARITY`                  | build fail | Handler signature mismatch   | tsc error + report                 |

---

## 11. Security considerations

- Header and body size limits enforced before allocation-intensive parsing; JSON depth limited (`http.maxJsonDepth`, default 32) to resist nesting bombs.
- Prototype-pollution guard on parsed JSON objects (`__proto__`, `constructor` keys rejected) before schema validation.
- `X-Forwarded-For`/`Forwarded` trusted only from configured proxies (`http.trustedProxies`); otherwise the socket address is used.
- CORS is opt-in and explicit (`http.cors.origins` allowlist); wildcard with credentials is a boot error.
- Problem responses never echo input values that failed validation beyond a short, length-capped excerpt for `path` pointers.
- Method-override headers are not supported (explicitly rejected) to keep method semantics honest.

---

## 11.1 Open questions owned by this document

| #   | Question                                                                        | Status                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q35 | Do we offer a `zod/mini` entry to cut the ~82 KiB validator payload on Workers? | **Decided, shipped** — `@tsir/validate/mini` re-exports `zod/mini`; `@tsir/config` is built on it. Measured: config-only 75,151 → 21,457 B, Workers handler 104,402 → 38,812 B. See ADR-0013. |

---

## 12. Task index

[`tasks/03-http.md`](../tasks/03-http.md) — `VLD-001` … `VLD-010`, `RTR-001` … `RTR-012`, `HTP-001` … `HTP-020`.
