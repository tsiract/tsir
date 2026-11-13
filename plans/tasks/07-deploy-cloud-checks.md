# Tasks — Deploy: cloud verification (Phase 6)

> Acceptance criteria that **cannot be met in this repository**. They need a Cloudflare
> account, an AWS account, a Windows machine, or a wall clock. They live here so they stay visible instead of
> being quietly marked done, and so `07-deploy.md` can be honest about what is actually
> proven.

**Plan:** [`../08-deploy.md`](../modules/08-deploy.md) · **Task table:** [`07-deploy.md`](./07-deploy.md)

---

## 1. The rule

A deploy task is `[~]` in [`07-deploy.md`](./07-deploy.md) — _built and tested, acceptance
not met_ — until the corresponding line in § 3 below is filled in. The evidence line names a
commit, a date, and where the transcript or number lives. "The unit tests pass" is not
evidence that a Worker runs: the difference between a bundle and a deployment is the only
thing this file is about.

Nothing here is skipped because it is hard; it is skipped because it is **unreachable from
this sandbox**: no cloud credentials, no `wrangler` login, no AWS account, no Windows
machine, and no way to measure a cold start from a machine that is not the one being measured.

**One more tool has been considered** — the AWS Emulator (v1.0.341), which serves the AWS APIs
locally with no account. It is read in [`../reviews/2026-11-13-aws-emulator.md`](../reviews/2026-11-13-aws-emulator.md)
and summarised in this file's § 3 notes: it can move **C3** (an invoke, an SQS partial batch, a
schedule) and part of **C6**, it cannot touch **C5** (`sam` validates a template, not an API) or
**C4** (it reports no `initDuration`), and nothing else on this list changes. `make aws-emulator`
prints the per-operation table and probes a running emulator; it skips, loudly, when there is
none.

## 2. What is already proven without them

For contrast, so the gap is precise ([`07-deploy.md`](./07-deploy.md) has the details):

- `deploy:build` emits one bundle per unit per target; the Worker bundle answers
  `GET /api/users` when imported and called, the Lambda bundle answers an API Gateway v2
  event, and the Bun server boots and prints its URL.
- `deploy:validate` re-checks bytes, budgets, the secret scan and the graph against the
  emitted targets.
- `wrangler.*.toml` is generated deterministically with secrets as comments only.

What none of that shows: that Cloudflare or AWS accepts the bundle, the config, or the shape
of the events — and what it costs to start.

## 3. The checks

| #   | Task      | What it proves                                                                                                                                                             | Command                                                                                                                                                                                  | Evidence line |
| --- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| C1  | `DPL-008` | the Workers adapter survives the real `workerd` runtime: `fetch`, `queue` and `scheduled` export shapes, `waitUntil`, `retryAll`/`ackAll` semantics                        | `cd dist/cloudflare/http && wrangler dev` then `curl localhost:8787/api/users`; repeat for a `queue` and a `schedule` unit with `wrangler dev --test-scheduled` / a local queue producer | `C1:`         |
| C2  | `DPL-009` | the generated `wrangler.*.toml` is accepted, not just well-formed: bindings resolve against real Hyperdrive/KV/R2/queue resources and the Durable Object migration applies | `wrangler deploy --dry-run` per unit (no account needed for the schema check), then `wrangler deploy` on a scratch account                                                               | `C2:`         |
| C3  | `DPL-013` | the Lambda adapter survives a real invoke path: API Gateway v2 payloads, SQS partial-batch failures, EventBridge schedules                                                 | `sam local invoke` against the generated template, then a deployed invoke in a scratch account                                                                                           | `C3:`         |
| C4  | `DPL-014` | the `node`/ESM bundle really starts on the Lambda runtime: no native modules, no `bun:` builtins, import cost measured                                                     | deploy, then `REPORT` the first invocation's `initDuration`                                                                                                                              | `C4:`         |
| C5  | `DPL-016` | the generated SAM template validates and deploys, and its events point at the right handlers                                                                               | `sam validate --lint` (no account), then `sam deploy --no-execute-changeset`                                                                                                             | `C5:`         |
| C6  | `DPL-024` | the _same_ conformance assertions pass on Bun, Workers and Lambda: request-scoped state, cancellation and timeouts behave identically                                      | the shared suite, run three ways: `bun test`, `vitest-pool-workers`, `sam local invoke`                                                                                                  | `C6:`         |
| C7  | Gate P6   | `separate` **and** `single` topology each deploy a sample app and pass a smoke request                                                                                     | `make deploy-build ARGS="--topology single"` (once the emitter takes it) + `wrangler deploy` on a scratch account                                                                        | `C7:`         |
| C8  | `CLI-018` | the scaffolded `ract` runs on Windows: `package.json` script `bun ./ract` resolves, and the extensionless file runs under Bun there (Linux is verified)                    | on Windows: `bun x tsir new demo`, then `cd demo && bun run ract help` and `bun ./ract help`; both exit 0                                                                                | `C8:`         |

Fill one in like this, in the same pull request that runs it:

```
- C1: 2026-11-04, commit a1b2c3d — `wrangler dev` on dist/cloudflare/http answered
  GET /api/users 200 in 6 ms; queue unit acked a poison message and retried a
  `rate_limited` one (transcript: attached to the task, not committed)
```

## 4. Why not a nightly job here

`plans/roadmap/01-roadmap.md` lists "smoke deploy in CI (scheduled, not per-PR)" as a Gate P6 exit
criterion, and that is the right shape for these seven checks: a scheduled job with its own
credentials, reporting into a status badge, not blocking a pull request on a cloud's
availability. The repository ships no credentials, no account id and no deploy script that
would hold either — `make deploy-*` stops at artifacts on purpose (`08-deploy.md § 6`).

So the work ahead is not "write more tests": it is to stand up that scheduled job on a
machine that has an account, and paste its output into § 3.

## 5. When these move back

Delete a row from § 3 when its evidence line is filled, and flip the task in
`07-deploy.md` from `[~]` to `[x]` in the same change. When § 3 is empty, Gate P6's
"both topologies deploy a sample app" is met and Phase 6 closes.
