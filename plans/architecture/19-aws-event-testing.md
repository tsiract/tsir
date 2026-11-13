# Local AWS emulation: what each tool can prove about our event services

_Status: read complete for both tools at pinned releases. The blocker this document named —
`INF-005` ([`../tasks/16-infrastructure-hardening.md`](../tasks/16-infrastructure-hardening.md)) —
is **fixed** (§ 5 records both the failure and the fix, because the failure is the best evidence for
why the substrate work in § 4 is worth doing). What remains open is § 6: no emulator has actually
run, so no ledger row has moved._

Tsir's AWS story is written in decorators: `@OnSns`, `@OnEventBridge`, `@OnStepTask`
([`../../src/framework/router/src/decorators.ts`](../../src/framework/router/src/decorators.ts)),
plus the `sqs` queue driver and the SES transport. This document answers three questions with
sources rather than preference:

1. What can **each local emulator** actually do — its execution model, not its marketing?
2. Which of **our** services can each one verify, and which claims would it silently pass?
3. What must **we** fix before either tool can verify anything at all?

## 1. Why this is not a tool review

Two tools exist, and they are not the same kind of thing. **AWS Emulator** is AWS's own emulator,
released 2026-11-11, licensed CC0, which answers the AWS HTTP APIs. **LocalStack** is a
commercial emulator whose free community edition was retired on 2026-03-23 and replaced by a
token-gated unified image with a non-commercial Hobby tier.

Choosing between them on "which emulates more" would miss the point. The question that decides
our work is narrower: **for each AWS operation our code calls, does the tool run the behaviour we
depend on, or does it accept the call and return something plausible?** § 3 answers that per
service. § 5 is the part that matters most: neither tool can verify a single one of our AWS
decorators today, because our own emitter drops them.

## 2. AWS Emulator

**Read at `v1.0.341`** (tag `7eb5bf3`, 2026-11-13). Per-operation verdicts, derived from the
handler sources and cross-checked on every test run, live in
[`../../src/tools/aws-emulator.ts`](../../src/tools/aws-emulator.ts) and the review of 2026-11-13
in `plans/reviews/`.

### 2.1 Execution model — the thing that decides everything

|                  | How it works                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport        | HTTPS only, `127.0.0.1:9297`, self-signed CA (`~/.aws/emulator/<port>/`), **SigV4 required** by default; `-a off` exists for exploration                                                                                                          |
| Lambda `nodejs*` | **QuickJS** (`rquickjs`) embedded in the emulator process. It resolves the handler's module out of the package zip (ESM and CommonJS), builds the context, calls the handler, serialises the return value. It is a real run, in-process          |
| Lambda `python*` | an embedded interpreter, same shape                                                                                                                                                                                                               |
| Core modules     | `path`, `util`, `events`, `buffer`, `crypto`, `fs`/`fs/promises` (an in-memory filesystem), `timers`, `timers/promises`, `stream`, `string_decoder`, `os`, `assert`, `url`, `querystring` — **and nothing else**                                 |
| Not supplied     | `net`, `http`, `https`, `worker_threads`, `child_process`. An unsupplied module is simply unresolvable — "nothing here pretends to be a module it is not"                                                                                         |
| Globals          | `process` exists with the invocation's own environment; there is **no `Bun`** global                                                                                                                                                               |
| Event sources    | SQS event source mappings are really polled (`ReportBatchItemFailures` is read); EventBridge schedule rules really fire and deliver the scheduled envelope; API Gateway `AWS_PROXY` → Lambda → downstream service runs end to end (its own suite asserts exactly that pipeline) |
| Concurrency      | in-process; no container per invocation                                                                                                                                                                                                            |

**What this means for us:** our Lambda target is `bun build --target=node --format=esm`
(`ns`-external packages, ESM output). QuickJS executes ESM and CommonJS, so a bundle *can* run
here — but a bundle that reaches the network at import time imports a module the emulator does not
supply and dies. That is a testable property of our artifact, and it has never been measured.

