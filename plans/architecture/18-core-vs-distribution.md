# Core development vs. developer distribution

_Status: audit complete; every violation closed or narrowed to the registry question (Q72/Q73). This document is the boundary
contract between the two environments. It is the source of truth for what belongs
where, and it is written before the code so the code can be checked against it._

## 1. The two environments

|                 | Core engineering workspace | Distribution                                |
| --------------- | -------------------------- | ------------------------------------------- |
| Path            | the repository root        | `dist/` (generated, gitignored)             |
| Who             | Tsir maintainers           | developers building applications            |
| Source of truth | `src/framework/*/src`      | `dist/framework/*` (emitted from the above) |
| Commands        | `make …`                   | `./dist/tsir …`                             |
| Tests           | the framework's own suite  | `verify-dist` + the archive journey         |

The repository **is the framework**. It is not an application, and the root
`Makefile` must not contain an application workflow. `dist/` is the only product
surface.

## 2. Inventory

### A. Core engineering — stays in the repository, driven by `make`

| Tool                                                  | Where                                    | Notes                                                                                                      |
| ----------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `make help dev kill doctor`                           | `src/tools/dev.ts`, `kill-dev.sh`        | core development environment (docs site + admin app)                                                       |
| `make test`, `make coverage`                          | `bun test`, `src/tools/coverage-gate.ts` | tests the **source** packages                                                                              |
| `make typecheck lint format-check`                    | `tsc`, `src/tools/lint.ts`               | whole workspace, including tools                                                                           |
| `make boundaries modules plan-refs plans make-check`  | `src/tools/check-*.ts`                   | repository-only invariants                                                                                 |
| `make error-codes links surface version license deps` | `src/tools/*`                            | publishable-metadata invariants                                                                            |
| `make frontpage docs-site docs-packages readme`       | `src/tools/*`, `src/apps/frontpage`      | the marketing site and generated docs                                                                      |
| `make crypto coercion flakes`                         | `src/tools/*`                            | security/quality scans                                                                                     |
| `make bench new-package changeset`                    | `src/tools/*`                            | maintainer tooling                                                                                         |
| `make proto proto-check`                              | `buf` over `proto/`                      | **framework-internal**: the contract `@tsir/link/grpc` is developed against; it is not application codegen |
| `make test-integration`                               | `src/tools/test-integration.ts`          | database-backed framework tests                                                                            |

### B. Distribution engineering — assembles the product

| Tool                | Where                              | Notes                                                          |
| ------------------- | ---------------------------------- | -------------------------------------------------------------- |
| `make dist`         | `src/tools/dist.ts`                | emits `dist/framework/*`, templates, docs, launcher            |
| `make verify-dist`  | `src/tools/verify-dist.ts`         | boots and tree-shakes the emitted packages                     |
| `make release-pack` | `src/tools/release-pack.ts`        | tarballs + archive + independent journey                       |
| `make dist-check`   | `src/tools/check-dist.ts`          | asserts the boundary: no internal-only assets, no leaked paths |
| `tsir new`          | `console/src/commands/generate.ts` | the scaffold a developer starts from                           |

### C. Application developer experience — lives **only** in the distribution

| Command                                                                          | Implementation                    | Status  |
| -------------------------------------------------------------------------------- | --------------------------------- | ------- |
| `new`, `dev`, `build`, `start`, `test`, `doctor`                                 | console commands                  | present |
| `make:*` (16 generators)                                                         | `console/src/commands/make-*.ts`  | present |
| `migrate`, `migrate:status`, `migrate:rollback`, `migrate:verify`                | `console/src/commands/db.ts`      | present |
| `db:seed`                                                                        | console                           | present |
| `openapi:generate`                                                               | `console/src/commands/openapi.ts` | present |
| `route:list`, `route:compile`                                                    | console                           | present |
| `deploy:*` (5)                                                                   | console                           | present |
| `queue:*`, `schedule:*`, `cache:*`, `mail:*`, `notify:*`, `vault:*`, `storage:*` | console                           | present |

## 3. Violations found, and what closed them

The audit found seven violations. They are kept here with their disposition, because a contract
section with no history reads as a contract nobody ever had to enforce.

| #   | Violation                                                                            | Disposition                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The root `Makefile` carried an application workflow (`start`, `migrate`, `seed`, …). | **Closed.** Those targets are gone; the verbs live behind `dist/tsir`. `make make-check` (`DXS-015`) fails if one reappears or if a document tells the reader to run it.                                                                           |
| 2   | Application codegen was a core gate, driven by an `APP=` variable.                   | **Closed.** `make codegen-check` is still a gate, but only over the sample application the framework is validated against, and its targets are named `app-*` so they cannot be mistaken for a workflow.                                            |
| 3   | `make build` was an alias of `make dist`.                                            | **Closed.** `make build` compiles the framework packages into `.build/`; `make dist` is the only product-producing target.                                                                                                                         |
| 4   | `tsir new` recorded an absolute `workspaces` path into whichever `dist/` existed.    | **Closed.** The scaffold emits a relative `link:` plus version-shaped `overrides`, so a moved checkout still resolves and every `@tsir/*` reference lands on one directory.                                                                        |
| 5   | The distribution was usable only as a Bun workspace beside `node_modules`.           | **Partly open (registry).** A standalone `bun install` of a generated app works through the relative `link:` overrides; installing from `@tsir/*` version ranges still needs the packages on a registry. That is Q72/Q73, not a Makefile question. |
| 6   | The generated application did not typecheck.                                         | **Closed.** The tsconfig carries the `types`/`lib` a Bun application needs, and four journey runs typecheck a fresh scaffold as it is emitted.                                                                                                     |
| 7   | `proto/` generation was reachable only through a tool that skipped in CI.            | **Closed by design.** `proto` is correctly framework-internal; `make proto-check` fails when the committed contracts drift and skips with a note when `buf` is absent. There is no `proto:generate` for applications.                              |

