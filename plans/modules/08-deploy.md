# 08 — Deploy: Cloudflare Workers & AWS Lambda

> `@tsir/deploy`. One application, compiled into deployable **units**, emitted as first-class artifacts for Cloudflare Workers and AWS Lambda. Default topology: **separate units**.

---

## 1. Unit model

A **unit** is the atom of deployment. It is derived from the application's declared capabilities, not from source-file layout.

| Unit          | Contains                             | Cron/trigger         | Typical target mapping                |
| ------------- | ------------------------------------ | -------------------- | ------------------------------------- |
| `http`        | HTTP routes, middleware, guards      | HTTP requests        | Workers fetch / Lambda + API Gateway  |
| `ws`          | WebSocket handlers                   | Upgrade requests     | Workers + Durable Objects / API GW WS |
| `queue`       | Job handlers                         | Queue/stream events  | Workers Queues / Lambda + SQS         |
| `schedule`    | Scheduled tasks                      | Cron                 | Workers Cron Triggers / EventBridge   |
| `sns`         | `@OnSns` topic subscribers           | SNS messages         | Lambda + SNS (raw SQS fan-out)        |
| `eventbridge` | `@OnEventBridge` rules               | EventBridge events   | Lambda + EventBridge rule             |
| `admin`       | `@OnStepTask` tasks, health, metrics | Direct invoke / HTTP | Separate worker/lambda recommended    |
| `console`     | CLI-entered commands                 | Manual               | Not deployed                          |

### 1.1 Topology

```ts
// tsir.js
export default defineConfig({
  deploy: {
    topology: 'separate',     // DEFAULT — one unit per deployable function
    targets: {
      cloudflare: { entry: 'units', r2: ..., d1: ... },
      lambda: { region: 'ap-southeast-1', memoryMb: 1024, architecture: 'arm64' },
    },
  },
});
```

**`separate` (default).** Each enabled unit becomes its own worker/lambda. Rationale:

- Cold-start isolation: a 40-route HTTP bundle stays small; queue logic with heavy dependencies never bloats it.
- Independent scaling and limits (CPU time, concurrency, memory) per workload.
- Failure containment: a crashing queue consumer does not take down the API.
- Least privilege: the HTTP unit gets no queue bindings; the queue unit gets no public route.

**`single` (opt-in).** One entrypoint dispatches by event shape (`fetch` vs `queue` vs `scheduled`). Useful for small services, hobby deployments, or strict vendor limits. Cost documented: larger bundle, coupled deploys, shared limits.

The topology is resolved by the **unit graph** (§ 2), printed by `tsir deploy:plan --explain`, and never inferred silently.

### 1.2 AWS event listeners (`DPL-026` … `DPL-029`)

Controllers declare event handlers with decorators the same way they declare routes:

```ts
import { Controller, OnSns, OnEventBridge, OnStepTask } from '@tsir/router';
import type { ListenerContext } from '@tsir/deploy';

@Controller()
class OrdersController {
  // SNS topic subscriber — default unit 'sns'
  @OnSns({ topic: 'orders.created' })
  onOrderCreated(message: unknown, ctx: ListenerContext): void {
    /* fan-out consumer */
  }

  // EventBridge rule — matches by detail-type; default unit 'schedule'
  @OnEventBridge({ detailType: 'OrderShipped' })
  onOrderShipped(detail: unknown, ctx: ListenerContext): void {
    /* rule target */
  }

  // Step Functions task — invoked synchronously; default unit 'admin'
  @OnStepTask({ name: 'process-refund' })
  processRefund(input: unknown, ctx: ListenerContext): Promise<unknown> {
    /* task handler */
  }
}
```

Each decorator resolves a default unit (`sns`, `schedule`, `admin`), overridable with
`{ unit: 'my-unit' }`. The body schema (`{ body: schema }`) is validated at runtime via
`@tsir/validate`; an event with no matching listener throws `DPL_LISTENER_NOT_FOUND` with the
expected key. SNS messages arrive as `SnsRecord.Sns.Message` already parsed. EventBridge
events are keyed by `detail-type` (the bus-level filter lives in the emitted `AWS::Events::Rule`;
scheduled EventBridge events from `aws.events`/`aws.scheduler` go to the `scheduled` handler, not
`eventbridge`). Step task events arrive as `{ task, ...input }`; if a single `@OnStepTask` is
declared, the `task` field is optional so any payload routes to it. The method's return value is
the Step Functions task output (the adapter does not replace it).