### 2.2 Fidelity, as published

The emulator publishes a per-release scorecard (`scores.json.gz`). At `v1.0.322` it passed
**24,243 of 42,857** scored checks (**56.6%**). Per service: KMS 93.9%, SQS 89.8%,
**Lambda 51.9% (3,006 tests)**. CloudFormation is 15.8% — it passes 414 of 2,612 checks.

A percentage is not a verdict, and the two published readings of the same release disagree on
Lambda (46.4% in one, 51.9% in another), which is itself a reason not to reason from the number.
The useful unit is the operation, in the shape of *our* call — which is what
`src/tools/aws-emulator.ts` encodes. Note also the contrast that matters: a medium-coverage
Lambda still passes **4/4 workflow checks** (create and invoke a `python3.12` zip, handler
exception surfaces as `FunctionError`, `boto3` called from inside the function) and **3/3 Step
Functions checks** (Choice, Wait, a Lambda task, a Fail state). Coverage measures breadth; a
workflow check measures the path we actually walk.

### 2.3 Limitations AWS states, and the ones it does not

| Limitation                                        | Consequence for us                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **No IAM or policy evaluation**                   | our SAM role statements, the SQS poller's role check, and `DPL-020`'s secret scan prove nothing here      |
| **One account, one region** (`000000000000`)      | any cross-region or multi-account assertion is out of reach                                              |
| **Verified in `us-west-2` only**                  | global services checked in `us-east-1`; regional behaviour elsewhere is unmeasured                       |
| No throttling, no outage simulation               | retry-on-throttle behaviour cannot be tested                                                             |
| **No `initDuration`**                             | C4 (`DPL-014`) can never be discharged here — a number from an in-process run is a number about the host  |
| No container-image Lambdas                        | our `nodejs22.x` zip path is fine; a future image target is not                                          |
| `nodejs*` is QuickJS, not Node                    | passing here is necessary evidence, not sufficient evidence, for the real runtime                        |
| Telemetry on by default                           | `--telemetry off` / `EMULATOR_TELEMETRY=off`, or a `config.toml`; our probe never turns it on             |

### 2.4 Running it

Linux RPM/DEB, or a container built from AWS's Dockerfile (no published image; 2 GiB cap).
Blob downloads come from `objects.githubusercontent.com`, so a sandbox that can only reach
`github.com` can read the source but cannot install the binary — which is this repository's
sandbox, and why the table is cross-checked against 13 vendored handler files instead.

## 3. LocalStack

**Read at the 2026 documentation set** (docs.localstack.cloud, licensing page dated 2026-03-23).
LocalStack is not in this repository and nothing here pins it yet.

### 3.1 Licensing changed, and it decides how we may use it

- On **2026-03-23** the standalone free Community edition was **discontinued**. There is now one
  unified image that requires an **auth token** for every run.
- **Hobby** is free for **non-commercial individual use**, and includes **no CI credits**.
- Base and Ultimate are paid per licence (from ~$39/month, annually); EventBridge Pipes is
  Ultimate-and-up.

That is a real constraint for a framework whose gates must run on a contributor's machine and in
CI: a commercial project pointing CI at LocalStack needs a paid plan, and the token means CI
holds a credential that the AWS Emulator path never needs.

### 3.2 Execution model

|                  | How it works                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Transport        | one edge port, `4566`, plain HTTP; any non-empty credentials by default                                                             |
| Lambda           | **real runtime containers via Docker** — needs the host socket (`/var/run/docker.sock`)                                             |
| Event sources    | event source mappings for **SQS, DynamoDB, Kinesis** (MSK and self-managed Kafka are licensed); `ReportBatchItemFailures` on SQS is full |
| EventBridge      | custom buses, rules, and targets: Lambda, SNS, SQS, Step Functions, Firehose, a bus, an API destination, Kinesis, a log group, API Gateway |
| API Gateway      | V1 113/124 operations, V2 (HTTP + WebSocket) 73/103; real routing, real integration invoke                                          |
| Developer hooks  | `/_localstack/health`, `/_aws/sns/...` — published messages can be read back, which the AWS Emulator has no equivalent for          |

