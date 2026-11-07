# Tasks — Foundation (Phase 0 / 1)

> Repository, tooling, CI, developer workflow. These unblock everything else.

**Plan:** [`../02-monorepo.md`](../architecture/02-monorepo.md), [`../11-dx.md`](../operations/11-dx.md)

---

## Foundation

| ID        | Title                                                                           | Status | Depends          | Acceptance criteria (summary)                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------- | ------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FND-001` | Root workspace `package.json` + `bunfig.toml`                                   | ✅     | —                | `bun install` resolves; workspaces include `src/framework/*`, `src/apps/frontpage`, `src/apps/*` (ADR-0011)                                                                                                                                                    |
| `FND-002` | `tsconfig.base.json` with all required strict flags                             | ✅     | —                | Flags match `02-monorepo.md § 4`; `tsc --showConfig` confirms                                                                                                                                                                                                  |
| `FND-003` | `.gitignore`, `.editorconfig`, license, `README.md`                             | ✅     | —                | No tracked build output; README links `plans/`; MIT in `LICENSE` + all manifests (`make license`)                                                                                                                                                              |
| `FND-004` | Root `Makefile` (`help`, `install`, `dev`, `kill`, `check`, `test`, …)          | ✅     | FND-001          | `make help` lists targets; `make dev` starts; `make kill` stops; verified                                                                                                                                                                                      |
| `FND-005` | Dev server `src/tools/dev.ts` (static, token injection, graceful shutdown)      | ✅     | FND-001          | Serves frontpage; tokens resolved; Ctrl-C drains and frees port                                                                                                                                                                                                |
| `FND-006` | `src/tools/kill-dev.sh` — record-based, never indiscriminate                    | ✅     | FND-005          | Kills only recorded PIDs; verifies ports; leaves unknown owners alone. `make kill` adds a host-wide sweep (`src/tools/kill-ports.ts`) that protects container runtimes, system ports and data services — see `DXS-014` and `plans/operations/11-dx.md § 1.1.1` |
| `FND-007` | ESLint flat config, type-aware                                                  | ✅     | FND-002          | `bun x eslint .` passes on current tree; rules from `02-monorepo.md § 5`                                                                                                                                                                                       |
| `FND-008` | Prettier config + `make format`                                                 | ✅     | FND-007          | `prettier --check .` clean                                                                                                                                                                                                                                     |
| `FND-009` | `src/tools/check-boundaries.ts` enforcing the dependency DAG                    | ✅     | FND-002          | Violating import fails with the allowed-arrow message                                                                                                                                                                                                          |
| `FND-010` | GitHub Actions: install, typecheck, lint, boundaries, test                      | ✅     | FND-007, FND-009 | Red on any failure; `CI=1` frozen lockfile                                                                                                                                                                                                                     |
| `FND-011` | Changesets + release workflow                                                   | `[x]`  | FND-010          | `make changeset` works; lockstep version bump                                                                                                                                                                                                                  |
| `FND-012` | CI: Postgres service container job                                              | `[x]`  | FND-010          | Job runs `make test-integration`                                                                                                                                                                                                                               |
| `FND-013` | `src/tools/dist.ts` — distributable tree + frontpage bake (ADR-0011)            | ✅     | FND-005          | `make dist` produces `dist/` with export maps + LICENSE; gitignored                                                                                                                                                                                            |
| `FND-025` | `src/tools/verify-dist.ts` — boots `dist/`, DCE + Workers/Lambda budgets        | ✅     | FND-013          | `make verify-dist` fails on a payload regression or a `node:` leak                                                                                                                                                                                             |
| `FND-026` | `src/tools/check-deps.ts` — dependency policy (ADR-0012)                        | ✅     | FND-007          | Unallowlisted / CJS-only / undeclared-`sideEffects` dependency fails CI                                                                                                                                                                                        |
| `FND-027` | Restructure: authored code under `src/` (ADR-0011)                              | ✅     | —                | No `apps/`, `src/framework/`, `src/tools/` at the root; `make check` green                                                                                                                                                                                     |
| `FND-028` | `@tsir/validate` is the sole owner of `zod` (ADR-0012)                          | ✅     | FND-026          | One manifest names `zod`; everything else imports `z` from `@tsir/validate`                                                                                                                                                                                    |
| `FND-029` | `@tsir/validate/mini` entry; `@tsir/config` on `zod/mini` (ADR-0013)            | ✅     | FND-028          | `./mini` export resolves; config-only bundle ≤ 28,000 B; 5 default/validator tests                                                                                                                                                                             |
| `FND-030` | `src/tools/release-pack.ts` — tarballs + `dist/` archive + checksums (ADR-0014) | ✅     | FND-025          | `make release-pack` installs all tarballs in a clean project and boots an app from them                                                                                                                                                                        |
| `FND-031` | `.github/workflows/release.yml` — tag-triggered build → verify → pack → release | ✅     | FND-030          | Pushing `v*` publishes a GitHub Release with both artifacts; npm publish gated twice                                                                                                                                                                           |
| `FND-014` | Renovate/Dependabot with grouping + security labels                             | `[x]`  | FND-010          | PRs grouped by package family                                                                                                                                                                                                                                  |
| `FND-015` | Commitlint + PR template (task id, plan diff, security notes)                   | `[x]`  | FND-010          | Non-conforming commit rejected locally via hook                                                                                                                                                                                                                |
| `FND-016` | Min Bun/Node version enforcement (`engines`, boot check)                        | `[x]`  | FND-001          | Old runtime fails with a clear message                                                                                                                                                                                                                         |
| `FND-017` | `SEC`-reviewed dependency budget file (`src/docs/dependencies.md`)              | `[x]`  | FND-007          | Every runtime dep listed with ADR link                                                                                                                                                                                                                         |
| `FND-018` | Repo-level `docs/` hygiene check (links resolve)                                | `[x]`  | FND-013          | Broken plan links fail CI                                                                                                                                                                                                                                      |
| `FND-019` | `src/bench/` harness with committed baselines                                   | `[x]`  | FND-010          | `make bench` writes comparable JSON                                                                                                                                                                                                                            |
| `FND-020` | Package scaffolding script (`src/tools/new-package.ts`)                         | `[x]`  | FND-009          | Generates package.json, tsconfig, src, test, docs stub                                                                                                                                                                                                         |
| `FND-021` | Release provenance (`bun publish --provenance`)                                 | `[x]`  | FND-011          | Published tarball attestation verified                                                                                                                                                                                                                         |
| `FND-022` | Issue templates (bug, feature, security-report redirect)                        | `[x]`  | —                | Security template redirects to `SECURITY.md`                                                                                                                                                                                                                   |
| `FND-023` | Repo CODEOWNERS with security-critical paths                                    | `[x]`  | —                | `src/framework/vault`, `auth`, `policy` require 2 reviewers                                                                                                                                                                                                    |
| `FND-024` | Docs-in-PR check (public API diff requires docs diff)                           | `[x]`  | FND-018          | PR fails when `export` changes without docs                                                                                                                                                                                                                    |

---

## Developer workflow (Phase 0 portion)

| ID        | Title                                         | Status | Acceptance criteria                                 |
| --------- | --------------------------------------------- | ------ | --------------------------------------------------- |
| `DXS-001` | `make dev` runs cleanup then serves           | ✅     | Observed twice consecutively without manual cleanup |
| `DXS-002` | `make kill` idempotent, safe                  | ✅     | Running with nothing started exits 0 with a message |
| `DXS-003` | Port guard for unknown owners                 | ✅     | Occupied port by foreign process → refuse + explain |
| `DXS-004` | `make check` composite target                 | `[x]`  | Runs typecheck, lint, boundaries, format check      |
| `DXS-005` | Frontpage token injection                     | ✅     | Env/version/runtime shown live                      |
| `DXS-006` | Graceful shutdown drain                       | ✅     | In-flight request completes on SIGTERM              |
| `DXS-007` | `.tsir/dev.json` runtime record schema + docs | `[x]`  | Documented and versioned                            |
| `DXS-008` | `make doctor` → forwards to `tsir doctor`     | `[x]`  | Same output as CLI                                  |

---

## Acceptance criteria (gate-critical)

### `FND-004` / `FND-005` / `FND-006` — the dev workflow

> Not re-run end to end in the current environment; these are manual checks
> against a live port. The code paths they exercise are unchanged since the
> Phase 0 verification recorded in `plans/operations/11-dx.md`.

- [ ] `make dev` from a clean checkout serves `http://localhost:3000` within 1 s. _(needs a live port; not re-run this pass)_
- [ ] `make dev` run twice in a row works: the second call stops the first process first.
- [ ] `make kill` removes the record file only after all PIDs are confirmed stopped.
- [ ] Ctrl-C in `make dev` exits 0 and leaves the port free (`lsof -i :3000` empty).
- [ ] A foreign process on the port is reported and **not** terminated.
- [ ] PID reuse: the record stores process start time; a mismatch means "do not touch".

### `FND-009` — boundaries

- [x] `import { x } from '@tsir/database'` inside `src/framework/router` fails CI — `checkSpecifier` test names both ends and the allowed set:
      `✗ boundary violation: router → database (allowed: core, config, container, validate)`.
- [x] `import '@tsir/core/src/container'` fails (no deep imports; test covers `src` and `dist`).

### `FND-010` — CI

- [ ] A PR with a type error fails in < 3 min with the `tsc` output.
- [x] Coverage thresholds per `../12-testing.md § 7` enforced — `make coverage`, 6 packages, in CI.
