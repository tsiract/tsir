# 07 — Link: Service-to-Service Invocation

> `@tsir/link` — one package, four protocol entrypoints, one `CallContext`. Typed clients and servers for REST, gRPC, SOAP, and WebSocket, with an explicit capability matrix per deploy target.

---

## 1. Why one package, four entrypoints

The brief calls for REST, SOAP, gRPC, and WebSocket support. These are four _protocols_, not four products. Everything that makes service-to-service calls hard is shared:

- deadline propagation and cancellation,
- retry policy that must know idempotency,
- correlation/trace propagation,
- credential attachment (service identity),
- circuit breaking and concurrency limits,
- typed error normalization across wildly different wire errors,
- observability (one span per call).

Splitting into four packages would duplicate all of that four times. Instead ([ADR-0004](../decisions/0004-link-package-shape.md)):

```ts
import { createRestClient } from '@tsir/link/rest'; // fetch-based; works everywhere
import { createGrpcClient } from '@tsir/link/grpc'; // @grpc/grpc-js (Bun/Node only)
import { createSoapClient } from '@tsir/link/soap'; // XML + WSDL-generated types
import { createWsClient, defineWsHandler } from '@tsir/link/ws';
import type { CallContext, CallError } from '@tsir/link';
```

Each subpath has an **independent** dependency closure. Importing `/soap` must not pull `@grpc/grpc-js` or the XML parser into a gRPC-only bundle. Enforced by bundle-budget tests.

---

## 2. Shared contract

```ts
export interface CallContext {
  readonly traceId: string;
  readonly correlationId: string;
  readonly deadline?: Date; // absolute; converted to per-protocol deadline
  readonly signal: AbortSignal; // composition of caller + deadline
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials?: ServiceCredential; // see § 7
  readonly idempotencyKey?: string; // enables retry for non-idempotent ops
}

export type CallResult<T> =
  | { readonly ok: true; readonly value: T; readonly meta: CallMeta }
  | { readonly ok: false; readonly error: CallError };

export type CallErrorKind =
  | 'unavailable'
  | 'timeout'
  | 'cancelled'
  | 'unauthenticated'
  | 'permission_denied'
  | 'invalid_argument'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'protocol'
  | 'server'
  | 'unknown';

export interface CallError {
  readonly kind: CallErrorKind;
  readonly code: string; // protocol-specific code, normalized
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly cause?: unknown; // preserved, never crosses process boundary
}
```

Rules:

- **All** link calls return `CallResult`, never throw for expected failures (transport exhaustion, remote 4xx/5xx, protocol errors). Programming errors (bad schema, missing config) throw `TsirError` — a bug is not a call failure.
- `CallErrorKind` is the only thing application code should branch on; `code` is for logs and specific handling.
- Every call emits exactly one client span and one metric (`link_calls_total{protocol,target,kind,status}`).

---

## 3. REST

```ts
const billing = createRestClient({
  baseUrl: config.services.billingUrl,
  retry: { attempts: 3, backoff: 'exponential', jitter: true, on: ['unavailable', 'rate_limited'] },
  timeoutMs: 2_000,
  defaultHeaders: { accept: 'application/json' },
});

const result = await billing.call({
  method: 'POST',
  path: '/invoices',
  body: CreateInvoiceSchema, // validated before send, and response validated after
  response: InvoiceSchema,
  ctx,
});
```

- Built on global `fetch` → works on Bun, Workers, Lambda.
- Deadlines → `AbortSignal.timeout` composed with `ctx.signal`; **cancellation propagates** end to end.
- Retries only for idempotent methods or when `idempotencyKey` is present (sent as `Idempotency-Key`).
- Optional circuit breaker (per target host) — half-open probe, bounded state, no timers leaked on shutdown.
- Server side: Tsir's own `@tsir/http` is the reference implementation; nothing REST-specific is invented here.

---

## 4. gRPC

```ts
const inventory = await createGrpcClient({
  address: config.services.inventory,
  service: InventoryServiceDefinition, // generated .ts from .proto via buf, committed
  tls: { mode: 'mtls', ca, cert, key },
  ctx,
});

const res = await inventory.checkAvailability({ sku: 'A-1', qty: 2 }, ctx);
```