Because Lambda runs in a container with the genuine runtime image, **module availability is the
whole Node runtime**, not a curated subset. That is the single biggest behavioural difference from
the AWS Emulator for our purposes.

### 3.3 Limitations LocalStack states

- **Resource policies are stored, not evaluated.** Private APIs are reachable without a VPC
  endpoint. Lambda authorizer results are not cached (`authorizerResultTtlInSeconds` has no
  effect).
- Stage throttling, caching, access logging, execution logging and X-Ray tracing **have no
  effect**; the integration timeout is not applied; response streaming is unsupported.
- Custom domains get LocalStack's own certificate; mTLS settings are ignored.
- Cold-start timing and VPC integration **differ from AWS**.
- Multi-concurrency is not yet available — each parallel invocation gets its own container.
- Load and performance characteristics are not comparable to AWS.

## 4. Which to weight, and for what

Neither tool is "the" test environment; they answer different questions at different costs.

| Question                                                                 | AWS Emulator                          | LocalStack                                        |
| ------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------- |
| Does our bundle **run** at all, with the real module graph?               | partly (QuickJS + curated modules)     | **yes** (real Node container)                     |
| Does our **SigV4 client** sign what the platform accepts?                 | **yes** — strict by default            | no — any non-empty credentials are accepted       |
| Does the **SQS→Lambda→SNS fan-out** reach the right handler?              | yes (pollers and rules are real)       | **yes**, with clearer logs and readable topic state |
| Is our **IAM** story right?                                              | no                                     | no (Pro/paid adds enforcement)                    |
| Is our **cold start** acceptable?                                        | no                                     | no                                                |
| Can CI run it with **no token, no Docker, no account**?                   | **yes (a binary)**                     | no (image + auth token)                           |
| Can a contributor see **what was published** without writing a consumer?  | no                                     | **yes** (`/_aws/sns/...`)                         |

**Recommended weighting.** Two tiers, because the cheap one should run on every push and the
expensive one should not:

1. **Every push, in CI, no credentials — AWS Emulator.** One binary, no container, no token. It
   proves the control plane and the event wiring: `CreateFunction`/`Invoke`, the SQS mapping with
   `ReportBatchItemFailures`, the EventBridge rule firing, SNS `Publish` reaching a subscription.
   It is the only one of the two that can live in a workflow that holds no secret.
2. **On demand, and nightly — LocalStack**, when a claim needs a genuine Node runtime or a
   readable topic/queue state. This is where "our bundle imports something QuickJS lacks" would be
   settled *definitively*, and where a Step Functions integration beyond the emulator's checks
   would run. It requires a plan decision first (Open question `Q75`).

A gate that cannot run on a contributor's machine without a token is not a gate; it is a
convenience. The weighting follows from that, not from fidelity tables.

## 5. The blocker was ours — and it is fixed

Everything above is theory until the emitter produces a bundle with a handler in it. On
2026-11-13 it did not. Reproduced then against the tree, for a unit whose only trigger was `@OnSns`:

```text
$ …adapterTriggers({kind:'queue', triggers:[{kind:'sns', detail:['orders']}]})
adapterTriggers(sns-only) = []
adapterTriggers(eventbridge-only) = []

$ …unitEntrySource({ target: 'lambda', unit: 'notify', triggers: [] })
// Generated by `tsir deploy:build` for unit "notify" — do not edit.
// Triggers:  · entry exports:
import { toLambdaHandler } from "../deploy/src/lambda.ts";
import {  } from "../app/src/index.ts";

export const handler = toLambdaHandler({
  unit: "notify",

});
```