## 4. The contract

**Core (`make`)**

- Only category A and B targets. No `APP=`, no application verbs.
- `make check` validates the framework source, never an application build.
- `make dist` is the only product-producing target.

**Distribution (`dist/`)**

- `dist/tsir` is the developer executable; every category C command lives behind it.
- `dist/framework/<pkg>` is the package surface; `dist/templates`, `dist/docs`
  are developer assets.
- No `src/tools`, no internal tests, no CI config, no `plans/`.

**Generated application (`apps/<name>/`)**

- Created by `./tsir new <name>` inside a consumer directory; always
  `apps/<name>/`, never `app/`, never inside `dist/`.
- Declares `@tsir/*` dependencies that resolve from the distribution through
  **relative** `link:` overrides, so it survives the distribution being moved,
  does not depend on the repository, and resolves every `@tsir/*` reference to
  one directory. `file:` is wrong here even though it installs: bun copies a
  `file:` dependency once per dependent, and the framework keeps process-local
  registries (routes, controllers, container) that stop agreeing when there are
  several copies of a package.
- Typechecks and boots as generated (no manual fixups).

## 5. Failure modes

| Failure                                                        | Why it happens                                        | The guard                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| The Makefile grows an application verb again                   | it is the shortest path to "just run it here"         | `make make-check` (it reads the docs too) + `check-dist`; category C lives behind `dist/tsir` only     |
| The distribution ships a copy of the monorepo                  | assembling with a recursive copy is two lines shorter | `make dist-check` rejects tooling, tests, plans and CI config by path segment                          |
| An application resolves the framework through an absolute path | the scaffold records where `dist/` happened to be     | `check-dist` rejects an absolute path in a distributed manifest; the scaffold emits a relative `link:` |
| Two copies of `@tsir/router` in one process                    | `file:` overrides copy per dependent                  | `link:` + `overrides`; `verify-dist` boots the tree that was emitted                                   |
| `dist/` silently goes stale                                    | nothing rebuilds it                                   | rebuild with `make dist-build` before running anything out of it                                       |
| A developer command imports an internal module                 | the framework source is right there                   | `make boundaries` declares the edge; `check-dist` keeps `src/tools` out of the product                 |

## 6. Security considerations

The boundary is not an authorisation mechanism. It is a **supply-surface** rule: everything in
`dist/` is code a developer will run and may deploy, so anything that reaches it has to be
something we are prepared to support in public.

- **No secrets, no fixtures, no test data.** The engineering workspace's fixtures and `.env`
  examples that carry placeholder credentials must not travel; `check-dist` rejects the paths.
- **No absolute paths.** An absolute path in a manifest names the build machine, which leaks the
  builder's filesystem layout into a shipped artefact and breaks reproducibility.
- **The product ships the public surface only.** Internal engineering modules (`src/tools`) never
  reach `dist/`, so a distribution cannot be used to reach repository internals.
- **A compiled binary is a layout too.** `bun build --compile` has no `package.json` and no `stubs/`
  directory: `import.meta.dir` points into the bundled filesystem. Anything the CLI reads at run time
  must either be inlined at build time (`stubs/*.slug.txt`, `TSIR_BUILT_VERSION`) or be declared
  external and shipped beside the binary (OpenTUI's per-platform library). The `files` list in the
  emitted manifest has to carry the inlined assets, which is how `release-pack` caught a packed
  console that could not import its own templates.
- **Nothing here replaces review.** `check-dist` proves the shape of the tree; it cannot prove a
  command is safe to expose. That is the same rule as ADR-0031's "one implementation, two
  entrypoints".

## 7. Open questions

| #   | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Decides                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Q71 | Does `dist/` ship one launcher per platform (`bun build --compile`) or the `bun`-driven launcher only? **Partly answered**: a compiled binary works — `tsir new` scaffolds, `dist/` relocated to /tmp scaffolds + installs + typechecks, `/api/welcome` answers — once two things are fixed (templates as text imports, version via `--define`). What remains is OpenTUI's native library, which must be external (`--external` per platform package) and so is still a file beside the binary, and the darwin/win32 builds, unexercised here. | Publishability of `dist/tsir`            |
| Q72 | When the packages reach a registry, do the `overrides` blocks in generated applications disappear in one change, or stay as an escape hatch for a fork?                                                                                                                                                                                                                                                                                                                                                                                        | The scaffold's dependency contract       |
| Q73 | Does the distribution need a lockfile of its own, or is a resolved install the developer's responsibility?                                                                                                                                                                                                                                                                                                                                                                                                                                     | Reproducibility of a distributed install |

## 8. Task index

The work is tracked in [`../tasks/08-dx.md`](../tasks/08-dx.md) (`DXS-*`, `CLI-*`) and, for the
TUI half, [ADR-0031](../decisions/0031-terminal-ui.md) with `make tui-check` as its gate. Nothing
in this document has its own ledger: it is the contract those tasks are checked against.
