# 02 — Monorepo, Packages & Tooling

> Package boundaries, dependency direction, compiler configuration, and release mechanics.

---

## 1. Repository layout

Source lives under `src/`. `dist/` is **generated** and gitignored — it is the distributable
artifact, never a place to edit (ADR-0011). This mirrors the convention Symfony projects use:
your code has one home, the build output has another, and only the source is version-controlled.

```text
tsir/
├── src/                          # everything we author
│   ├── framework/                # the product: published as @tsir/*
│   │   ├── core/  container/  config/  validate/      # foundation
│   │   ├── router/  http/                             # HTTP slice
│   │   ├── database/  migrate/  seed/                 # data
│   │   ├── vault/                                     # encryption
│   │   ├── link/                                      # REST/gRPC/SOAP/WS
│   │   ├── deploy/                                    # workers + lambda
│   │   ├── auth/  policy/  cache/  queue/  events/    # capabilities
│   │   ├── schedule/  mail/  notify/  storage/  pulse/
│   │   └── console/  testing/                         # tooling
│   ├── apps/                     # consumers of the framework
│   │   ├── frontpage/            # static welcome page
│   │   │   ├── public/index.html # the deliverable
│   │   │   └── package.json
│   │   ├── docs/                 # documentation site (static, generated)
│   │   └── examples/
│   │       ├── minimal/          # core only          (Phase 1, done)
│   │       ├── saas-api/         # db + auth + policy (Phase 7)
│   │       └── edge-service/     # workers + link     (Phase 6)
│   ├── docs/                     # dependency policy, migration runbook, API snapshot, logo
│   ├── bench/                    # the benchmark baseline and the last measurement
│   ├── proto/                    # .proto sources; the generated clients are committed
│   └── tools/                    # dev runner, kill script, guards, dist builder
├── rfc/                          # public proposals: features, breaking changes, tooling
├── dist/                         # GENERATED (gitignored) — the distributable
│   ├── tsir                      # executable application CLI
│   ├── bin/tsir                  # PATH-friendly CLI
│   ├── src/                      # runnable examples and static applications
│   │   ├── examples/http/src/modules/{users,media}/
│   │   ├── examples/minimal/
│   │   ├── frontpage/            # baked static site
│   │   └── docs/                 # rendered documentation
│   ├── framework/<pkg>/          # distributable framework packages
│   ├── frontpage/                # compatibility copy of the static site
│   ├── README.md  package.json  bun.lock  LICENSE
│   └── manifest.json             # what was built, and how big it is
├── plans/                        # this directory (internal — never cited from src/)
├── status.json                   # the phase and status the README badge reports
├── tsconfig.base.json  tsconfig.json  tsconfig.dist.json
├── package.json                  # workspace root
├── bunfig.toml
├── Makefile
└── README.md
```

Rules:

- `src/apps/*` may depend on `src/framework/*`. Never the reverse.
- `src/framework/*` may depend on each other **only** along the arrows in § 3.
- `src/tools/*` are executable scripts, not published packages.
- Nothing in `dist/` is edited, imported by source, or committed. If a distributed file is wrong,
  the bug is in `src/` or in `src/tools/dist.ts`.

---

## 1.1 How `dist/` is produced

`make dist` runs `src/tools/dist.ts`, which:

1. compiles `src/framework/**` once with `tsconfig.dist.json`
   (`rewriteRelativeImportExtensions` turns `./x.ts` into `./x.js`, so the emitted ESM is
   natively resolvable);
2. flattens each package's `src/` away, so `@tsir/core` is `dist/framework/core/` and not
   `dist/framework/core/src/`;
3. rewrites each `package.json` for distribution: export map derived from the emitted files,
   `sideEffects: false`, `type: "module"`, `engines`, `publishConfig.access: "public"`, no `private`;
4. copies `LICENSE` into every package (MIT requires the notice to travel with copies) and
   generates a README from the manifest;
5. bakes the frontpage and docs, copies the maintained example applications and their modules,
   writes an executable root CLI and workspace manifest, and records `dist/manifest.json`;
6. installs the distribution workspace dependencies so `./dist/tsir --help` and the examples work
   immediately after `make dist`. The release archive omits `node_modules`; after extracting it,
   run `bun install --ignore-scripts` in the distribution. Both operations require Bun and may need
   npm registry access. `dist/` is regenerated: create application projects outside it.

The output is deliberately **not** a bundle. One file in, one file out, with `sideEffects: false`,
is what lets a consumer's bundler drop what it does not use. `make verify-dist` measures that
instead of trusting it (§ 1.2).