| Decision       | Choice                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Transport      | `@grpc/grpc-js` (pure JS, Bun-compatible) — **not** `grpc-native`                                                                        |
| Codegen        | `buf generate` producing committed `.ts` types + descriptors; Tsir does **not** reflect at runtime                                       |
| Server         | `@tsir/link/grpc` provides `attachGrpcServer(app, definition)` mounting handlers compiled from the same route-like metadata              |
| Deadlines      | gRPC `deadline` derived from `ctx.deadline`; server honours cancellation                                                                 |
| Status mapping | gRPC status ↔ `CallErrorKind` and ↔ HTTP problem codes (one table, tested)                                                               |
| Reflection API | Disabled by default in production; enabled only with explicit config                                                                     |
| Workers        | **Not supported** (`@grpc/grpc-js` requires Node sockets). Documented limitation; `Connect`-protocol variant planned (`LNK-Q` follow-up) |

---

### 4.1 As built (2026-10-28)

`src/proto/` holds the contract, `buf.gen.yaml` runs `protoc-gen-es` into
`src/framework/link/src/contracts/**`, and the generated file is **committed**. `make
proto` regenerates it; `make proto-check` regenerates into a temp directory and diffs, so a
stale contract fails a build rather than shipping. `buf lint` runs first — with three RPC
naming rules disabled and a comment saying why (`Order` is the wire type for reads, streams
and writes; wrapping it in `GetOrderResponse` would add a layer nothing dereferences).

The adapter consumes the generated descriptor as **data**: `serviceDefinitionFrom()` maps
`methodKind`, input and output descriptors onto the `@grpc/grpc-js` service shape, so a
client and a server built from the same file cannot disagree about a message type. There is
no `.proto` parsing and no reflection at runtime — a pod never reads a descriptor file.

Client (`createGrpcClient`): deadlines from `ctx.deadline`, cancellation wired to
`ClientUnaryCall.cancel()`, `traceparent`/`x-correlation-id` and credential headers as
metadata, `Retry-After` trailers honoured, breaker optional. gRPC has no safe-method
concept, so retry eligibility is **declared**: `{ idempotent: true }` on a read, or an
`idempotencyKey` on the context for a write. Server (`attachGrpcServer`): unary and
server-streaming handlers, `authenticate(metadata, path)` returning a principal or
`UNAUTHENTICATED`, one `onCall` event per handled RPC. Client-streaming and bidi RPCs are
refused with a clear error — they are not in the phase's task list and a half-supported
stream shape is worse than an honest refusal.

`grpcSupported()` / `assertGrpcSupported()` implement `LNK-015`: `@grpc/grpc-js` needs
Node's `http2`, so a Workers build fails at construction with `LNK_GRPC_UNAVAILABLE` and
the matrix row in the hint, instead of failing inside the transport on the first call.

