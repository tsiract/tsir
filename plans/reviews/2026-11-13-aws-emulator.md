# AWS Emulator — what it can verify, and what it cannot

**Gate** P6 (deploy) · **Date** 2026-11-13 · **Reviewer** the author of the code · **Release
read** v1.0.341 (@ `7eb5bf3`, 2026-11-13)

> This review is the author's own, which is the limitation every review in this directory states.
> It is a **read of a tool**, not an audit of it: no emulator was run, because none can be run
> from this sandbox (§ 5). Everything below is derived from the emulator's published source at a
> pinned tag, and the derivation is mechanical — `src/framework/console/src/commands/emulator.ts` re-checks it, and
> `src/framework/console/src/commands/fixtures/aws-emulator/` holds the 13 handler files it is checked against.

---

## 1. Scope

**Read.** The emulator's `services/` tree at tag `v1.0.341` for the five services this repository
calls — SQS, SES v2, SNS, Lambda, EventBridge — plus `vendor/server/src/cli.rs` (the command
line), `vendor/smithy-server-runtime/src/pre_dispatch.rs` (how an unrouted operation answers), and
`issues/things-that-do-not-work/` (the emulator's own gap list). In this repository: every `src/`
file that imports an AWS SDK client or posts to an AWS endpoint, and
`plans/tasks/07-deploy-cloud-checks.md` C1–C8.

**Left out on purpose.** The other 433 service crates. CloudFormation (relevant only if we
generated CDK; we generate SAM YAML, which CloudFormation's emulation would not validate either).
IAM policy evaluation — the emulator's own documentation says not to test security with it, and
it does not evaluate policies, so nothing about authorisation can be concluded from a pass here.

## 2. The finding that changes the plan

**`Invoke` is implemented, and it runs the handler.** Two issues in
`issues/things-that-do-not-work/` — `20261022T213144Z-lambda-invoke-refuses-…` and
`20261024T055421Z-lambda-opensearch-s3-lambda-invoke-cannot-execute-…` — are in the repository at
this tag, and both say a synchronous `Invoke` answers `NotImplemented` because "there is no
in-process runtime". **Both are stale.** They were filed against commits `bd3308b` (2026-10-22) and
`7eba44b` (2026-10-24); the runtime they ask for landed **2026-11-10 → 11-12** (commits `097f2981`,
`2c37a7e0`, `2d4f5f9b`, all ancestors of `v1.0.341`), and the message they quote — "is not
implemented in this emulator" — **does not exist in `invoke.rs` at this tag** (0 occurrences; the
`execution::` path appears 17 times). `src/ops/invoke.rs` is 74 kB, and
`src/state/execution/node.rs` embeds **QuickJS** (`rquickjs`) to run `nodejs*` packages in-process:
it resolves the handler's module, builds the context, calls the handler, and serialises what it
returned. Python is served by an embedded interpreter the same way.

This is the situation the repository's own rejection of stubs (`plans/README.md`, tasks stay `[~]`
until evidenced) exists to catch, and the first draft of the tool caught it **by disagreeing with
this table**: the cross-check derived `written` for `Invoke` while the table said `absent`. Two
mistakes were behind that draft, and both are now encoded as regression tests:

1. **The selector read the wrong line** — it took the first code line after `fn handle`, which is
   `&self,` from the four-line signature, for _every_ handler. `selectorsIn` now brace-matches to
   the body (`src/framework/console/src/commands/emulator.test.ts`).
2. **The surface scan invented a prefix** — it looked for `SNS<Operation>Command`, but SDK v3
   command classes carry no service prefix (`PublishCommand`). It therefore found **no** SNS or
   Lambda calls in the whole repository and reported that only SES was called. Attribution is now
   per import statement, and a command in a file with two clients falls back to `ambiguous`
   instead of a guess.

Both are worth stating plainly: the first version of this tool would have told us "the emulator
serves SQS and SES only, and Lambda is unimplemented", which is wrong in the one place that
matters most for Phase 6.

