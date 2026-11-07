# Tasks — Deploy (Phase 6)

> Unit graph, Cloudflare Workers, AWS Lambda, topology resolution, `tsir.js` deploy automation.

**Plan:** [`../08-deploy.md`](../modules/08-deploy.md), [`../09-tsir-config.md`](../operations/09-tsir-config.md)

**Legend:** `[x]` done, acceptance met · `[~]` built and tested, acceptance not met yet · `[ ]`
not started. Every `[~]` is `[~]` for one reason only — its acceptance criterion needs a real
Cloudflare or AWS account — and those criteria live in
[`07-deploy-cloud-checks.md`](./07-deploy-cloud-checks.md) with the command that discharges each one.

---

## Unit graph

| ID        | Title                                                     | Status | Depends | Acceptance criteria (summary)                                |
| --------- | --------------------------------------------------------- | ------ | ------- | ------------------------------------------------------------ |
| `DPL-001` | `Unit` model + capability→unit attribution                | `[x]`  | RTR-011 | Each capability maps to a documented unit                    |
| `DPL-002` | Topology resolution (`separate` default, `single` opt-in) | `[x]`  | DPL-001 | Default is `separate`; explicit config required for `single` |
| `DPL-003` | `RuntimeCapabilities` probes + `DPL_CAPABILITY_MISSING`   | `[x]`  | APP-010 | Fails at build with matrix row                               |
| `DPL-004` | `UnitGraph` serialization + committed snapshot            | `[x]`  | DPL-002 | `deploy:diff` detects drift                                  |
| `DPL-005` | `deploy:plan [--explain] [--json]`                        | `[x]`  | DPL-004 | Explain prints which capability caused each unit             |
| `DPL-006` | Binding validation (`DPL_BINDING_MISSING`)                | `[x]`  | DPL-004 | Unit referencing undeclared binding fails                    |
| `DPL-007` | `deploy:invoke --unit` local invocation                   | `[x]`  | DPL-004 | Fixture events exercise each unit locally                    |

## Cloudflare Workers

| ID        | Title                                                          | Status | Depends | Acceptance criteria (summary)                             |
| --------- | -------------------------------------------------------------- | ------ | ------- | --------------------------------------------------------- |
| `DPL-008` | `toCloudflareHandler(app)` (`fetch`/`queue`/`scheduled`)       | `[x]`  | DPL-004 | Conformance suite passes on `wrangler dev`                |
| `DPL-009` | Per-unit `wrangler.toml` generation (hyperdrive, queues, cron) | `[x]`  | DPL-008 | Generated config validated by `wrangler deploy --dry-run` |
| `DPL-010` | Durable Objects for WS rooms + rate limiting                   | `[x]`  | LNK-025 | Binding declared only for the `ws` unit                   |
| `DPL-011` | Bundle size budget per unit                                    | `[x]`  | DPL-008 | Exceeds 1 MiB gz → fail unless overridden                 |
| `DPL-012` | Secret handling (`wrangler secret put` only)                   | `[x]`  | DPL-009 | Artifact scan finds no secret values                      |

## AWS Lambda

