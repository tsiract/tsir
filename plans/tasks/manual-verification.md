# Manual verification: what needs your accounts or machines

_Last updated 2026-10-30. Everything else in the task ledgers is either done or evidenced by a test in this repository. These items cannot be run from this sandbox: they need a Cloudflare or AWS account, a Windows machine, or a decision that belongs to the maintainer._

The checks are defined in [`07-deploy-cloud-checks.md`](./07-deploy-cloud-checks.md). This file is the handoff list. When you finish an item, paste its evidence line into that file, then flip the matching row in its ledger.

## 1. Cloud checks (Gate P6, Phase 6)

Run these in a scratch Cloudflare account and a scratch AWS account. Run them in the same pull request that changes the adapter. Do not run them with production credentials.

| #   | Task      | Command                                                                                                                                                    | Evidence line |
| --- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| C1  | `DPL-008` | `cd dist/cloudflare/http && wrangler dev`, then `curl localhost:8787/api/users`. Repeat for a queue and a schedule unit (`wrangler dev --test-scheduled`). | `C1:`         |
| C2  | `DPL-009` | `wrangler deploy --dry-run` for each unit, then `wrangler deploy` on a scratch account.                                                                    | `C2:`         |
| C3  | `DPL-013` | `sam local invoke` against the generated template, then a deployed invoke in a scratch account.                                                            | `C3:`         |
| C4  | `DPL-014` | Deploy the Lambda bundle and record the first invocation's `initDuration`.                                                                                 | `C4:`         |
| C5  | `DPL-016` | `sam validate --lint`, then `sam deploy --no-execute-changeset`.                                                                                           | `C5:`         |
| C6  | `DPL-024` | Run the shared conformance suite three ways: `bun test`, `vitest-pool-workers`, `sam local invoke`.                                                        | `C6:`         |
| C7  | Gate P6   | `make deploy-build ARGS="--topology single"`, then `wrangler deploy` for `separate` and `single`, each with a smoke request.                               | `C7:`         |

Gate P6's "both topologies deploy a sample app" stays open until C7 is evidenced.

## 2. Windows verification (CLI-018, C8)

On a Windows machine with Bun installed:

```
bun x tsir new demo
cd demo
bun run ract help
bun ./ract help
```

Both commands must exit 0. Record the result as `C8:` in `07-deploy-cloud-checks.md`, then change CLI-018 from `[~]` to `[x]` in `08-dx.md`. Linux is already verified, so only this run remains.

## 3. Decisions for the maintainer

- **Security contact.** `CONTRIBUTING.md` lists `hello@daisoncarino.com`, and `SECURITY.md` lists `security@tsir.dev`. The two disagree. `SECURITY.md` is not to be edited without asking, so this needs your decision.
- **npm publishing.** Blocked on the naming review (Q7, DOC-015, ADR-0014). Until that is decided, distribution uses `dist/framework/<pkg>` through `file:` overrides.
- **Brute-force protection** in `@tsir/auth` (CAP-P7 F3). The primitive exists, but the policy is an application decision. Gate P7 is closed without it.
- **AWS decorator routing** (DPL-025 to DPL-031). Planned in the ledger and deliberately not implemented. Start it when you ask.

## 4. Outside reviews

- **External security review** (Gate P8, criterion 2). Needs an outside reviewer. The findings should be triaged into `SECURITY.md` and the disclosure policy.
- **Package security notes.** The unit tests cover most of the claims in the package pages. The one still partly evidenced is mail: provider keys are read from the environment and refused at boot when unset, but no test proves they never appear in a rendered message. Seed "use fake data" is advice, not a checked property.

## 5. Environment notes

- `make check` passes with exit 0 on the last run. `buf` 1.47.2 was installed in this session, and `make proto-check` passes with it. CI should keep installing `buf` so the check runs there too.
- Full-repo `eslint .` does not fit in 2 GB of memory. Use `make lint`, which runs one ESLint process per framework package, plus one each for `src/tools` and `src/apps`.
