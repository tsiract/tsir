# ADR-0011 — Source under `src/`, distributable tree in `dist/`

- **Status:** Accepted
- **Date:** 2026-10-27
- **Affects:** every path in the repository, `make dist`, CI, publishing
- **Supersedes:** the `apps/` + `packages/` + `tools/` top-level layout in `02-monorepo.md` § 1

---

## Context

The first layout put three concerns side by side at the repository root:

```text
apps/       consumers (frontpage, examples)
packages/   the framework, published as @tsir/*
tools/      repo scripts
```

It works, but it has two problems for a framework that ships to Cloudflare Workers and AWS Lambda:

1. **"What do I author?" is not obvious.** Nine of the eleven top-level directories are neither
   the product nor its documentation. A newcomer has to learn a convention, not read a structure.
2. **There was no artifact.** Nothing in the repository was the thing a consumer installs. The
   published shape existed only as a proposal in a markdown table, so "does this tree-shake on
   Workers?" could not be answered or regressed against.

The reference point the maintainer named is Symfony: application code has one home, generated
output has another, and only the first is version-controlled.

## Decision

**All authored code lives under `src/`. Everything in `dist/` is generated and gitignored.**

```text
src/framework/   the product (@tsir/*) — what gets published
src/apps/    runnable example apps
src/apps/frontpage/   the marketing site
src/tools/       repo scripts: dev server, guards, dist builder
dist/            generated: root tsir CLI, apps/ (runable examples including modules),
                 static sites, framework package trees, and manifest.json
```

Details that make this work rather than merely look tidy:

| Decision                                                    | Reason                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tsconfig.dist.json` with `rewriteRelativeImportExtensions` | Source imports `./x.ts` (required by `allowImportingTsExtensions`, which keeps `tsc --noEmit` honest). The build rewrites those to `./x.js`, so emitted ESM is natively resolvable by Node, Bun and bundlers.            |
| Per-file ESM, **not** a bundle                              | A consumer's bundler can only drop code it can see. One file in / one file out, plus `sideEffects: false`, is what makes `import { token }` cost 0.1 KiB instead of 14 KiB. Measured, not asserted (`make verify-dist`). |
| Package `src/` flattened on emit                            | The repository keeps each package's own `src/` (`src/framework/core/src/…`); the distribution does not (`dist/framework/core/…`). Directory shape is a repository concern, not a consumer concern.                       |
| `LICENSE` + generated `README.md` per package               | MIT requires the notice to travel with every copy. Generating the README from the manifest means it cannot drift from the export map.                                                                                    |
| `dist/manifest.json`                                        | Records what was built and how large it is, so a size regression is visible in review.                                                                                                                                   |

The current distribution also contains a runnable root CLI and the maintained applications under
`apps/` (so that `tsir make:*`, which writes module files, reads the same layout a consumer
does); application modules live directly inside their respective app roots. `make dist` installs
the local workspace dependencies, while release archives omit `node_modules` and need
`bun install` after extraction. The whole directory is rebuilt, not an editable home for a user
project.

## Consequences

**Positive**

- One rule replaces three: authored code is in `src/`, generated code is in `dist/`.
- The distributable is verified, not imagined: `make verify-dist` copies `dist/` into a sandbox
  with no workspace links and boots an application from it.
- Size and portability budgets are attached to a real artifact, so a dependency that breaks
  Workers support fails CI instead of failing in production.
- Publishing becomes mechanical: every `dist/framework/<pkg>/package.json` already carries the
  export map, `engines`, `sideEffects: false` and `publishConfig`.

**Negative / costs**

- Two path conventions to remember: relative to the repository (`src/framework/core`) and
  relative to a consumer (`@tsir/core`). Tools that walk the tree must know `src/framework` is
  the package root — `check-boundaries`, `check-license` and `dist` each encode it once.
- `dist/` must be rebuilt after every source change; a stale `dist/` is a trap. Every consumer of
  it (`verify-dist`, CI, the frontpage build) depends on `make dist`, so the trap is at least
  self-closing.
- Declaration maps point into `src/`; without `inlineSources` a consumer would see a path that
  does not exist in the published package. Sources are inlined for that reason.

## Alternatives rejected

- **Keep `apps/` + `packages/` and add a build step.** Rejected: the layout question the
  maintainer raised (`src/`, like Symfony) is about where authored code lives; a build step does
  not answer it.
- **Bundle each package with `Bun.build` into a single file.** Rejected: it destroys tree
  shaking, which is a stated requirement. A bundled `@tsir/core` would make every import pay for
  every module.
- **Publish straight from `src/`.** Rejected: it would ship tests, type tests and `.ts` files, and
  would make `dist/`-only guarantees (no test code, LICENSE present, export map complete)
  unverifiable.
- **Commit `dist/`.** Rejected: generated artifacts in version control create merge conflicts and
  drift. Reproducibility comes from `make dist`, which is deterministic apart from source maps.