Every handler receives `ListenerContext` as its second argument: the same shape of per-invocation
metadata HTTP controllers get through `ctx` (`04-http.md § 8.4`): `signal` (Lambda deadline
abort), `functionName`, `awsRequestId`, plus the source envelope (`sns` or `eventbridge`).
The SQS/SNS/scheduled branches create a deadline signal from
`context.getRemainingTimeInMillis()` so a handler can cooperate with the Lambda's remaining time.

### 1.3 Internal invoke and publish (`DPL-030`)

A service method can reach another unit without importing its controller:

```ts
import { invokeUnit, publish } from '@tsir/deploy';

// Publishes to an SNS topic — must have a matching @OnSns listener in the graph.
await publish('orders.created', { orderId: 'ord-1' });

// Invokes another unit's @OnStepTask synchronously and returns its result.
const result = await invokeUnit('admin', 'process-refund', { amount: 42 });
```

Both are **checked against the graph at build time**: list the topics and tasks in `tsir.js`:

```js
export default defineConfig({
  deploy: {
    publishes: ['orders.created'],
    invokes: [{ unit: 'admin', task: 'process-refund' }],
  },
});
```

A topic or task not declared anywhere fails the build with `DPL_PUBLISH_UNKNOWN` or
`DPL_INVOKE_UNKNOWN` — a message that would vanish into a topic nobody reads, or an invoke
that would land on a function with no matching task name, is caught before deploy. The
transport is pluggable (`setInternalTransport`) so tests inject an in-process mock; in
production the default lazily imports `@aws-sdk/client-sns` and `@aws-sdk/client-lambda`.

**How `invokeUnit` reaches the target Lambda** (DPL-030 platform wiring):

1. The caller runs `invokeUnit('admin', 'process-refund', { amount: 42 })` from inside any
   unit's handler.
2. The AWS transport builds `FunctionName: ${TSIR_STACK_NAME}-admin` — the env var
   `TSIR_STACK_NAME` is injected into every Lambda by the SAM template, and the deployed
   function is named `${AWS::StackName}-${unit}`. Without it, the SDK would look for a
   function literally named `admin` and fail with `ResourceNotFoundException`.
3. It calls `lambda:InvokeFunction` with `InvocationType: RequestResponse` and a payload of
   `{ "task": "process-refund", "amount": 42 }`.
4. The source Lambda's role carries an inline policy allowing
   `lambda:InvokeFunction` on `arn:aws:lambda:*:*:function:${AWS::StackName}-*` — every
   function in the stack. No cross-account or cross-stack invokes are permitted.
5. The target Lambda's adapter routes the payload to its `invoke` handler, which looks up
   the `@OnStepTask({ name: 'process-refund' })` method, validates the body against its
   declared schema, and returns the method's result as the Lambda response body.
6. The transport parses the response payload and returns it to the caller.

`invokeUnit` is **synchronous** (`RequestResponse`): the caller waits for the target to
finish. For fire-and-forget work, use `publish` to an SNS topic instead.

### 1.4 Per-unit memory and timeout (`DPL-031`)

`deploy.memoryMb` and `deploy.timeoutSeconds` set the shared default for every unit. Override
a single unit in `deploy.units`:

```js
export default defineConfig({
  deploy: {
    memoryMb: 512, // shared default via Globals.Function
    timeoutSeconds: 30,
    units: [
      { name: 'admin', memoryMb: 2048, timeoutSeconds: 120 }, // heavy unit
    ],
  },
});
```

A unit without overrides inherits the shared default (no `MemorySize`/`Timeout` on its
function resource). A unit with overrides emits its own values on the function resource.

---

## 2. Unit graph resolution

```
capabilities ──► candidate units ──► dependency closure ──► prune ──► UnitGraph
```