Measured by `make verify-dist`: the contract + client bundle is **495.8 KiB** for a Node
target (grpc-js's HTTP/2 + HPACK stack and the protobuf runtime), and a REST-only bundle
is **13.1 KiB with no gRPC runtime in it at all** — ADR-0022's companion proof.

---

## 5. SOAP

Legacy and enterprise integration is a first-class requirement, not an afterthought.

```ts
const svc = createSoapClient({
  wsdl: './contracts/tax.wsdl', // resolved at build time, compiled to types
  endpoint: config.services.taxEndpoint,
  soapVersion: '1.2',
  security: { mode: 'wsse-username-token', username, password }, // secrets from vault
  ctx,
});

const res = await svc.call('GetTaxRate', { country: 'SG', category: 'digital' });
```

- **Build-time WSDL compilation** (`tsir link:soap:gen`) → `contracts/tax.gen.ts` with operation names, request/response types, and XSD-derived TypeScript. Production performs no WSDL fetch or XSD traversal.
- XML parsing with `fast-xml-parser` (explicit config: no attributes auto-merge, XXE hardened, entity expansion disabled, DTD rejected).
- SOAP Faults → `CallError` with `kind` derived from `faultcode` mapping (configurable per contract) and `code` from `faultstring`.
- WS-Security: username-token (plaintext-over-TLS and digest), and X.509 signing only if a vetted implementation is adopted — **no hand-rolled XML canonicalization** (`SEC` review required before enabling).
- Attachments (MTOM/Swagger) — out of scope for v1, documented.
- Server side: `createSoapServer` mounts WSDL-backed handlers on `@tsir/http` with `text/xml` content negotiation.

---

### 5.1 As built — XML layer and client (2026-10-28)

`LNK-017` and `LNK-018` are implemented; `LNK-016` (WSDL compiler), `LNK-019`
(WS-Security) and `LNK-020` (server) are not, and the plan's list is now one item
shorter: XML parsing is **not** `fast-xml-parser`.

`@tsir/link/soap` ships a bounded reader (`src/framework/link/src/xml.ts`, ADR-0023) that
refuses `<!DOCTYPE>`, entity declarations and conditional sections at the first `<!`, so
XXE and entity expansion are impossible rather than disabled. The negative matrix is the
deliverable: `xml.test.ts` carries the billion-laughs payload, an external-entity
reference, a bare `&`, a NUL character reference, depth and byte ceilings — each asserted
to _fail_, with the code (`XML_UNSAFE`, `XML_MALFORMED`, `XML_TOO_LARGE`) mapping onto
`LNK_PROTOCOL` at the client boundary.

`createSoapClient` speaks 1.1 and 1.2 from the same descriptor. The version decides the
envelope namespace, the media type (`text/xml` vs `application/soap+xml; action=…`) and
where the action travels (`SOAPAction` header only in 1.1 — sending both is what produces
"wrong version" errors). A response is parsed before its HTTP status is believed: SOAP puts
faults in a 500 body, so a `Fault` element is classified by `faultcode`/`Code/Value`
through `kindForSoapFault()` and surfaced as `LNK_SOAP_FAULT` with the service's own words
in `message`. § 9's kind is what decides retryability, and a fault's `<detail><retryAfter>`
becomes `retryAfterMs`.

Two decisions worth recording:

- **Operations are data.** `{ operation, namespace, action, encode?, decode? }` — nothing
  reads a WSDL at runtime, so a cold start never fetches a contract. `LNK-016` will emit
  these descriptors at build time; until then an operation that needs a shape supplies
  `encode`/`decode`, and the default is a plain record (strings all the way down, VLD-007).
- **Retry is a claim the caller makes.** SOAP is POST, so `decideRetry` refuses to replay
  without `{ idempotent: true }` — the same rule gRPC uses, because neither protocol has a
  safe-method concept to read.

Measured by `make verify-dist`: a SOAP client bundles for Workers in **19.3 KiB with no
`node:` imports**, which is the matrix row (§ 8) made executable.

---

### 5.2 As built — code generation, security and server (2026-10-28)

`LNK-016`, `LNK-019` and `LNK-020` close the SOAP entrypoint.

**`tsir link:soap:gen`** compiles a document/literal WSDL into a committed `.gen.ts`
module: interfaces for the elements, a `SoapFieldShape` table per element, and an
`operations` record that `createSoapClient` takes directly. `--check` recompiles in memory
and fails the build when the module and the WSDL disagree, so the contract cannot drift
quietly. The compiler refuses what it cannot model and says which line it refused: RPC
style, `wsdl:import`, `xsd:include`, `choice`, attributes and substitution groups all
produce warnings, never a guess. Enumerations become literal unions, `minOccurs="0"`
becomes optional, `maxOccurs>1` becomes an array, and one level of nesting is compiled.

The runtime half is two functions, `shapeToXml` and `shapeFromXml`, plus a decimal parser
that accepts `-?\d+(\.\d+)?` and nothing else — `Number("1e9")` is how a tax rate becomes a
billion. A response with an undeclared field, a repeated field the schema allows once, or a
number that is not a number is a `LNK_PROTOCOL` failure naming the field.

**WS-Security** is `UsernameToken` in both modes. `PasswordDigest` is
`Base64(SHA-1(nonce ‖ created ‖ password))`, pinned in tests against a vector computed with
`node:crypto` rather than by the function under test. Verification enforces a freshness
window (5 minutes, 1 minute of skew), refuses a digest without `Nonce`/`Created`, compares
with a length-safe loop, and answers a wrong password and an unknown user with the same
message — an authentication oracle is a user-enumeration bug. `PasswordText` is accepted
only when the deployment says so (`modes: ['digest']` refuses it). X.509 signing remains
out of scope pending the security review § 5 requires.

**`createSoapHandler`** is a `Request → Response` function, so it composes with
`@tsir/http`'s adapter, a Lambda handler or `Bun.serve` without knowing about any of them.
It checks the envelope and its namespace, dispatches on the body element, verifies a
security token when configured (the handler then receives `principal`), and renders every
failure as a `Fault` in the right dialect — `Code/Value` + `Reason/Text` for 1.2,
`faultcode`/`faultstring` for 1.1 — with the fault side taken from § 9's kind: a bad
request is the client's fault. `?wsdl` serves a configured document.

The decision that the contract is compiled once, committed and gated by `--check` is
[ADR-0024](../decisions/0024-wsdl-compiled-at-build-time.md).

Two behaviours changed while proving this on the wire:

- **A non-2xx that is not a SOAP envelope is an HTTP failure, not a protocol error.** A
  load balancer answering 503 with an HTML page is the common case in production; reading
  it as "malformed contract" would have made every gateway hiccup a `LNK_PROTOCOL` with no
  retry. It now maps through `kindForHttpStatus`, so 503 is `unavailable` and retryable.
- **The envelope and the record bridge moved to `soap-core.ts`**, so the client and the
  server share them without importing each other.

---

## 6. WebSocket

```ts
// server
export const handler = defineWsHandler({
  path: '/ws/orders',
  authenticate: OrderWsAuth,          // guard, returns Principal
  schema: OrderSocketMessage,         // discriminated union, validated per frame
  onMessage: async ({ message, principal, ctx }) => {
    if (message.type === 'subscribe') return { type: 'ack', subscriptionId: … };
    // exhaustive switch enforced by `assertNever`
  },
  maxFrameBytes: 64 * 1024,
  idleTimeoutMs: 30_000,
  heartbeat: { intervalMs: 15_000, timeoutMs: 5_000 },
});

// client
const socket = createWsClient({ url, protocol: OrderSocketMessage, ctx, reconnect: { attempts: 5, jitter: true } });
```

| Concern                 | Behavior                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framing                 | JSON by default; `schema` validated per frame; malformed frame closes with `1008` and logs the reason                                                                |
| Backpressure            | `bufferedAmount` checked before send; exceeding limit closes with `1013`                                                                                             |
| Lifecycle               | Explicit `open → authenticated → active → draining → closed`; graceful close sends `1001` with reason                                                                |
| Reconnect (client)      | Exponential backoff with jitter; **no** silent replay of unacked messages — at-most-once documented; `idempotencyKey` passed through for app-level dedupe            |
| Multi-instance (server) | A room is one coordinator: on Workers a Durable Object (`createRoom`), so fan-out is cross-isolate. Bun/Node rooms need a shared backend — `@tsir/events`, not built |
| Workers                 | Supported via Durable Objects for stateful rooms (`createRoom`; the binding is `DPL-010`) — plain `WebSocketPair` without DO gives per-isolate state                 |
| Lambda                  | **Not supported natively**; use API Gateway WebSocket API adapter, which requires a separate unit (`ws`) in `separate` topology                                      |

### 6.1 As built — rooms (2026-10-28)

`createRoom(state, options)` returns the Durable Object methods a room needs
(`fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`) and takes the object's
state through a two-method interface: `acceptWebSocket(socket, tags)` and
`getWebSockets(tag)`. Everything per-connection lives in the socket attachment (connection
id, room, principal, join time) and membership is the runtime's socket list, so an eviction
loses nothing: `rooms.test.ts` restarts the object mid-test and sockets accepted before the
restart still receive the broadcast.

The model is deliberately **shaped like** the Durable Object API rather than typed by
`@cloudflare/workers-types` ([ADR-0025](../decisions/0025-rooms-are-durable-object-shaped.md)):
a protocol package that needs a platform's ambient types is a package that cannot be tested
on a laptop, and `make verify-dist` bundles the room entrypoint for the browser target at
5.4 KiB — no `node:` import, no Workers runtime. Declaring the binding, exporting the class
and adding the `migrations` entry is `DPL-010`.

Behaviour, in the terms the table above uses:

| Concern        | As built                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Fan-out        | `onMessage` returning a value broadcasts it; `room.broadcast(value, { except })` and `room.to(id, …)` are the explicit forms                 |
| Ordering       | The runtime executes one message at a time; a broadcast is a loop, not a race — one writer, therefore an order                               |
| Delivery       | Best-effort per socket and at-most-once, as everywhere else in this package: a `send` that throws is skipped, never retried                  |
| Membership     | `room.size()` / `room.members()`, read from `getWebSockets('room:<id>')`, hibernated sockets included                                        |
| Presence       | `onJoin` / `onLeave` plus a broadcast; the framework does not invent a presence frame                                                        |
| Frame contract | `schema.parse` per frame; `1008` on a bad frame, `1009` over 64 KiB, `1011` when a handler throws — the codes `defineWsHandler` already uses |
| Auth           | `authenticate` runs before the upgrade: a refusal is `401` with **no** socket, not a socket closed `1008`                                    |
| Backpressure   | Not available: hibernatable sockets have no `bufferedAmount`, so a room cannot close a slow consumer (`1013`)                                |

---

## 7. Service identity & credentials

- Outbound calls attach credentials from a `ServiceCredentialProvider` — never from ad-hoc env reads.
- Supported: mTLS client certs (gRPC), bearer tokens from `@tsir/auth`'s service-token issuer, HMAC request signing (REST/SOAP) via `@tsir/vault` HMAC keys.
- Inbound: `@tsir/link` validates the same schemes and produces a `Principal` for `@tsir/policy` — so an internal gRPC call and an HTTP request authorize identically.
- Clock skew > 60 s on HMAC auth → `unauthenticated` with `clock_skew` code (never silent accept).

---

## 8. Capability matrix

| Capability           | Bun                     | Cloudflare Workers               | AWS Lambda                       |
| -------------------- | ----------------------- | -------------------------------- | -------------------------------- |
| REST client          | ✅ `fetch`              | ✅                               | ✅                               |
| REST server          | ✅ via `@tsir/http/bun` | ✅ via `@tsir/deploy/cloudflare` | ✅ via `@tsir/deploy/lambda`     |
| gRPC client          | ✅                      | ❌ (no raw sockets)              | ✅                               |
| gRPC server          | ✅                      | ❌                               | ✅ (ALB gRPC / API GW)           |
| SOAP client          | ✅                      | ✅ (fetch + XML)                 | ✅                               |
| SOAP server          | ✅                      | ✅                               | ✅                               |
| WS client            | ✅                      | ✅ (`fetch` upgrade, DO-backed)  | ✅ (custom domain)               |
| WS server            | ✅                      | ✅ (Durable Objects)             | ⚠️ API GW WebSocket adapter only |
| Deadline propagation | ✅                      | ✅                               | ✅                               |
| Cancellation         | ✅                      | ✅ (request abort)               | ⚠️ function timeout only         |

The link half of this table is asserted by `capability.test.ts`: a ❌ for Workers must
correspond to code that refuses there (`assertGrpcSupported`), and a ✅ must correspond to
an entrypoint that imports no `node:`/`bun:` module. The deploy half — that each ✅ actually
boots on the target — is `DPL-LNK` in phase 6, and `make verify-dist` is the bundle-level
proxy until then.

---

## 9. Failure modes

| Code                  | Kind              | Retryable        | Notes                                         |
| --------------------- | ----------------- | ---------------- | --------------------------------------------- |
| `LNK_TIMEOUT`         | `timeout`         | ✅               | Deadline exceeded; abort signal already fired |
| `LNK_CANCELLED`       | `cancelled`       | ❌               | Caller aborted                                |
| `LNK_UNAVAILABLE`     | `unavailable`     | ✅               | Connect refused / DNS / 503                   |
| `LNK_RATE_LIMITED`    | `rate_limited`    | ✅               | `retryAfterMs` from `Retry-After`             |
| `LNK_UNAUTHENTICATED` | `unauthenticated` | ❌               | Includes `clock_skew` sub-code                |
| `LNK_PROTOCOL`        | `protocol`        | ❌               | Malformed frame/XML/status                    |
| `LNK_SCHEMA`          | — (throws)        | ❌               | Request/response failed local validation      |
| `LNK_CIRCUIT_OPEN`    | `unavailable`     | ✅ (after delay) | Breaker open                                  |
| `LNK_WS_CLOSED`       | `unavailable`     | ✅               | With close code + reason                      |
| `LNK_SOAP_FAULT`      | mapped            | per fault        | Never leaks fault XML to clients              |

---

## 10. Security considerations

- TLS verification **on by default**; disabling requires an explicit config flag that warns at boot and is rejected in production.
- XML: XXE, billion-laughs, and DTD attacks blocked by parser configuration, with negative tests.
- Response size limits per protocol (JSON 8 MiB, XML 4 MiB, gRPC 4 MiB default, WS frame 64 KiB) to bound memory.
- Outbound URLs are taken from validated config, not from user input; if user-influenced, an allowlist is mandatory (`LNK_URL_NOT_ALLOWED`).
- Credential material is never logged; `CallMeta` records `credentialId`, not the secret.
- SOAP WSDL is compiled at build time precisely so a compromised remote WSDL cannot inject types at runtime.

---

## 11. Open questions

| #    | Question                                                                                                                                           | Blocks  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `Q4` | SOAP WS-Security scope — user token only, or X.509 signing too? Defined in [`00-foundation.md § 6`](../roadmap/00-foundation.md#6-open-questions). | Phase 5 |
| Q19  | Connect protocol as the Workers gRPC story — adopt `@connectrpc/connect` or implement minimal framing?                                             | Phase 5 |
| Q20  | Do we ship a service registry/discovery concept, or rely on config/env (Twelve-Factor)? Current: config only.                                      | —       |

---

## 12. Task index

[`tasks/06-link.md`](../tasks/06-link.md) — `LNK-001` … `LNK-025` (the tasks file is authoritative; the plan originally listed 22).

---

## 13. As built — shared core and REST (2026-10-28)

`LNK-001` … `LNK-011` are implemented; the decisions below are the ones the plan left
open enough to matter during implementation.

**Entrypoints.** `@tsir/link` exports the shared core only — `types`, `errors`,
`deadline`, `trace`, `retry`, `breaker`, `credentials` — and imports nothing protocol
specific, so a Workers bundle that only needs the contract pays for the contract.
`@tsir/link/rest` is the first protocol entrypoint. It imports no platform module:
`fetch`, `now`, `sleep` and `random` are dependencies (`options.deps`), which is also what
makes every REST test a scripted exchange with no socket.

**`CallError.message`.** One field was added beyond § 2: `message?: string`, a one-line
operator-facing description written by the adapter ("upstream returned 503",
"response body exceeds the 8388608-byte limit"). It exists because `cause` is whatever
the transport threw — often `TypeError: fetch failed` — and it is framework-authored, so
it is safe to log and never contains a credential or a body. The contract's branching
surface (`kind`, `code`, `retryable`) is unchanged.

**Schemas are structural.** `Schema<T>` is `{ parse(input: unknown): T }` — satisfied by
both `@tsir/validate` and zod — so `@tsir/link` does not take a validator dependency for
the REST subpath and callers keep the validator they already have. A request body that
fails its schema throws `TsirError` `LNK_SCHEMA` before any connection is opened; a
response that fails is a `protocol` failure (the other side's bug, not ours).

**Retry is opt-in.** `NO_RETRY` is the default: a client without a policy makes one
attempt. Unsafe methods (`POST`, `PATCH`) retry only when an `Idempotency-Key` is
present — from the call or `ctx.idempotencyKey` — and the same key is sent on every
attempt. `Retry-After` is a floor under the backoff, never a ceiling.

**Redirects are not followed.** `redirect: 'manual'` is always set: a 3xx from an
internal service is a misconfiguration, and following it would carry credentials to
whatever the target names. A 3xx therefore surfaces as `unknown` with `HTTP_3xx` in
`code`, which is exactly the signal an operator needs.

**TLS is not negotiable.** `http:` base URLs are refused unless the host is loopback, at
construction time. `allowedHosts`, when given, is enforced against the base URL at boot
and against every resolved URL at call time (`LNK_URL_NOT_ALLOWED`).

**One vocabulary for error codes.** § 9's table is code, not prose: `codeForKind()` maps
every `CallErrorKind` to exactly one `LNK_*` code, and each adapter calls it. gRPC
therefore reports `LNK_UNAVAILABLE`, not a protocol-flavoured `GRPC_UNAVAILABLE` — an
application that switches protocols must not have to switch `switch` statements. The
protocol's own name survives in `message` (`gRPC PERMISSION_DENIED: no access to order
o-1`), where an operator grepping logs wants it, and protocol-specific oddities stay in
their own codes (`LNK_WS_CLOSED`, `LNK_SOAP_FAULT`). `parseRetryAfter()` is shared by REST
and gRPC for the same reason.

**Breaker granularity.** One breaker per client instance, which is one target host — the
plan's "per target host" resolved to "per configured client", because a client is the
unit that owns a base URL. It is timer-free: state is computed on read, so there is
nothing to leak at shutdown and no `unref` juggling in tests.

**Observability seam.** `onCall` receives one `CallEvent` per call with the label set
`link_calls_total` needs (`protocol`, `target`, `kind`, `status`, `attempts`,
`elapsedMs`, `traceId`, `credentialId`). The sink is called inside a `try {} catch {}`:
telemetry must never fail a call that already happened. Actually exporting the metric
waits for `@tsir/telemetry` (phase 8, `OBS-*`).

**WebSocket (`LNK-021` … `024`).** `defineWsHandler` takes a `sink` (callback transports
such as Bun's server sockets) and also offers `attach(socket, handshake)` for
`EventTarget` transports (Workers `WebSocketPair`, browsers, Node `ws`), so both run one
session implementation. Policy, in the order it fires: byte-counted frame limit → `1009`;
invalid JSON or a schema failure → `1008` with the reason on `onError`; a handler that
throws → `1011`; a peer past the buffer cap → `1013` instead of unbounded buffering;
`drain()` → `1001` once `bufferedAmount` reaches zero; no traffic for `idleTimeoutMs` →
`1001`, with `heartbeat.intervalMs` calling native `ping()` where the transport has one.

The client sends **nothing** while it is not open (`LNK_WS_CLOSED`) and replays nothing
after a reconnect. It reconnects on every close except `1000`/`1001` — a deliberate close
and a draining server are statements, not accidents — with exponential backoff, full
jitter, and a cap at `reconnect.attempts`. `wsCloseError()` maps a close to a `CallError`
so a transport can report upward in the same vocabulary as REST.

**Dependency scope (ADR-0022).** gRPC and SOAP each need a third-party runtime that no
other entrypoint may see. `make deps` now enforces that: a policy entry may name the
subpath entrypoints allowed to import a dependency, and the check walks the package's root
import closure (relative imports followed transitively) and fails if the dependency is
reachable from it. The README badge splits the count (`2 (+2 adapters)`) so a REST user is
not told they carry a gRPC runtime. The companion bundle proof lands with the first
scoped dependency.

**Not built yet.** The deploy half of the capability matrix (`DPL-LNK`): a ✅ that a target
actually _boots_, as opposed to `make verify-dist`'s proof that the bundle graph is right.
Durable Object rooms are built (`LNK-025`); only their binding and class export wait for
`DPL-010`, which is where they belong.