Four facts stood behind it, and they are worth keeping because they explain why the fix is shaped
the way it is:

1. **`adapterTriggers` had three outputs and no AWS ones.** `TRIGGER_ORDER` was
   `fetch | queue | scheduled`; `sns`, `eventbridge` and `manual` mapped to nothing, so a
   listener-only unit was **skipped with a warning** rather than built.
2. **The template still promised a function.** `samTemplate()` ran over the whole graph, so
   `template.notify.yaml` was written anyway — `AWS::Serverless::Function`, `Handler: index.handler`,
   `CodeUri: .`, an SNS subscription and an invoke permission — for a directory with no `index.js`.
   The stack would deploy a function with no code.
3. **The runtime was already correct.** `toLambdaHandler` classified SNS
   (`Records[].EventSource === 'aws:sns'`), EventBridge (`source` + `detail-type`) and schedules, and
   dispatched to `unit.sns` / `unit.eventbridge` / `invoke`. The adapter was never the gap.
4. **The compiler was already correct, and unused.** `compileListeners()` maps `@OnSns` by topic,
   `@OnEventBridge` by `detail-type` and `@OnStepTask` by name into a `LambdaUnit`, with the
   `validate` boundary on the declared body. Nothing in the build called it.

### 5.1 Why it could not be fixed by "just mapping the trigger"

The obvious fix — adding `sns` and `eventbridge` to `TRIGGER_ORDER` — produces
`import { sns as __sns } from "…/app.ts"`, and no application exports a field called `sns`. The
builder needs the **controller classes**, and a class reference cannot be written into generated
source. The bundler is the only thing that can turn `@OnSns({ topic })` into a callable, and it can
only do that if the generated entry imports the app and asks *it* for the module list.

So the fix is: the entry exports its `defineApp` handle (already the documented contract), the
generated entry calls `listenerUnitFor(app)` from `@tsir/deploy/listeners`, and that compiles the
app's own `routeModule`s through `compileListeners`. One import, no serialised references, and the
module list a bundle compiles is the list a boot resolves.

Three adjacent bugs surfaced while making that path run for real, which is the argument for running
it rather than reasoning about it:

| Bug                                                                     | Why it mattered                                                                                                                    |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A controller with **only** listeners threw `RTR_EMPTY_CONTROLLER`        | The one shape an event-only controller has was rejected by the route compiler. A controller with listeners is not an empty one      |
| Three listeners naming the same `unit` produced **three** functions      | `units.ts` resolved the second and third under a `queue` kind, so one controller became `sns`, `schedule` and `admin`               |
| The EventBridge `EventPattern` nested `detail-type` under `source:`      | Invalid CloudFormation, and an empty `source:` mapping is a rule that matches nothing — a silent no-op after a green deploy          |

### 5.2 The failure mode this leaves behind

A `defineApp` handle is present and correct, `deploy:build` succeeds, and the bundle still contains
no listeners — because `"sideEffects": false` in a package.json let the bundler drop the
`import "./x.controller.ts"` that performs the registration. The build *cannot* catch this: it
imports the app directly, so it sees the controller the bundle never gets. Measured, not theorised:
disabling one `sideEffects` entry turned a working bundle into one that answered every event with
`DPL_UNIT_EMPTY`.

The fix is at module init, where only the bundle can know: `listenerUnitFor(app, { unit, expect })`
throws `DPL_LISTENER_NOT_BUILT` when a trigger the graph recorded has no handler in the bundle. The
platform reports an init error; the alternative is a function that accepts every event and ignores
all of them.

### 5.3 What this proves, and what it still does not

