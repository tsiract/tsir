# ADR-0014 — Every release ships the `dist/` tree _and_ per-package tarballs

- **Status:** Accepted
- **Date:** 2026-10-27
- **Affects:** `src/tools/release-pack.ts`, `src/tools/dist.ts`, `Makefile`, `.github/workflows/release.yml`
- **Related:** ADR-0011 (`src/` → `dist/`), ADR-0012 (dependency policy), Q34

---

## Context

There are two audiences for a Tsir release, and they want opposite things.

**An application developer** wants `bun add @tsir/core @tsir/container`. That means a tarball per
package, with a `package.json` whose `exports` map is correct, whose `dependencies` resolve, and
whose files are exactly the compiled `.js`, `.d.ts`, source maps, `LICENSE`, and `README.md`.
Nothing else — a tarball that ships `.test.ts` files is a tarball that ships a second, untested
copy of the project.

**Someone evaluating the project** — a reviewer, a security audit, a "what am I actually
installing" question — wants the whole generated tree at once, so they can read the emitted output
without running the build. This is the "`dist/` in code" property from ADR-0011: the compiled
artifact is a reviewable object, not an incidental side effect of `npm publish`.

Publishing only one of these forces the other audience to run the toolchain. Publishing both by
hand guarantees they drift.

## Decision

**1. `bun src/tools/release-pack.ts` (a.k.a. `make release-pack`) emits both, from one build.**

```
dist/release/
  tarballs/tsir-<pkg>-<version>.tgz     one per package (npm-installable)
  tsir-<version>-dist.tar.gz            the whole dist/ tree
  SHA256SUMS.txt                        paths relative to dist/release/
  release-manifest.json                 versions, bytes, sha256
  LICENSE
```

**2. Distributed manifests carry concrete versions, never `workspace:*`.**

Inside the repository, `"@tsir/container": "workspace:*"` is correct — it means "the sibling, at
whatever version it is". Outside it, the protocol is meaningless: `npm pack` refuses to pack such
a manifest, and an installed tarball would carry an unresolvable dependency. `src/tools/dist.ts`
therefore rewrites workspace ranges to concrete versions at build time:

| source        | emitted      |
| ------------- | ------------ |
| `workspace:*` | `<version>`  |
| `workspace:^` | `^<version>` |
| `workspace:~` | `~<version>` |

This is only sound because versioning is lockstep (plans/architecture/02-monorepo.md § 7) — every `@tsir/*`
package carries the same version, so "whatever the sibling is" and "the root version" are the same
number by construction. The moment packages version independently, this rewrite becomes wrong and
must be replaced with a per-package lookup.

**3. The pack step verifies itself before it reports success.**

A tarball that installs is not the same as a tarball that works. `release-pack.ts` unpacks the
real artifacts into a clean throwaway project and:

- installs every tarball through `dependencies` **and** `overrides`, pinned to `file:` paths —
  because transitive `@tsir/*` deps point at a registry that has nothing in it yet. Without the
  override, Bun correctly 404s on `@tsir/container`.
- adds `zod` from the registry, since it is a real transitive dependency.
- boots an app against the installed packages and waits for `ready` → `stopped`.
- rejects any tarball containing a `.ts` file that is not a `.d.ts`, a `.test.*`, a `.spec.*`, or
  a `type-tests/` path. `.d.ts` is a feature of the distribution; a bare `.ts` is a source leak.

`--skip-verify` exists for the inner loop; the release workflow never uses it.

**4. GitHub Actions owns the release, and registry publishing is double-gated.**

`.github/workflows/release.yml` triggers on a `v*` tag (or manual dispatch):

```
package   → install · full gate · dist · verify-dist · release-pack · sha256sum -c · upload
publish-npm → (gated) npm publish each dist/framework/* with --provenance
release   → download artifacts · gh release create with notes + all assets
```

`publish-npm` requires **both** a `NPM_TOKEN` secret and the repository variable
`TSIR_PUBLISH_NPM=yes`. Until the `@tsir` scope clears the name/trademark review (Q7 / DOC-015),
the default is a GitHub Release with artifacts and checksums and no registry mutation. The
release job tolerates a skipped `publish-npm` (`always() && … || skipped`) so the GitHub Release
is never blocked by a deliberately-disabled publish step.

The workflow also fails fast if the pushed tag does not match `package.json`'s version — a
released artifact whose version disagrees with its tag is worse than a failed build.

## Consequences

- `SHA256SUMS.txt` records paths relative to `dist/release/`, so `cd dist/release && sha256sum -c
SHA256SUMS.txt` verifies the whole set. The workflow runs exactly that command.
- Two artifacts double the upload, ~180 KiB total. Irrelevant.
- `dist.ts` now performs a manifest rewrite that only holds while versioning is lockstep. This is
  recorded in the table above and in the tool's doc comment, so it is a known cliff rather than a
  silent assumption.
- The release is only as trustworthy as the gate that precedes it, which is why `release-pack`
  depends on `verify-dist` in the `Makefile` and the workflow re-runs the full `check` suite.
- Nobody has to remember the pack command: `make release-pack` is the whole interface locally, and
  a tag is the whole interface in CI.

## Alternatives rejected

- **Publish only tarballs.** Rejected: it removes the reviewable-artifact property that ADR-0011
  was built around, and answers "what does the output actually look like" with "run the build".
- **Publish only the `dist/` tree.** Rejected: it is not installable, so the primary audience has
  to vendor a tarball and write its own export plumbing.
- **Keep `workspace:*` in published manifests.** Not an option: `npm pack` refuses, and the
  resulting install is unresolvable.
- **`npm publish` from the repository with `publishConfig.directory`.** Rejected for now: it
  ties the release shape to a single registry tool, does not produce the `dist/` archive at all,
  and makes local verification of the artifact impossible without publishing.
- **Trust that `npm pack` only includes `files:`.** Rejected: the source-leak check is cheap,
  deterministic, and catches a mis-scoped `files` glob before the tarball is ever uploaded.