Inputs:

1. Modules registered in `tsir.js` (`modules: [...]`).
2. Routes discovered by the route compiler (which controller belongs to which unit — default by `@Controller({ unit: 'http' })`, overridable).
3. Queue handler registrations, scheduled task registrations, WS handler registrations.
4. AWS event listeners discovered by the route compiler: `@OnSns`, `@OnEventBridge`, `@OnStepTask` (§ 1.2) — each contributes its unit and trigger kind.
5. Internal `publish`/`invokeUnit` declarations in `deploy.publishes` / `deploy.invokes` (§ 1.3) — checked against the graph, not used to create units.
6. Explicit `deploy.units` overrides in `tsir.js`.

Rules:

- A unit pulls only its reachable dependency closure (tree-shaken by `bun build` + explicit entry).
- Shared code is **inlined per unit**, not published as a shared layer — bundle duplication is accepted in exchange for independent deploys (size budget tracked).
- A capability that has no unit (e.g. `@tsir/mail` used only from queue) is attributed to its invoking unit.
- **Connections become units (ADR-0019).** Every database connection with a journal gets its own `migrate:<connection>` unit and every queue connection its own trigger, because a replica that is behind or an analytics database that is briefly unreachable must not fail the primary's release. Two connections on the same driver still produce two units; the driver is inlined once per unit, as with all shared code.
- Cycles between units (queue job calls HTTP unit which enqueues…) are allowed at runtime but must not create build cycles; the graph is a DAG of _code_, not of _calls_.

### Determinism

`UnitGraph` serializes to a stable JSON (`unit-graph.json`) committed to the repo. **Snapshot test:** any change to units, bindings, or emitted file list fails CI until the snapshot is intentionally updated — so a refactor cannot silently change deployment shape.

---

## 3. Artifacts

### 3.0 As built — the graph and its commands (2026-10-28)

`@tsir/deploy` resolves, validates, serializes and diffs the unit graph. Nothing is emitted
yet: `DPL-008` … `DPL-021` (the Workers and Lambda adapters, `wrangler.*.toml`, templates)
come next, and this section is what they build on.

```bash
tsir deploy:plan                 # the graph, one row per unit
tsir deploy:plan --explain       # …plus the declaration behind each unit
tsir deploy:plan --write         # commit unit-graph.json
tsir deploy:plan --check         # fail if the snapshot would change
tsir deploy:plan --json          # one document: graph + problems
tsir deploy:diff                 # name what changed since the snapshot
```

**Resolution.** Units come from declarations, never from directory layout:

| Declaration                 | Unit                        | Notes                                                     |
| --------------------------- | --------------------------- | --------------------------------------------------------- |
| route `meta.unit`           | `http` (or the named unit)  | `routeModule({ unit })` sets the module's default         |
| `sockets` / `queues` / cron | `ws` / `queue` / `schedule` | from `deploy.units` until Phase 7 packages register them  |
| a journaled connection      | `migrate:<connection>`      | one per connection (ADR-0019); unjournaled ones give none |
| `deploy.units` override     | any                         | the escape hatch, and it is _reported_ as the reason      |

Every unit keeps `reasons` (which declaration demanded it), `modules`, the union of module
`requires`, its `bindings` and its exposure. `admin` is private by default.

**Topology (`DPL-002`).** `separate` is the default. `single` merges every non-`migrate`
unit into one `app` unit with the union of triggers, bindings and capabilities, marks it
public if any part was, and returns `merged` so `deploy:plan` prints what it merged. A
migration never merges — running migrations on cold start is the failure the split exists
to prevent.