---

## 1.2 Evidence, not adjectives

| Check              | What it proves                                                                                   | Where                      |
| ------------------ | ------------------------------------------------------------------------------------------------ | -------------------------- |
| `make dist`        | the artifact exists, has a coherent export map, ships LICENSE + README                           | `src/tools/dist.ts`        |
| `make verify-dist` | `dist/` boots a real app with **no** workspace links or TypeScript                               | `src/tools/verify-dist.ts` |
|                    | importing one symbol does not drag in the whole package                                          | measured budget per probe  |
|                    | the same code bundles for `browser` (Workers) and `node` (Lambda) with no `bun:`/`node:` imports | `Bun.build` target probes  |
| `make deps`        | every runtime dependency is allowlisted, ESM, and declares `sideEffects`                         | `src/tools/check-deps.ts`  |

Measured today (Phase 1, `make verify-dist`):

| Probe                                         | Minified | Budget  |
| --------------------------------------------- | -------- | ------- |
| `token` only from `@tsir/container`           | 0.1 KiB  | 1.5 KiB |
| lifecycle only (`@tsir/core`, no zod)         | 13.8 KiB | 19.5    |
| Workers handler (core + config + validate)    | 99.6 KiB | 127 KiB |
| Lambda handler (core + config, `node` target) | 86.7 KiB | 107 KiB |

Zod accounts for roughly 82 KiB of the Workers/Lambda figures; the framework's own share is about
7 KiB. That split is the argument for `sideEffects: false` and per-file ESM: an application that
never imports `@tsir/config` never pays for the validator.

---

## 2. Package map

| Package           | Binary / entry                      | Phase | Purpose                                                               | Runtime-restricted                |
| ----------------- | ----------------------------------- | ----- | --------------------------------------------------------------------- | --------------------------------- |
| `@tsir/core`      | `@tsir/core`                        | 1     | Lifecycle, module system, registries, DI integration, error base      | Yes — no `node:`                  |
| `@tsir/container` | `@tsir/container`                   | 1     | DI: tokens, lifetimes, scopes, diagnostics, disposal                  | Yes                               |
| `@tsir/config`    | `@tsir/config`                      | 1     | Typed env parsing + `tsir.js` loader/presets                          | Yes                               |
| `@tsir/validate`  | `@tsir/validate`                    | 1     | Standard Schema adapter, HTTP-facing schema helpers, 422 mapping      | Yes                               |
| `@tsir/router`    | `@tsir/router`                      | 2     | Decorators, metadata registry, compile to route table                 | Yes                               |
| `@tsir/http`      | `@tsir/http`                        | 2     | Request pipeline, binders, middleware, serialization, errors, OpenAPI | Yes                               |
| `@tsir/database`  | `@tsir/database`                    | 3     | Drizzle integration, pooling, transactions, health, codecs            | No (Bun/Node drivers)             |
| `@tsir/migrate`   | `@tsir/migrate`                     | 3     | Migration orchestration over Drizzle, locking, status                 | No                                |
| `@tsir/seed`      | `@tsir/seed`                        | 3     | Deterministic seeder runner                                           | No                                |
| `@tsir/vault`     | `@tsir/vault`                       | 4     | Envelope encryption, keyring, rotation                                | Yes (WebCrypto)                   |
| `@tsir/link`      | `@tsir/link/{rest,grpc,soap,ws}`    | 5     | Service-to-service clients & servers                                  | Mixed (see `07-link.md`)          |
| `@tsir/deploy`    | `@tsir/deploy`                      | 6     | Unit graph, Workers/Lambda adapters, artifact emitters                | No                                |
| `@tsir/auth`      | `@tsir/auth/{memory,bun}`           | 7     | Sessions, bearer, API keys, password hashing                          | Yes — argon2id is the Bun adapter |
| `@tsir/policy`    | `@tsir/policy`                      | 7     | Roles, permissions, policies, guards                                  | Yes                               |
| `@tsir/cache`     | `@tsir/cache`                       | 7     | Driver-based cache                                                    | Partly                            |
| `@tsir/queue`     | `@tsir/queue`                       | 7     | Jobs, retries, DLQ, worker lifecycle                                  | Partly                            |
| `@tsir/events`    | `@tsir/events`                      | 7     | Typed dispatch, outbox                                                | Yes                               |
| `@tsir/schedule`  | `@tsir/schedule`                    | 7     | Cron tasks, distributed locks                                         | Yes                               |
| `@tsir/mail`      | `@tsir/mail/{memory,smtp}`          | 7     | Mail transports + templates                                           | Yes — one adapter                 |
| `@tsir/notify`    | `@tsir/notify/{memory,conformance}` | 7     | Multi-channel notifications over `mail`, an inbox, webhooks and SMS   | Yes — two subpaths                |
| `@tsir/storage`   | `@tsir/storage`                     | 7     | Object storage drivers (S3, R2, local)                                | Partly                            |
| `@tsir/pulse`     | `@tsir/pulse`                       | 7     | Logging, redaction, metrics, tracing, health                          | Yes                               |
| `@tsir/console`   | `bin: tsir`                         | 1     | CLI, generators, migrate/seed/deploy commands                         | No                                |
| `@tsir/testing`   | `@tsir/testing`                     | 1     | Harness, fixtures, fake clock/RNG, type tests                         | No                                |