`deploy-build.test.ts` builds the `listener-app` fixture, imports the emitted `index.mjs`, and sends
an SNS envelope, an EventBridge event and a Step Functions task through it — each reaching its
decorated method. That is a **local** proof: our emitter, our adapter, our bundler, in this process.
It is not `C3` (a real account), not `C4` (a real runtime's cold start), and not `C5` (`sam
validate` against a real transform). Those stay open and stay labelled open.

**Neither emulator was needed to find any of this, and neither could have.** That is the honest
conclusion of § 2–4: the substrate question only becomes worth paying for once our half of the path
carries events at all, which is now true.

## 6. Closing the gaps

Steps 1–3 are **done** (2026-11-13, § 5). What remains is substrate work, and it is deliberately
last: an emulator pointed at a path that carries nothing proves nothing.

| #   | Change                                                                                                | State | Acceptance test                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| 1   | `TRIGGER_ORDER` gains `sns`, `eventbridge` and `invoke`; `requiredExports()` stops demanding them      | done  | `adapterTriggers` returns `['sns']`, `['eventbridge']`, `['invoke']`; `requiredExports` returns `[]`   |
| 2   | `deploy:build` compiles each listener unit from the app (`listenerUnitFor`) instead of empty wiring     | done  | the emitted entry imports the app, and dispatch works after import — not just after `bun build`        |
| 3   | A unit that is skipped no longer gets a template; a bundle that lost its listeners fails at init        | done  | no `template.<unit>.yaml` without a bundle; `DPL_LISTENER_NOT_BUILT` from the bundle, not the build     |
| 4   | **AWS Emulator probe** creates that function, publishes to the topic, asserts the handler ran          | `INF-021` | `make aws-emulator` with a bundle: `Publish` → handler observed, in a job holding no credentials   |
| 5   | **LocalStack probe** runs the same bundle in a real Node container, so a module QuickJS lacks fails first | `INF-022` | the same assertion under LocalStack, plus reading `/_aws/sns/…` to show what was published          |
| 6   | `deploy:invoke` gains SNS and EventBridge fixtures, as `http` and `queue` already have                  | `DPL-032` | every decorator has a local fixture                                                                   |
| 7   | The `sqs` driver's conformance kit gets an injected clock (it assumes a virtual one)                    | `INF-007` | the kit passes against a live broker — this blocks "SQS verified", not the emulator                   |
| 8   | C3 closes: the same invoke path against a real account, once                                            | `C3`      | an evidence line in [`../tasks/07-deploy-cloud-checks.md`](../tasks/07-deploy-cloud-checks.md)        |

Step 5 depends on `Q75` (licence); step 4 depends on nothing but a machine that can run the binary.

### What this buys, honestly

| Claim                              | Before | Now (local, steps 1–3)            | Still needs real AWS        |
| ---------------------------------- | ------ | --------------------------------- | --------------------------- |
| `@OnSns` reaches the right method  | untested | **verified** — build → invoke   | —                           |
| `@OnEventBridge` by `detail-type`  | untested | **verified** — build → invoke   | —                           |
| `@OnStepTask` via direct invoke    | in-process only | **verified** — build → invoke | IAM for `states:StartExecution` |
| Only-listener controllers compile  | rejected (`RTR_EMPTY_CONTROLLER`) | **verified** | —                |
| SQS partial-batch failures         | fixture | fixture                           | redrive and backoff timing  |
| Schedule fires `scheduled`         | fixture | fixture                           | clock skew, timezones       |
| The bundle runs on `nodejs22.x`    | untested | untested                          | **yes — `C4`**, plus `INF-021`/`INF-022` |
| IAM, quotas, throttling            | untested | untested                          | **yes**                     |
| `sam validate`, cold start         | untested | untested                          | **yes — `C5`, `C4`**        |

## 7. Failure modes

| Failure                                                        | Why it happens                                                          | How it is reported                                                    | What the caller can do                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A listener unit deploys as an inert function                  | `"sideEffects": false` let the bundler drop the registration import | `DPL_LISTENER_NOT_BUILT` at **module init**, naming the package.json | declare the controller files under `sideEffects`, or drop the flag |
| A bundle passes the emulator and fails on Lambda               | QuickJS supplies a curated module set, not Node                          | import error at invoke time on the real runtime                         | no `net`/`http` at import time; confirm the module list in § 2.1          |
| A gate needs a LocalStack token in CI                          | the unified image requires auth since 2026-03-23                        | the workflow needs a secret it should not hold                          | keep the tokenless tier (AWS Emulator) as the per-push gate; see `Q75`    |
| A multi-service test fails opaque reasons                      | CloudFormation fidelity is 15.8% in the emulator                        | stack never leaves `CREATE_IN_PROGRESS`, or a 501                      | provision with the SDK calls, not through a stack, when testing behaviour |
| "It passed locally" but the ledger says open                   | a pass in an emulator is not C3/C4/C5 evidence                           | nothing — this is the trap                                             | only a filled-in evidence line moves a `[~]` row                          |

## 8. Security considerations

- **Neither tool evaluates IAM.** A green run says nothing about whether the deployed role can do
  what the test just did. Permission design stays with static review and the real account.
- **SigV4 is the one place the tools differ sharply.** The AWS Emulator rejects an unsigned
  request by default; LocalStack accepts any credentials. A signing bug therefore *passes* on
  LocalStack and *fails* on AWS and on the emulator. Our `@tsir/storage` signer is exactly the code
  that would hide there.
- **A stored token is a credential.** LocalStack's auth token belongs in the CI secret store, used
  from a trusted branch only, never in `tsir.js` or an emitted artifact. `DPL-020`'s scanner covers
  the artifacts; it does not cover CI configuration.
- **Emulated data is not real data**, and the emulator's in-memory store has no access control
  between "accounts" because there is only one.

## 9. Open questions

| Id   | Question                                                                                                                                                     | Blocks                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `Q74` | Does the AWS Emulator stay usable in CI as a floating binary, or do we pin a release and vendor it like a fixture? The fidelity table is tag-specific, so a floating version silently changes what "verified" means | step 4                        |
| `Q75` | Which LocalStack tier may a commercial consumer of this framework use, and may CI carry its token? Hobby is non-commercial and has no CI credits                | step 5                        |
| `Q76` | Should `deploy:invoke` be the only local entry point, with both emulators driven through it, or should `make aws-emulator` remain its own surface?            | steps 4–6                     |

## 10. Task index

| Ledger                                                                              | Rows                                      |
| ----------------------------------------------------------------------------------- | ----------------------------------------- |
| [`../tasks/16-infrastructure-hardening.md`](../tasks/16-infrastructure-hardening.md) | `INF-005` (**done**), `INF-021`, `INF-022`, `INF-007`, `INF-017` |
| [`../tasks/07-deploy.md`](../tasks/07-deploy.md)                                     | `DPL-026`…`DPL-030`, `DPL-013`             |
| [`../tasks/07-deploy-cloud-checks.md`](../tasks/07-deploy-cloud-checks.md)           | C3, C5, C6 — what no emulator can discharge |
| [`../reviews/2026-11-13-aws-emulator.md`](../reviews/2026-11-13-aws-emulator.md)     | the per-operation read of the AWS Emulator |
| [`../../src/tools/aws-emulator.ts`](../../src/tools/aws-emulator.ts)                 | the check; `make aws-emulator` runs it     |

### Sources

- AWS Emulator: `github.com/aws/aws-emulator` at `v1.0.341`; announcement
  `aws.amazon.com/about-aws/whats-new/2026/11/aws-emulator-now-available/`; fidelity counts at
  `v1.0.322` per the release scorecard as reported by i-scoop and MarkTechPost (2026-11-12).
- LocalStack: `docs.localstack.cloud/aws/licensing/` (dated 2026-03-23), `…/services/lambda/`,
  `…/services/events/`, `…/services/apigateway/` (read 2026-11-13).