## 3. What is verified, and how

One row per AWS operation this repository calls. Verdicts: `served` (the handler body is written),
`written-refusal` (written, with a 501 by design for a request member we do not send), `stub`
(scaffold refusal), `absent` (no handler). Every row is re-derived from the vendored source by
`crossCheck()`; `tsir deploy:verify` prints the re-derivation.

| Operation                         | Ours                                                   | Verdict         | What the emulator does with _our_ call                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SQS `SendMessage`                 | `queue/src/drivers/sqs.ts` → `backend.push`            | served          | empty-body refusal, allowed-character check, then the store; `DelaySeconds` honoured                                                                                                                         |
| SQS `ReceiveMessage`              | `queue/src/drivers/sqs.ts` → `backend.reserve`         | served          | visibility windows, long-poll wait, and `ApproximateReceiveCount` — the attribute the driver reads `attempts` from                                                                                           |
| SQS `DeleteMessage`               | `…` → `backend.complete` and the malformed-body branch | served          | receipt handle resolved against the queue it came from                                                                                                                                                       |
| SQS `ChangeMessageVisibility`     | `…` → `backend.fail` (retry)                           | served          | out-of-range timeout refused with the modelled parameter error; this is the driver's retry mechanism                                                                                                         |
| SQS `CreateQueue`                 | `tsir deploy:verify` (probe setup)                     | served          | queue-name rules, FIFO from attributes, `QueueNameExists`                                                                                                                                                    |
| SES v2 `SendEmail`                | `mail/src/transports/ses.ts` → `send`                  | written-refusal | two 501s by design — a sender read only from the raw MIME `From` header, and recipients only in the MIME headers. **We send both in the request**, so neither is reached. It does enforce verified identity. |
| SES v2 `CreateEmailIdentity`      | `tsir deploy:verify` (probe setup)                     | served          | required before a send: SES's own rule, and the emulator enforces it                                                                                                                                         |
| SNS `Publish`                     | `deploy/src/internal.ts` → `publish`                   | served          | 91 kB handler — the largest in the emulator                                                                                                                                                                  |
| SNS `ListTopics`                  | `deploy/src/internal.ts` → `resolveTopicArn`           | served          | the fallback path when no `SNS_TOPIC_ARN` is set                                                                                                                                                             |
| Lambda `Invoke`                   | `deploy/src/internal.ts` → `invoke`                    | served          | **runs the handler** in QuickJS; `Payload`, `ExecutedVersion`, `FunctionError` are the guest's own                                                                                                           |
| Lambda `CreateFunction`           | `tsir deploy:verify` (probe)                           | served          | a function must exist before `Invoke` resolves it, as on AWS                                                                                                                                                 |
| Lambda `CreateEventSourceMapping` | `tsir deploy:verify` (probe)                           | served          | a poller really reads the queue; `ReportBatchItemFailures` is read from the response                                                                                                                         |
| EventBridge `PutRule`             | `tsir deploy:verify` (probe)                           | served          | a schedule rule fires on its own clock and delivers the scheduled-event envelope                                                                                                                             |

**C1–C8 against this.** The honest ledger:

| Check                       | Moved by the emulator? | Why                                                                                                                                                                                                                                                |
| --------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C3 `DPL-013` invoke paths   | **mostly, not yet**    | API GW v2, SQS partial-batch and schedule delivery all exist. Two things stop it: our bundle has never been put through QuickJS's module set (§ 4.1), and the protocol between API Gateway v2 and a Lambda target has to be verified, not assumed. |
| C5 `DPL-016` `sam validate` | **no**                 | `sam` validates a template file. The emulator answers AWS APIs; it never reads a SAM or CloudFormation template.                                                                                                                                   |
| C4 `DPL-014` `initDuration` | **no**                 | the emulator reports no `initDuration` and runs in-process; a number from it would be a number about the host machine, not about Lambda.                                                                                                           |
| C1, C2, C7 (Cloudflare)     | no                     | different platform entirely.                                                                                                                                                                                                                       |
| C6 conformance              | **partly**             | the Bun and Lambda halves could share the emulator; the Workers half still needs `workerd`.                                                                                                                                                        |
| C8 Windows                  | no                     | a CLI question, not an AWS one.                                                                                                                                                                                                                    |