**Merge rule.** Two packages merge when (a) neither has independent adoption value, (b) they always change together, or (c) the boundary is a single type. Candidates to watch: `migrate` + `seed` → `database/cli`; `notify` + `mail`; `pulse` + `logging`. Reviewed at each phase gate.

**Package count discipline.** Only Phase 1–4 packages are created before Gate P4. A package directory must never exist without a published entry point and at least one test.

---

## 3. Dependency graph

Arrows mean "may import". Anything not shown is forbidden and enforced by `src/tools/check-boundaries.ts` (Phase 1).

```
                      ┌──────────────┐
                      │ @tsir/config │───────┬──────┐
                      └──────┬───────┘       │      │
                             ▼               ▼      ▼
┌────────────┐        ┌────────────┐   ┌──────────┐
│ @tsir/     │───────►│  @tsir/    │──►│ @tsir/   │
│ container  │        │   core     │   │ validate │◄── zod (sole owner, ADR-0012)
└─────┬──────┘        └─────┬──────┘   └────┬─────┘
      │                     │               │
      │                     ▼               │
      │              ┌────────────┐         │
      │              │ @tsir/     │◄────────┘
      │              │  router    │
      │              └─────┬──────┘
      │                    ▼
      │              ┌────────────┐
      │              │  @tsir/http│
      │              └─────┬──────┘
      │                    │
      ▼                    ▼
┌────────────┐      ┌────────────┐        ┌────────────┐
│ @tsir/     │      │ @tsir/     │        │ @tsir/     │
│  deploy    │      │ database   │───────►│  vault     │
└────────────┘      └─────┬──────┘        └────────────┘
                          ▼
                   ┌────────────┐
                   │ migrate /  │
                   │   seed     │
                   └────────────┘
```

Hard rules (each has a boundary test):

| Rule                                                                                        | Rationale                                          |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `core` never imports an optional module                                                     | Keeps core installable alone                       |
| `router` never imports `database`                                                           | Routing must be testable without a DB              |
| `vault` never imports `http`                                                                | Encryption is usable in workers/CLI/jobs           |
| `database` → `vault` only via `codec.ts` adapter file                                       | Single, auditable integration point                |
| `auth` and `policy` never import each other                                                 | Separation of concerns; both may import `core`     |
| `console` imports only public entry points (`@tsir/database`, not `@tsir/database/src/...`) | CLI may not bypass boundaries                      |
| No app imports `@tsir/*/src/*`                                                              | Enforced by `exports` map with no wildcard subpath |
| `link` subpaths are independent: importing `/grpc` must not pull `/soap`'s XML parser       | Bundle hygiene                                     |
| Only `validate` may declare `zod`; everything else imports `z` from it                      | One validator, one version (ADR-0012)              |
| No package may import a dependency that is not on the ADR-0012 allowlist                    | Tree-shakeable, portable bundles only              |

---

## 4. TypeScript configuration

Root `tsconfig.base.json` (verbatim from the repo) enforces:

| Flag                                                            | Why                                                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `strict`                                                        | Baseline                                                                                        |
| `noUncheckedIndexedAccess`                                      | Index access returns `T \| undefined`; forces explicit handling of route params, record lookups |
| `exactOptionalPropertyTypes`                                    | Distinguishes `{ a?: T }` from `{ a: T \| undefined }` — matters for optional request fields    |
| `noImplicitOverride`, `noFallthroughCasesInSwitch`              | Inheritance hygiene                                                                             |
| `useUnknownInCatchVariables`                                    | `catch (e)` is `unknown`; forces narrowing through the error model                              |
| `verbatimModuleSyntax`                                          | `import type` discipline; keeps runtime imports honest                                          |
| `forceConsistentCasingInFileNames`                              | Cross-platform safety                                                                           |
| `moduleResolution: Bundler`, `module: ESNext`, `target: ES2023` | Bun-native, modern decorators supported                                                         |
| `isolatedModules`                                               | Per-file transpile safety (Bun transpiles per file)                                             |