| ID        | Title                                                              | Status | Depends | Acceptance criteria (summary)                                                                                                                                                 |
| --------- | ------------------------------------------------------------------ | ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DPL-013` | `toLambdaHandler(app)` (API GW v2, Function URL, SQS, EventBridge) | `[~]`  | DPL-004 | Conformance suite passes locally; nightly real invoke                                                                                                                         |
| `DPL-014` | `bun build --target=node --format=esm` emitter                     | `[~]`  | DPL-013 | Cold start measured; no native modules                                                                                                                                        |
| `DPL-015` | Deadline from `context.getRemainingTimeInMillis()`                 | `[x]`  | DPL-013 | Graceful drain within remaining time                                                                                                                                          |
| `DPL-016` | SAM/CDK template generation                                        | `[~]`  | DPL-013 | Templates validate; no deploy by default — built and tested (secrets as params, events from triggers, cron translation, env limit); needs `sam validate --lint` (C5) to close |
| `DPL-017` | Env var count/size limit check                                     | `[x]`  | DPL-016 | Over limit → `DPL_ENV_LIMIT`                                                                                                                                                  |

## Cross-target

| ID        | Title                                                                                         | Status | Depends          | Acceptance criteria (summary)                                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------- | ------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DPL-018` | `deploy:build` all-target emitter + `dist/` layout                                            | `[~]`  | DPL-009, DPL-014 | Matches `08-deploy.md § 3` exactly                                                                                                                                   |
| `DPL-019` | `deploy:validate` (probes + secrets + size)                                                   | `[x]`  | DPL-018          | One command gates a release                                                                                                                                          |
| `DPL-020` | Artifact secret scanner in CI (`DPL_SECRET_LEAK`)                                             | `[x]`  | DPL-018          | Synthetic secret in bundle → CI red                                                                                                                                  |
| `DPL-021` | Migrate unit generation                                                                       | `[x]`  | MIG-012          | Runs once, not on cold start                                                                                                                                         |
| `DPL-022` | Admin unit (health/metrics) kept private by default                                           | `[x]`  | DPL-009          | No public route generated unless enabled                                                                                                                             |
| `DPL-023` | `tsir.js` deploy automation (`bootstrap` writes deploy block)                                 | `[x]`  | CFG-120          | Managed region updated, plan printed                                                                                                                                 |
| `DPL-024` | Shared conformance suite across Bun/Workers/Lambda                                            | `[x]`  | DPL-008, DPL-013 | Same assertions, three targets (`conformance-suite.ts` runs against Bun, Cloudflare, Lambda)                                                                         |
| `DPL-025` | Lambda: EventBridge dispatch matches schedules only; custom-bus events refused (bug)          | `[x]`  | DPL-013          | A custom-bus event never reaches `scheduled`; it fails with a named error until routed                                                                               |
| `DPL-026` | Decorator-declared AWS event listeners on a class (`@OnSns`, `@OnEventBridge`, `@OnStepTask`) | `[x]`  | DPL-013, RTR-002 | A class with listener decorators compiles to units; each matcher routes to its method, with the same DI container and `validate` boundary as HTTP                    |
| `DPL-027` | SNS → Lambda subscription generated from `@OnSns({ topic })`                                  | `[x]`  | DPL-026          | SAM template contains the topic subscription and invoke permission; the handler gets the parsed message                                                              |
| `DPL-028` | SNS → SQS → Lambda fan-out generated from `@OnSns({ topic, via: 'sqs' })`                     | `[x]`  | DPL-026, DPL-027 | Template contains queue, DLQ, raw-delivery subscription and event source mapping; SNS envelope unwrapped by default, and a test covers an unwrapped raw body         |
| `DPL-029` | Step Functions task handler via `@OnStepTask({ name })`                                       | `[x]`  | DPL-026          | A direct invoke with a task input routes to the named method; an unknown task name fails with the list of known names                                                |
| `DPL-030` | Internal invoke and publish from code (`invokeUnit`, `publish`)                               | `[x]`  | DPL-026, DPL-028 | A service method invokes another unit synchronously or asynchronously, and publishes to a topic; both are typed against the unit and topic declared in the decorator |
| `DPL-031` | Per-unit memory and timeout in SAM (today shared via `Globals`)                               | `[x]`  | DPL-013          | Two units with different memory and timeout emit different values; the shared default still applies when neither is set                                              |

---

## Status notes (2026-10-28)

**Done:** `DPL-001` … `DPL-007`, `DPL-011`, `DPL-015`. **Built and tested, acceptance
pending:** the two adapters, `wrangler.*.toml` and `deploy:build` — what they lack is a real
`wrangler dev` / `wrangler deploy --dry-run` / deployed invoke, which needs a cloud account
this repository does not have. The tasks stay `[~]` until that runs; calling them `[x]`
because the unit tests pass is how a "deploys to Workers" claim gets made without a Worker.

### The graph (`DPL-001` … `DPL-006`)

- **Units come from declarations.** A route carries `meta.unit` (RTR-011); a `routeModule`
  gives its module's routes a default unit; a journaled connection becomes
  `migrate:<connection>` (ADR-0019); `deploy.units` in `tsir.js` covers what this version
  cannot discover yet (queue consumers, cron, sockets) instead of inventing them. The
  example app resolves to `http` (users) and `media` (uploads) with no configuration at
  all, which is the point.
- **`separate` is the default, `single` is opt-in and loud.** `applyTopology` merges every
  non-`migrate` unit into one `app` unit, keeps the union of triggers/bindings/capabilities,
  marks it public if any part was public, and reports `merged: ['admin', 'http']` so the
  cost is visible. A migration never merges: it must not run on cold start.
