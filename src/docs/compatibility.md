# Compatibility policy and upgrade guide

What a version number promises, what counts as a breaking change, and how to move between
versions. The framework is **pre-alpha**. Read the first section before you depend on anything
in it.

---

## 1. Where the project is today

- Every `@tsir/*` package is at `0.0.0` and none is published to npm yet.
- **There is no backward-compatibility promise before `1.0.0`.** A public API that turns out to
  be wrong is renamed or removed, not aliased. No deprecation shims are kept.
- Each change that touches the public surface is still written down, in the changelog, so
  you can see exactly what broke. See [Upgrading](#4-upgrading).

## 2. Versioning

- **Lockstep.** Every `@tsir/*` package shares one version. A release bumps all of them
  together, so you never have to work out which `@tsir/http` goes with which `@tsir/core`.
- **SemVer starts at `1.0.0`.** From then on:
  - a **major** release may break the public surface;
  - a **minor** release adds to it and does not break it;
  - a **patch** release fixes bugs and does not change the public surface.
- **Support window.** Once `1.0.0` ships, the latest minor and the previous minor receive
  security fixes. Older minors do not.
- **Deprecation.** Starts at `1.0.0`. A feature to be removed is marked deprecated in a minor
  release, keeps working until the next major, and is named in the changelog when it is
  deprecated and again when it is removed.

## 3. What counts as the public surface

A change is breaking when a consumer's working code stops compiling, stops running, or
behaves differently in a way the docs promise. For this project that means:

- **Exports.** Anything a package exports, as recorded in
  [`api-surface.json`](./api-surface.json). `make surface` fails when the surface changes
  without that file being updated, so a change to the public API cannot slip through unseen.
- **Error codes.** Each code in [`error-codes.json`](./error-codes.json) is part of the surface.
  Removing or renaming one is breaking. [`errors.md`](./errors.md) is generated from that
  registry.
- **Command-line commands** and their flags, as printed by `tsir help`.
- **Configuration keys** in `tsir.js`. A key you can set is part of the surface.
- **Migration folders.** The layout described in [`migrations.md`](./migrations.md).

Anything not listed above, and anything under a path a package does not export, is internal
and can change in any release.

## 4. Upgrading

Until `1.0.0`, read the changelog entry for every version between yours and the one you are
moving to. Every change to the public surface has one.

1. **Update all `@tsir/*` packages together.** Lockstep means mixed versions are a bug, not a
   supported setup.
2. **Read the changelog for each version you skip.** Entries name each breaking change and what
   replaces it.
3. **Run the checks.** `tsir doctor` reports config and project problems. Your own test suite
   catches the rest.
4. **Migrations.** Before a production run, follow the runbook in
   [`migrations.md`](./migrations.md). `tsir migrate:status` and `tsir migrate:verify` show
   what would run before anything is applied.
5. **Deploy artifacts.** If you deploy to Cloudflare or Lambda, rebuild with
   `tsir deploy:build` and check the output with `tsir deploy:validate`. Do not reuse a bundle
   built from an older version.

## 5. Release process

- Every change to the public surface ships with a changeset, one file per change. `make changeset`
  writes one, and CI fails when a framework change has none (`make docs-pr`).
- `make version` applies all pending changesets as one bump, so every package moves together.
- A release is a version tag (`v*`). The release workflow checks that the tag matches the
  version in `package.json`, builds the artifacts, and publishes to npm only when publishing is
  switched on for the repository.
- Release channels: today there is only the tagged `latest` release. Separate `canary` and `next`
  channels are planned and not yet automated.
- A release commit must pass `make check`.