**Validation (`DPL-003`, `DPL-006`).** Three checks, reported together, each with the fix:
`DPL_DUPLICATE_ROUTE` (two units claiming `GET /x`), `DPL_CAPABILITY_MISSING` (a unit needs
`raw-sockets` on Workers — the message uses the matrix's own words) and
`DPL_BINDING_MISSING` (a unit uses `HYPERDRIVE` and the target never declared it). Secrets
and vars are exempt: they arrive from `wrangler secret put` or the IaC template, not from
`targets.*.bindings`.

**Determinism (`DPL-004`).** Serialization sorts every collection, so two builds of the
same declarations are byte-identical. `unit-graph.json` is committed; `--check` fails on
drift and `deploy:diff` names the unit and the field. `make codegen-check` runs it for the
HTTP example, so a refactor that changes the deploy shape cannot merge quietly.

The API is `resolveUnits`, `applyTopology`, `buildGraph`, `checkGraph`, `serializeGraph`,
`parseGraph`, `diffGraphs`, `formatGraph`, `explainGraph` and the `Unit`/`UnitGraph` types —
the checks are functions, so the emitters in § 3 consume a validated graph rather than
re-deriving one.

### 3.1 Cloudflare Workers

```
dist/cloudflare/
├── http/index.js            + wrangler.http.toml
├── ws/index.js              + wrangler.ws.toml
├── queue/index.js           + wrangler.queue.toml
├── schedule/index.js        + wrangler.schedule.toml
└── unit-graph.json
```

`wrangler.*.toml` (generated, committed, reviewable):

```toml
name = "acme-api-http"
main = "index.js"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]

[observability]
enabled = true

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<hyperdrive-id>"

[[queues.producers]]
binding = "JOBS"
queue = "acme-jobs"

[vars]
APP_ENV = "production"
# secrets are NOT emitted — `wrangler secret put` only
```

- `@tsir/deploy/cloudflare` provides `toCloudflareHandler(app)` returning `{ fetch, queue, scheduled }` exports as needed by the unit.

**As built (2026-10-28).** A private unit (`admin`, unless `private: false`) gets
`workers_dev = false` and no routes, so "private" survives `wrangler deploy` instead of
being a column in the committed graph; a private unit on Lambda gets no `HttpApi` event and
no URL output. `deploy:validate` re-reads both artifacts and fails with
`DPL_PRIVATE_EXPOSED` if they disagree with the graph.

A `durable-object` binding emits `[[durable_objects.bindings]]` **and** a `[[migrations]]`
entry, and `deploy:build` re-exports the class from the generated entry — the binding only
names a class, the bundle has to contain it. A missing export is `DPL_CLASS_MISSING` at
build time rather than a deploy-time surprise.

- D1 is **not** a supported database target (`05-database.md § 2`); Hyperdrive (Postgres) is.
- Durable Objects used for WS rooms and rate limiting; bindings declared per unit.
- Bundle size budget per unit (default 1 MiB gzipped, warning at 800 KiB).

### 3.2 AWS Lambda

```
dist/lambda/
├── http/index.mjs          + template.http.yaml  (SAM or CDK-consumable)
├── queue/index.mjs         + template.queue.yaml
├── schedule/index.mjs      + template.schedule.yaml
└── unit-graph.json
```

- `@tsir/deploy/lambda` provides `toLambdaHandler(app)` returning `handler(event, context)`; supports API Gateway v2 (HTTP API), Function URLs, SQS, EventBridge.
- Node 20+/22 runtime; bundle with `bun build --target=node --format=esm`; no native modules.
- `context.getRemainingTimeInMillis()` feeds the deadline → `ctx.signal`; graceful shutdown drains for `min(remaining - 500ms, shutdownTimeout)`.
- Provisioned concurrency, layers, and VPC config emitted as infrastructure templates — Tsir generates CDK/SAM templates but does **not** deploy them (users own IaC; `tsir deploy:build` writes artifacts and a plan file).

**As built (2026-10-28).** `@tsir/deploy/sam` emits `template.<unit>.yaml` into the unit's
directory (`CodeUri: .`), one document per unit:

```
dist/lambda/http/
├── index.mjs
└── template.http.yaml     # AWS::Serverless::HttpApi + Function, Outputs.HttpApiUrl
```

| Unit trigger         | Event emitted | Notes                                                                                                                                                              |
| -------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `http` / `websocket` | `HttpApi`     | `Path: /{proxy+}`, `Method: ANY`, `ApiId: !Ref HttpApi`                                                                                                            |
| `queue`              | `SQS`         | `BatchSize: 10` and **`FunctionResponseTypes: [ReportBatchItemFailures]`** — without it AWS retries the whole batch and the adapter's partial failures are ignored |
| `cron`               | `Schedule`    | five-field crontab translated to AWS's six, `?` in the unconstrained day (`*/5 * * * *` → `0/5 * * * ? *`)                                                         |

Secrets are **parameters, not values**: `APP_KEY` emits `Parameters.AppKey` with
`NoEcho: true` and `APP_KEY: !Ref AppKey`, so the artifact can be committed and the operator
supplies the value at `sam deploy` time. `deploy.targets.lambda.vars` merge with the unit's
`var` bindings, sorted; the total is checked against Lambda's 4 KB environment budget and an
overage fails the build with `DPL_ENV_LIMIT` (`DPL-017`).

Template knobs live in `tsir.js` — `runtime` (`nodejs22.x`), `memoryMb` (1024),
`timeoutSeconds` (30), `architecture` (`arm64`), `region`. Nothing is deployed: `sam deploy
--template-file dist/lambda/http/template.http.yaml` is the operator's command, and until it
has been run and `sam validate --lint` recorded, `DPL-016` stays `[~]`
([`tasks/07-deploy-cloud-checks.md`](../tasks/07-deploy-cloud-checks.md) C5).

### 3.3 Bun (long-running)

```
dist/bun/server.mjs
```

`make start` runs it. Default for local, VPS, and container platforms.

### 3.4 As built — the emitter (2026-10-28)

`tsir deploy:build` writes the artifacts above. `@tsir/deploy` still emits nothing itself:
the adapters (`./cloudflare`, `./lambda`) and the config generator (`./wrangler`) are pure
functions over the graph, and the CLI is the only thing that runs `Bun.build`.

```bash
tsir deploy:build                                  # every configured target, else bun
tsir deploy:build --target cloudflare,lambda       # one bundle per unit per target
tsir deploy:build --out dist --minify              # quieter bytes
tsir deploy:build --allow-size-regression          # write over-budget artifacts anyway
make deploy-build ARGS="--target cloudflare"
```

```
dist/
├── build.json                       # every artifact: bytes, gzip bytes, budget
├── cloudflare/
│   ├── unit-graph.json
│   └── http/{index.js, wrangler.http.toml}
├── lambda/
│   ├── unit-graph.json
│   └── http/index.mjs
└── bun/server.mjs
```

**The generated entry is the whole adapter.** For each unit the emitter writes a few lines
that import the application entry and hand the adapter only the handlers the unit's triggers
name — `http`/`websocket` → `handler`, `queue` → `queue`, `cron` → `scheduled`. The resulting
bundle has no `fetch` export unless the unit serves HTTP, which is the least privilege the
platform can express (§ 8). Generated entries live in `.tsir/build/` and are deleted after
binding; nothing absolute ends up in `dist/`.

**Validation precedes writing.** A unit whose triggers need an export the entry does not have
(`DPL_UNIT_EMPTY`), a binding whose resource is missing (`DPL_BINDING_INVALID`), and any
blocking graph problem all fail before the first byte, so `dist/` never contains a plausible
half-build.

**Budgets.** `deploy.targets.<target>.sizeBudget` (bytes, gzipped) or the platform's own
limit: 1 MiB for Workers, 50 MiB for Lambda, none for `bun`. Over budget is exit 1 with the
artifact still written, `--allow-size-regression` is the reviewed escape, and the numbers
land in `build.json` so `deploy:validate` (`DPL-019`) reads a file instead of re-deriving the
build.

**Migrate units** (`DPL-021`). A journaled connection in `tsir.js` emits
`dist/migrate/<connection>/{migrate.mjs,migrate.json}` — a _script_, not a function, and the
only artifact here that is not per-target: a migration belongs to the connection, not to
Workers or Lambda. It has no `export` statement, so no platform shape can call it; it imports
the application entry and runs the same `migrate()` the CLI runs. Drift and pending
migrations exit 1, a lock held by another runner exits 0. D1 connections are refused
(`wrangler d1 migrations apply` is the real command, and D1 is not a deploy target), and
`journal: false` produces no unit.

**Two deviations from the sketches above, both deliberate.** `wrangler.<unit>.toml` is
written _inside_ the unit directory because `main = "index.js"` is resolved relative to the
config, and a flat layout would point it at nothing; the Bun target emits one `server.mjs`
rather than one per unit, because a container is one process (§ 3.3).

**What is not proven yet:** no artifact has been given to `wrangler dev`, `wrangler deploy
--dry-run` or a real Lambda. What _is_ proven in the test suite is that the emitted
Cloudflare bundle answers `GET /api/users` when imported, that the emitted Lambda bundle
answers an API Gateway v2 event, and that the emitted Bun server boots and prints its URL.

---

## 4. Runtime capability probes

Not everything works everywhere. `@tsir/deploy` defines a `RuntimeCapabilities` record:

```ts
export interface RuntimeCapabilities {
  readonly target: 'bun' | 'cloudflare' | 'lambda';
  readonly nodeCompat: boolean;
  readonly rawSockets: boolean; // gRPC server/client
  readonly filesystem: boolean;
  readonly durableState: boolean; // DO / DynamoDB
  readonly backgroundTasks: boolean; // waitUntil / Lambda extension
  readonly subprocesses: boolean; // migrations, ffmpeg…
}
```

Boot compares required capabilities (declared by each package via `requires`) against the target and fails with `DPL_CAPABILITY_MISSING` and a table of _what_ and _why_, before serving traffic.

---

## 5. Secrets

| Target  | Mechanism                                      | Tsir's role                                            |
| ------- | ---------------------------------------------- | ------------------------------------------------------ |
| Workers | `wrangler secret put` bindings                 | Validate presence at boot; never inline values         |
| Lambda  | Environment from Secrets Manager / SSM via IaC | Validate presence at boot; recommend KMS-encrypted env |
| Bun     | Environment / secret manager of choice         | Same                                                   |

Artifacts **must not** contain secret values. A CI check scans emitted artifacts for `APP_KEY`, `DATABASE_URL=`, and patterns matching configured secret names.

**As built (2026-10-28).** The scanner lives in `@tsir/deploy` (`secrets.ts`) and is a pure
function: text in, findings out, no filesystem — so the rule is testable on its own and the
CLI decides which files are artifacts. It looks for two families:

| Family | What it matches                                                                                                                      | Example                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| shapes | formats a credential really has: PEM private keys, AWS access key ids, GitHub / Slack / Stripe / Google tokens, URLs with a password | `AKIA…`, `-----BEGIN … PRIVATE KEY-----` |
| names  | `NAME = <value>` for every `secret` binding the graph declares                                                                       | `APP_KEY = "…"`                          |

Two deliberate non-findings keep it trustworthy: `#   wrangler secret put APP_KEY` (the
generated, correct shape — no assignment) and `process.env.APP_KEY` (reading the secret is a
use, not a leak). Findings name the file, the line and the pattern, and print the line with
the value replaced by `[redacted]`; the value is never echoed, not even in `--json`, because
a scanner that prints what it found is a second leak.

`tsir deploy:validate` (`DPL-019`) is the gate: it re-reads `dist/build.json`, checks that
every artifact still has the bytes the build recorded, measures the gzip size against the
budget **as configured now**, scans every file in the output directory, and re-validates the
graph against the emitted targets. `make check` runs it for the HTTP example, so a leak or a
stale artifact reddens the ordinary gate rather than waiting for a release job.

---

## 6. `tsir deploy` commands

```bash
tsir deploy:plan                 # print unit graph + bindings, human + json
tsir deploy:plan --explain       # why each unit exists (which capability demanded it)
tsir deploy:build                # emit artifacts for all targets configured
tsir deploy:build --target lambda --out dist/lambda
tsir deploy:diff                 # compare unit-graph.json to committed snapshot
tsir deploy:validate              # run capability probes + secret presence + size budgets
tsir deploy:invoke --unit http --event fixture.json   # local invocation against a unit
```

`make deploy-workers` / `make deploy-lambda` wrap `wrangler deploy` / SAM deploy **only when the user opts in**; default `make deploy-*` stops at artifacts, since the framework should not hold cloud credentials.

---

## 7. Failure modes

| Code                     | Cause                                                                           | Behavior                                 |
| ------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------- |
| `DPL_CAPABILITY_MISSING` | Unit requires raw sockets on Workers                                            | Build fails with matrix row              |
| `DPL_UNIT_EMPTY`         | Unit resolved with no handlers                                                  | Warning; error in `--strict`             |
| `DPL_DUPLICATE_ROUTE`    | Same route claimed by two units                                                 | Build fails                              |
| `DPL_BINDING_MISSING`    | Unit references a binding not declared in target config                         | Build fails                              |
| `DPL_SECRET_LEAK`        | Artifact contains a secret pattern                                              | CI fails                                 |
| `DPL_SIZE_BUDGET`        | Unit exceeds budget                                                             | Fails unless `--allow-size-regression`   |
| `DPL_GRAPH_DRIFT`        | Unit graph differs from committed snapshot                                      | Fails with diff                          |
| `DPL_PRIVATE_EXPOSED`    | A private unit's artifact is publicly routable                                  | `deploy:validate` fails, names the unit  |
| `DPL_CLASS_MISSING`      | A Durable Object binding names a class the bundle does not export               | Build fails before bundling              |
| `DPL_ENV_LIMIT`          | Lambda environment over 4 KB                                                    | Build fails with the overage             |
| `DPL_UNSUPPORTED_TARGET` | Target not configured                                                           | Lists valid targets                      |
| `DPL_LISTENER_NOT_FOUND` | Event routed to a unit with no matching `@OnSns`/`@OnEventBridge`/`@OnStepTask` | Runtime throw (SNS retries on next poll) |
| `DPL_PUBLISH_UNKNOWN`    | `publish(topic, …)` for a topic no `@OnSns` listener subscribes to              | Build fails, names the topic             |
| `DPL_INVOKE_UNKNOWN`     | `invokeUnit(unit, task, …)` for a task no `@OnStepTask` handles                 | Build fails, names the unit and task     |

---

## 8. Security considerations

- Least-privilege bindings per unit: the HTTP unit has no queue consumer binding; the queue unit has no route table at all.
- No `eval`, no dynamic import by module name at runtime (units import statically).
- Health/metrics unit may be separate so that internal metrics are never publicly routable.
- `compatibility_date` is pinned in generated config; bumping it is a reviewed change with a regression test pack.
- Lambda environment variable count/size limits checked at build (`DPL_ENV_LIMIT`).

---

## 9. Open questions

| #    | Question                                                                                                                                                                                    | Blocks                                                                                                                                                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Q1` | Ship `bun build --compile` single-binary support for the `bun` target? Defined in [`00-foundation.md § 6`](../roadmap/00-foundation.md#6-open-questions); this module owns the deploy half. | Phase 6                                                                                                                                                                                                                                                                                                                              |
| Q21  | Do we generate Terraform in addition to SAM/CDK, or pick one? Current: SAM + CDK snippets, Terraform later.                                                                                 | Phase 6                                                                                                                                                                                                                                                                                                                              |
| Q22  | Azure Container Apps / Google Cloud Run targets — out of scope for v1? Current: yes, adapter interface kept open.                                                                           | —                                                                                                                                                                                                                                                                                                                                    |
| Q23  | Workers Queues vs a Postgres-backed queue for `queue` unit on edge (Postgres driver over Hyperdrive has no LISTEN/NOTIFY).                                                                  | Phase 6. **Partly answered in `15-capabilities.md` § 4.2:** Postgres is the correctness default on every target (`SELECT … SKIP LOCKED`, no LISTEN/NOTIFY needed); the deploy adapter must emit a _trigger_ — a `scheduled` drain on Workers, EventBridge on Lambda — and Queues/SQS are opt-in only with the `@tsir/events` outbox. |

---

## 10. Task index

[`tasks/07-deploy.md`](../tasks/07-deploy.md) — `DPL-001` … `DPL-031`.