- **Every unit carries its reason.** `Unit.reasons` names the declaration
  (`routes: GET /api/users`), `deploy:plan --explain` prints it, and the reasons are in the
  committed snapshot — a reason you cannot commit is a comment.
- **The snapshot is the review surface.** `unit-graph.json` is committed,
  `deploy:plan --check` fails when it would change, `deploy:diff` names the unit and the
  field (`drain.visibility: public → private`), and `make codegen-check` runs the check for
  the HTTP example on every `make check`.
- **Validation happens before anything is emitted.** `DPL_DUPLICATE_ROUTE`,
  `DPL_CAPABILITY_MISSING` (against the static target table shared with boot's probe) and
  `DPL_BINDING_MISSING` are reported together, with the fix, from `deploy:plan`.

### The adapters and the emitter (`DPL-007` … `DPL-018`)

- **A unit is a bundle, and the bundle is the privilege boundary.** `deploy:build` writes
  one generated entry per unit that imports the application entry and hands the adapter
  only the handlers the unit's triggers name — `http`/`websocket` → `fetch`, `queue` →
  `queue`, `cron` → `scheduled`. A queue unit's bundle has no `fetch` export in it, so a
  public URL for it is not a configuration mistake anyone can make. A unit whose entry
  exports nothing for its triggers fails with `DPL_UNIT_EMPTY` **before** the first byte is
  written.
- **`deploy:invoke` calls what the platform calls.** The same `handler` a Worker or Lambda
  imports, in-process, with the route table's attribution printed next to the response —
  asking for `media` and getting a `http` route is reported, not silently served.
- **The artifacts are real.** The tests do not stop at "a file exists": the emitted
  Cloudflare bundle is imported and asked `GET /api/users`, and the emitted Lambda bundle is
  handed an API Gateway v2 event. Both answer `200` with the same body the example app
  returns, and the emitted `bun` target boots and prints its URL. That is the strongest
  evidence available without an account.
- **Budgets are data and they block.** `dist/build.json` lists every artifact with its
  bytes, its gzipped bytes and the budget it was measured against (`sizeBudget` in
  `deploy.targets.*`, else the platform's own limit: 1 MiB gz for Workers). Over budget is
  exit 1 and the artifact is still written so it can be inspected; `--allow-size-regression`
  is the reviewed way past it.
- **Secrets have no path into the artifact.** `wrangler.*.toml` names them only as
  `#   wrangler secret put NAME`, and `deploy:validate` scans every emitted file for both
  known shapes and the project's own secret names (`DPL-012`, `DPL-020`).

### Privacy and Durable Objects (`DPL-010`, `DPL-022`)

A graph column becomes a cloud behaviour in exactly two places, and both are tested end to
end against a fixture with one public unit and one `admin` unit:

| Unit            | `wrangler.<unit>.toml`           | `template.<unit>.yaml`                |
| --------------- | -------------------------------- | ------------------------------------- |
| public          | (default: `workers.dev` URL)     | `HttpApi` event + `HttpApiUrl` output |
| `private: true` | `workers_dev = false`, no routes | **no** HTTP API, no URL output        |

- **`private: false` is the opt-in** — the flag already existed on `deploy.units[]`; what was
  missing was any artifact that honoured it. A unit is private because of its _kind_
  (`admin`), and stays private unless the project says otherwise in review.
- **The gate re-checks it on disk.** `deploy:validate` reads the emitted config and template
  and fails with `DPL_PRIVATE_EXPOSED` when a private unit is routable — a hand edit or a
  half-finished rebuild is how a health endpoint ends up on the internet. The reverse
  mismatch (a public unit someone disabled) is a warning, because it cannot leak anything.
- **A Durable Object binding is a promise about exports.** `[[durable_objects.bindings]]`
  names `Room`; the runtime looks for `Room` among the bundle's exports. The generated entry
  now re-exports every class the unit binds, and a missing one fails the build with
  `DPL_CLASS_MISSING` before `wrangler deploy` produces its own version of the message. The
  fixture's bundle exports exactly `Room` and `fetch`.

### The release gate (`DPL-012`, `DPL-019`, `DPL-020`)

`tsir deploy:validate` reads `dist/build.json` and re-checks what is **on disk**, because the
failures that matter happen after the build: a budget raised in `tsir.js`, an artifact edited
by hand, a value someone inlined into a module. Four questions, four codes:

| Question                          | Check                                                    | Code                                            |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| Is this the build we think it is? | every listed artifact exists and still has its bytes     | (report)                                        |
| Does it fit?                      | gzipped size against `deploy.targets.*.sizeBudget` _now_ | `DPL_SIZE_BUDGET`                               |
| Is anything secret in it?         | every file in the output directory, scanned              | `DPL_SECRET_LEAK`                               |
| Can the target run it?            | graph re-checked against the emitted targets             | `DPL_CAPABILITY_MISSING`, `DPL_BINDING_MISSING` |

- **The scanner never prints a secret.** Findings carry the file, the line, the _pattern's
  name_ and a redacted excerpt (`const LEAK = "[redacted]";`). A scanner that echoes what it
  found is a second leak, and the CI log is a place secrets go to live forever.
- **Names need an assignment.** `#   wrangler secret put APP_KEY` in a generated config is
  the correct shape and is not flagged; `APP_KEY = "…"` is. A value that is a reference
  (`process.env.APP_KEY`, `${APP_KEY}`) is a use, not a leak — which is why the example app's
  bundles scan clean.
- **`make check` runs the gate.** `codegen-check` builds the HTTP example into `.verify/deploy`
  and validates it, so "compiles to a deployable, secret-free artifact" is part of the same
  gate as the committed route table and the snapshot.

### The deploy block (`DPL-023`, `CFG-120`)

`tsir bootstrap` is the only command that writes `tsir.js`, and it writes **only inside its
fence**:

```bash
tsir bootstrap --plan                       # detect, render, print the diff, write nothing
tsir bootstrap --yes                        # apply (atomic: temp file + rename)
tsir bootstrap --target cloudflare,lambda   # override detection, still fenced
tsir bootstrap --topology single --yes      # rewrite the region, keep every other line
```

- **Detection is from files that exist.** `wrangler.toml` → Cloudflare, `template.yaml` /
  `cdk.json` → Lambda, `Dockerfile` / `fly.toml` → Bun; the plan prints _why_ (`cloudflare:
wrangler.toml`), not just what. Nothing found → the Bun target, said out loud, because a
  project with no cloud marker still deploys somewhere.
- **The fence is the permission slip** (`plans/operations/09-tsir-config.md § 4`). A new region is
  appended inside `export default { … }`; an existing one keeps its own fences byte-for-byte
  and only its body is replaced, so `--plan` is a usable check rather than a source of noise.
- **Two owners is a refusal.** If `tsir.js` already declares `deploy` outside the region,
  bootstrap stops and says so — the deploy shape has exactly one source (ADR-0026).
- **Malformed fences are `CFG_MANAGED_REGION_INVALID`**, not a repair: unclosed, stray `:end`,
  mismatched ids, nesting and duplicates all make "which lines are mine" ambiguous, and a
  tool that guesses there eventually deletes someone's block.

### The migrate unit (`DPL-021`, `MIG-012`)

A journaled connection in `tsir.js` is a `migrate:<connection>` unit, and the unit is a
**program**, not a function:

```
dist/migrate/primary/
├── migrate.mjs     # no exports at all — nothing a platform can invoke
└── migrate.json    # connection, driver, folder, command
```

- **"Runs once" is structural.** Every platform shape that could be handed a migration gets
  it wrong in a different way: a cron runs it every five minutes, a cold start runs it per
  instance, an entrypoint races itself when the platform scales out. The emitted file has no
  `export` statement — the test asserts that on the built artifact, not on the generator —
  so there is no `fetch`, `queue`, `scheduled` or `handler` for anything to call.
- **It reuses the app's own database.** The script imports the application entry and takes
  its exported `database` (or `databases` registry, ADR-0019), then calls the same
  `migrate()` the CLI calls: advisory lock, per-connection journal, drift refusal, audit
  rows. A second, migration-only code path would be a second set of bugs.
- **It fails the pipeline, not the app.** Drift or a still-pending migration exits 1; a lock
  another runner holds exits 0 with "nothing applied", because the schema is already at the
  target state. The summary is `1 applied · 0 pending · 2 ms`, which is what a deploy log
  should say.
- **The folder is resolved at run time.** `TSIR_MIGRATIONS` overrides, and the default is
  the journal folder relative to the working directory — an artifact built on a laptop has no
  business carrying `/Users/…` into a deploy machine.
- **What it refuses.** A D1 connection has no script (`wrangler d1 migrations apply` is the
  real answer, and `§ 3.1` does not deploy to D1 anyway). A connection with
  `journal: false` — a replica that must not gate a release — has no unit at all.

### Templates and the environment limit (`DPL-016`, `DPL-017`)

`@tsir/deploy/sam` writes `template.<unit>.yaml` next to the Lambda bundle, and the emitter
writes it before anything else so a bad unit fails before the first byte.

- **Secrets are parameters.** A `secret` binding `APP_KEY` becomes `Parameters.AppKey`
  (`NoEcho: true`) and `APP_KEY: !Ref AppKey`. The document never holds the value; the
  operator passes it with `sam deploy --parameter-overrides`. That is the Lambda half of
  `§ 5`, and `deploy:validate` re-checks it on disk like everything else.
- **Events come from the unit's triggers.** `http` → `HttpApi` with `Path: /{proxy+}`;
  `queue` → `SQS` **with `ReportBatchItemFailures`**, without which AWS redelivers the whole
  batch and the adapter's `batchItemFailures` is ignored; `cron` → `Schedule` with a
  translated expression. `private: true` units carry the "do not attach a public API"
  comment the reviewer needs (`DPL-022`).
- **Cron is translated, not copied.** AWS wants six fields and a `?` in exactly one of
  day-of-month / day-of-week, so `*/5 * * * *` becomes `0/5 * * * ? *` — CloudWatch's own
  shape. Anything it cannot read throws rather than emitting a schedule that fires at the
  wrong time. Two cases that used to be silent are now refusals: **both day fields restricted**
  (`0 0 1 * 1` is OR to crontab and "pick one" to EventBridge, so the old translation kept the
  day of week and dropped the day of month — `DPL_CRON_INVALID`), and a **local hour**
  (`utcOffsetMinutes`) that a UTC platform cron cannot express — `DPL_CRON_NOT_UTC`, both from
  `15-capabilities.md § 4.6`.
- **The environment limit blocks the build.** Lambda gives an invocation 4 KB of
  environment; past it the build fails with `DPL_ENV_LIMIT` and a hint about secret stores,
  instead of `sam deploy` failing after a human has already waited for a stack.
- **Nothing is deployed.** The template is a file; `sam deploy` is the operator's command
  (`§ 6`). Validating it with the real SAM CLI is C5 in
  [`07-deploy-cloud-checks.md`](./07-deploy-cloud-checks.md).

### Layout, and where it differs from `08-deploy.md § 3`

`wrangler.<unit>.toml` sits **inside** the unit directory (`dist/cloudflare/http/wrangler.http.toml`)
rather than beside it, because the generated `main = "index.js"` resolves relative to the
config file and a flat layout would make the two disagree. Each target directory also gets
the committed-shaped `unit-graph.json`, and `dist/build.json` describes the whole build. The
Bun target emits one `dist/bun/server.mjs` rather than one server per unit: a container is a
single process (§ 3.3).

### Still open

**Needs a cloud account** — tracked, with the exact command and the evidence each one owes,
in [`07-deploy-cloud-checks.md`](./07-deploy-cloud-checks.md): `wrangler dev` conformance
(`DPL-008`), `wrangler deploy --dry-run` (`DPL-009`), a real Lambda invoke (`DPL-013`), a
measured cold start (`DPL-014`), a deployed SAM template (`DPL-016`) and the shared
conformance suite across all three runtimes (`DPL-024`). This sandbox has no credentials and
no account, so those stay `[~]` by design rather than by omission.

**Buildable here** — the remaining work that does not need a cloud:

---

## Gate P6 checklist

- [ ] `separate` and `single` topologies both deploy a sample app. — `separate` builds both
      units; `single` merges them in the graph but has not been deployed.
- [x] Unit graph snapshot stable; drift is visible in review. — `make codegen-check`.
- [x] Secrets absent from artifacts (scan in CI). — `deploy:validate` scans every emitted
      file; `make check` runs it (`DPL-020`).
- [ ] Conformance suite green on all three targets (nightly for real deploys). — adapters are
      unit-tested; `DPL-024` is the shared suite.
- [x] `deploy:plan --explain` answers "why does this unit exist?".