So: **C3 and C6 are the two the emulator can move, and neither is met by reading source.** C3 needs
one real invoke of one real bundle; C6 needs the same suite run against it. Everything else stays
where `07-deploy-cloud-checks.md` has it.

## 4. What the emulator cannot do, stated as limits on _us_

### 4.1 The `nodejs*` runtime is QuickJS with a curated core, and no network

From `src/state/execution/node/core_modules.rs` and `node.rs`:

- **Supplied core modules:** `path`, `util`, `events`, `buffer`, `crypto` (digest, HMAC, random
  bytes — pure computation), `fs` and `fs/promises` (an in-memory filesystem), `timers`,
  `timers/promises`, `stream`, `stream/promises`, `string_decoder`, `os`, `assert`, `url`,
  `querystring`. Both `name` and `node:name` resolve.
- **Not supplied:** `net`, `http`, `https`, `worker_threads`, `child_process`. A module the
  emulator does not supply is simply unresolvable — "nothing here pretends to be a module it is
  not".
- `process` exists with the invocation's own `environment`; there is no `Bun` global.
- The AWS SDK v3 clients are supplied for a handler that calls them, dispatched through the
  emulator's own signed request path.

For our Lambda emitter (`bun build --target=node`, ESM, `ns`-external packages) that is a
**testable claim we have not tested**: the bundle must not reach for `net`/`http` at import time.
`deploy:build` already refuses native modules (`DPL-014`), which is the same class of failure one
layer earlier. A single invoke of a single unit through the emulator would settle it; that is the
next action, not a conclusion of this review.

Serverless `QuickJS` also means **no `initDuration` and no real Node**: a bundle that passes here
is still unproven on `nodejs22.x`, which is exactly what C4 is for.

### 4.2 No IAM, no policy evaluation

The emulator's user guide says it is not for security testing, and its state does not evaluate
policies. Our template's `AWS::Serverless::Function` roles and the SQS poller's role checks
(`event_source_authorization`) therefore prove nothing about production permissions. `DPL-020`
(secret scanning) and the IAM story stay in static analysis.

### 4.3 One account, one region, no throttling

`us-east-1` by default, single account. Anything we assert about cross-region behaviour, quota
behaviour, or retry-on-throttle is out of reach. `SQS_CAPABILITIES.transactional` and the driver's
`deadLetter` behaviour are not affected; a _throttled_ platform is untestable here.

### 4.4 The conformance kit does not run against a real platform

`conformanceCases` pushes messages whose `availableAt` is the fixed virtual instant `START` (epoch
1 000 000) and reserves at `START + 5 000`. Against a real broker that is "a message due in 1970"
and a reserve "five seconds later" at the same wall-clock moment; its retry case also asserts that
`lastError` survives a failed attempt, which `ChangeMessageVisibility` cannot do. Moreover two of
the six `platform` cases need the dead-letter store that only `sql` supplies.

**Finding (kit, not platform):** the kit cannot be pointed at a live broker without reporting its
own clock assumptions as driver defects. Disposition: **accepted for now**, recorded here; the fix
is to express the kit's time as an injected clock, which touches the port and is a task of its own
(`QUEUE-…`, to be filed). No code in `@tsir/queue` changed in this pass because the probe does not
need it — it drives the four calls directly.

## 5. Why nothing here was executed

The sandbox cannot run the emulator, and that is a fact about the sandbox, not a waiver:

| Requirement                                 | This sandbox                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Linux RPM/DEB install, or a container image | non-root shell; no `docker`, no `podman`                                                               |
| Build from source (Rust, ~100 GB `target/`) | no `cargo`/`rustc`; 20 GB free                                                                         |
| Package host for either path                | `downloads.aws.com` unreachable; release binaries live on `objects.githubusercontent.com`, unreachable |
| npm/PyPI wrapper                            | none published (`aws-emulator` is not on either)                                                       |

What _is_ reachable is GitHub, so the source was read at a pinned tag and the 13 handlers the table
depends on were vendored into `src/framework/console/src/commands/fixtures/aws-emulator/` (512 kB) so the verdicts are
checked on every `bun test`, not only when someone has a checkout.

**How to run the probe elsewhere** (one `apt install`, then):

```bash
aws-emulator --telemetry off            # serves https://127.0.0.1:9297
tsir deploy:verify                        # table + cross-check + probe
TSIR_LAMBDA_ZIP=<unit>.zip tsir deploy:verify   # adds the invoke step
```

The probe exercises the `sqs` driver's own four calls (push → reserve → complete, a held lease, a
malformed body the driver must drop), the SES transport's `send` after creating the identity, and
— when given a zip — one Lambda invoke. It skips, loudly, when no emulator is running: an absent
emulator is not a repository defect.

## 6. Findings

| #   | Severity | Finding                                                                                                                                                                                                                                                                    | Disposition                                                                                         |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | high     | The first version of the selector reported every handler's first code line as `&self,`, so a working `Invoke` read as unimplemented.                                                                                                                                       | fixed — `selectorsIn` brace-matches the signature; regression test uses the real `invoke.rs`        |
| 2   | high     | The first version of the surface scan assumed `SNS<Publish>Command` naming, found no SNS or Lambda call at all, and said so confidently.                                                                                                                                   | fixed — attribution per import line, `ambiguous` fallback, three tests                              |
| 3   | medium   | The emulator's own gap list lags its code by ~3 weeks: two `lambda-invoke` issues describe behaviour fixed on 2026-11-10→12, and the message they quote no longer exists in the file they name. Reading the gap list alone would have concluded "Lambda is unimplemented". | recorded here; verdicts are derived from source and cross-checked, so a stale issue cannot flip one |
| 4   | medium   | The conformance kit cannot run against a live broker (fixed virtual clock, `lastError` assumption, `sql`-only dead letters).                                                                                                                                               | accepted for now; fix filed as injecting a clock into `conformanceCases` (§ 4.4)                    |
| 5   | low      | The emulator's `nodejs*` engine is QuickJS with no `net`/`http`/`https`; our Lambda bundle has never been put through it.                                                                                                                                                  | open — one invoke of one unit, on a machine that can run the emulator, settles it (§ 4.1)           |

## 7. Open risks

1. **A verdict is not an acceptance.** Thirteen `served` rows can look like progress on Phase 6 and
   are not: C3, C4 and C5 are exactly as open as they were. The ledger in `07-deploy-cloud-checks.md`
   is deliberately unchanged by this pass.
2. **The vendored fixture is a snapshot.** If a later release fixes what our bundle trips over, the
   fixture will not know; the cross-check is against `v1.0.341` and says so in the report.
3. **QuickJS is not Node.** Passing under it is necessary evidence and not sufficient evidence for
   the `nodejs22.x` runtime, which is what C4 measures.
4. **The probe is unexecuted.** It type-checks and its pure parts are tested; its HTTP paths have
   never been run against a live emulator. First use should be treated as a test of the probe.

## 8. Sign-off

Reviewed, not audited — the author of the code, against a tool that has never been run here. The
correct next action is not another document: it is to stand up the emulator on a machine that can,
run `tsir deploy:verify` against a built unit, and paste the transcript into
`07-deploy-cloud-checks.md` § 3 as **C3** evidence — or into § 1 as the reason C3 still cannot be
met.