Not enabled, with reasons:

- `noPropertyAccessFromIndexSignature` — noisy against Drizzle row types; revisit after Phase 3.
- `erasableSyntaxOnly` — would forbid `private` constructor parameter properties used in DI-friendly classes; **revisit** if we want `bun build --target=node` without transpilation caveats.

Package tsconfigs extend the base, set `composite: true`, `declaration: true`, and a project reference graph mirroring § 3.

---

## 5. Linting and formatting

| Concern             | Tool                                                        | Notes                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Type-aware lint     | `typescript-eslint` v8+ flat config, `projectService: true` | Rules: `no-explicit-any` (error), `no-non-null-assertion` (error in non-test), `consistent-type-imports`, `no-floating-promises`, `require-await` off, `explicit-module-boundary-types` on |
| Boundaries          | `src/tools/check-boundaries.ts`                             | Reads § 3 graph; fails on violation. Runs in `make check`.                                                                                                                                 |
| Formatting          | `prettier` (single quotes, 100 cols, trailing commas)       | No semantic formatting debates                                                                                                                                                             |
| Dead code           | `knip` (Phase 2+)                                           | Catches unused exports before they become API                                                                                                                                              |
| Package correctness | `publint` + `attw` in CI                                    | Node/Bun resolution sanity for published packages                                                                                                                                          |

`@typescript-eslint/no-restricted-imports` per package implements runtime restrictions, e.g. `@tsir/core` forbids `node:*` and `bun:*`.

---

## 6. Bun-native tooling

| Need        | Tool                                                                              | Notes                                                                          |
| ----------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Workspaces  | `bun install --frozen-lockfile`                                                   | `workspaces: ["src/framework/*", "src/apps/frontpage", "src/apps/examples/*"]` |
| Test runner | `bun test`                                                                        | JUnit XML + coverage thresholds per package                                    |
| Packaging   | `tsc -p tsconfig.dist.json` + `src/tools/dist.ts`                                 | The `dist/` tree (ADR-0011); per-file ESM, not a bundle                        |
| Bundling    | `bun build`                                                                       | Deploy emitters (Phase 6) and the `verify-dist` probes                         |
| Dev server  | `Bun.serve` in `src/tools/dev.ts`                                                 | Single port for frontpage; Phase 2 adds API proxy                              |
| SQL         | D1 binding on Workers (default); `Bun.sql` + `postgres.js` on the Postgres driver | ADR-0016 (D1 default); ADR-0009 covers the Postgres path only                  |

No task runner beyond `make` (developer entry) and `tsir` (framework operations). No `turbo`, `nx`, or `lerna`.

---

## 7. Versioning and release

- **Lockstep versions.** All `@tsir/*` packages share one version. Independent versioning complicates peer ranges with no benefit at this size.
- **Changesets** for changelog + bump decisions; `make changeset`.
- **Channels:** `canary` (every merge to `main`), `next` (weekly), `latest` (tagged).
- **Compatibility:** SemVer begins at `1.0`. Until then there is **no backward-compatibility
  promise at all**: a bad API is renamed or deleted, not aliased, and no deprecation shims are
  maintained. Changelog entries still describe the break (ADR-0012 § 4).
- **Support window:** latest minor + previous minor receive security fixes.
- **Deprecation:** starts at `1.0`. Before that, remove the thing and say so in the changelog.
- **Publish gate:** `bun test`, `make check`, bundle-size budget, and docs build must all pass on the release commit.
- **Name/trademark check** (`DOC-004` in `tasks/09-frontpage.md`) is required before the first public npm publish of `@tsir/*` and before promoting the "Tsir" name externally.

---

## 8. CI pipeline

```text
install (frozen lockfile)
  ├── typecheck        bun x tsc --noEmit -p tsconfig.json
  ├── lint             eslint . && prettier --check .
  ├── boundaries       src/tools/check-boundaries.ts
  ├── claims           src/tools/check-frontpage.ts
  ├── license          src/tools/check-license.ts
  ├── deps             src/tools/check-deps.ts        (ADR-0012 policy)
  ├── unit             bun test (per-package coverage gate)
  ├── integration      docker services: postgres; runs @tsir/database tests
  ├── dist             src/tools/dist.ts + src/tools/verify-dist.ts
  │                    (boots from dist/ only, DCE probes, Workers/Lambda budgets)
  ├── docs             src/apps/docs build + frontpage link check
  └── e2e (main only)  src/apps/examples/minimal smoke against dist/ artifacts
scheduled (nightly)
  └── deploy smoke     wrangler deploy --dry-run; lambda package + invoke in sandbox
```

### Release pipeline (`.github/workflows/release.yml`, ADR-0014)

```text
push tag v* (or manual dispatch)
  └── package      install → full gate → dist → verify-dist → release-pack
                   → sha256sum -c SHA256SUMS.txt → upload dist/release/
        ├── publish-npm   gated twice: NPM_TOKEN secret AND vars.TSIR_PUBLISH_NPM=yes
        └── release       gh release create with notes + every artifact
```

The tag must equal `package.json`'s version, or the job fails before building. Both artifacts ship
from one build: `tsir-<version>-dist.tar.gz` (the reviewable tree) and
`tarballs/tsir-<pkg>-<version>.tgz` (npm-installable). Registry publishing stays off until the
`@tsir` scope clears the name/trademark review (Q7, DOC-015); a release with it off is still a
complete GitHub Release. Locally, `make release-pack` runs the same script and verifies the
tarballs by installing and booting them in a clean project.

Failure policy: any red gate blocks merge. Nightly deploy smoke failures open an issue automatically and do not block unrelated PRs, but must be green before a release tag.

---

## 9. Failure modes

| Failure                       | Detection                                          | Behavior                                                  |
| ----------------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| Illegal cross-package import  | `check-boundaries` in CI + lint restricted imports | Build fails with the offending path and the allowed arrow |
| Package without tests         | Pre-publish check                                  | Release job fails                                         |
| Version skew between packages | Changeset validation                               | Release job fails; auto-fix script offered                |
| Bundle size regression        | Size budget in CI                                  | Fails with delta table                                    |
| Lockfile drift                | `--frozen-lockfile`                                | Install fails; instructs `bun install` locally            |

---

## 10. Security considerations

The dependency graph _is_ the supply-chain boundary, so most of this document's security is
enforced by the two gates above rather than by policy:

- **The DAG is the blast radius.** A package that may only import `container`, `core` and
  `validate` cannot reach a driver, a client, or a secret. `check-boundaries` fails the build on
  an arrow the DAG does not allow, so a compromised or careless import cannot spread quietly.
- **Dependencies are allowlisted by ADR, not by convenience** (ADR-0012). `make deps` fails on a
  new runtime dependency without an entry, and the count is published in the README badge so
  growth is visible rather than discovered in a lockfile diff.
- **Subpath scoping limits what a target carries** (ADR-0022): a REST-only Workers bundle
  contains no gRPC runtime, so it contains no `node:http2` surface either. `make verify-dist`
  proves the absence rather than assuming it.
- **Nothing in `dist/` is trusted input.** It is generated, gitignored, rebuilt from source, and
  the only supported way to produce a release artifact (ADR-0011, ADR-0014).
- **The workspace is not published as one unit.** Each package's `package.json` is rewritten at
  build time with an explicit export map and `sideEffects: false`, so a published package exposes
  exactly the entrypoints it declares.

What this section does **not** claim: none of it is an audit of a third-party dependency's own
code. The allowlist decides what is _allowed in_, and `make verify-dist` measures what is
_bundled_; reading a dependency's source is a review task, not a gate.

---

## 11. Open questions

See [`00-foundation.md § 6`](../roadmap/00-foundation.md#6-open-questions) (Q1, Q6, Q7). Additions:

| #   | Question                                                                                      | Blocks                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q8  | Do `migrate`/`seed` remain separate packages after Gate P3, or fold into `@tsir/database`?    | Phase 3 review                                                                                                                                                                                                                                                             |
| Q9  | Do we ship `.d.ts` map declarations for `bun build` consumers, or require `tsc -b` for types? | **Answered in Phase 1** — declarations + declaration maps ship in `dist/` (`make dist`).                                                                                                                                                                                   |
| Q34 | Publish straight from `dist/` (`publishConfig.directory`), or emit a release tarball script?  | **Decided** — both. `make release-pack` emits per-package tarballs _and_ a `dist/` tree archive; GitHub Actions (`.github/workflows/release.yml`) attaches both to a `v*` tag release. Registry publishing double-gated on `NPM_TOKEN` + `TSIR_PUBLISH_NPM`. See ADR-0014. |

---

## 12. Task index

[`tasks/01-foundation.md`](../tasks/01-foundation.md) — `FND-001` … `FND-031`.
