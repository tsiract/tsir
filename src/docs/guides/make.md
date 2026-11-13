# Contributor build commands on macOS and Linux

This guide is for framework contributors building or testing the distribution. Application
developers should start with [installation](../installation.md) and use `tsir` from their app.

The repository uses GNU Make (including the version shipped with macOS), Bash, Git and Bun.
Install the exact Bun version in `package.json` when possible, then run these from the checkout:

```sh
bun --version
make install
make doctor
make dist
make verify-dist
make verify      # every gate plus the test suite — the one to trust
```

`make check` is the gates alone, and it must pass offline: no database, no Docker, no network. The
tests that need those therefore are not in it, so **`make check` can be green while `bun test` is
red**. `make verify` is `check` + `test`, and it is what to run before pushing.

`make dist` compiles the 24 framework packages, ships runnable examples and static apps, and installs
the generated distribution dependencies in ignored `dist/`. The source checkout must already have
its own workspace dependencies installed; building may need npm registry access. Run
`./dist/tsir --help` after the build, or read `dist/README.md` for its layout. Rebuilding removes
the entire generated directory, so do not keep your own app there. Use `make install` after a
fresh clone or dependency/lockfile change. If a build fails, include the complete output of
`make dist`, `bun --version`, `make --version`, `uname -sm` and the install command used when
reporting it; do not include `.env` values or credentials. TypeScript diagnostics now print rather
than being swallowed. For a clean rebuild, `make clean` removes generated `dist/` and `.tsir/`
runtime records; stop the dev server first.

## Target categories and prerequisites

| Targets                                                                                                   | Purpose and requirements                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `help`, `doctor`, `install`                                                                               | Discover targets, check the machine, install dependencies; install needs registry access.                                                                                                                                            |
| `dev`, `kill-owned`, `kill-ports-dry`                                                                     | Start the site, stop recorded dev processes, or inspect port owners. `dev` and `test-watch` keep running until stopped.                                                                                                              |
| `kill`, `kill-ports`                                                                                      | **Potentially disruptive:** sweep unprotected listening ports, including other user-owned servers. Prefer `kill-owned`; use `kill-ports-dry` first. macOS uses `lsof`, Linux uses `ss`.                                              |
| `verify`, `check`, `typecheck`, `lint`, `format-check`, `test`, `coverage`, `logs`                        | Local quality checks. `verify` = `check` + `test` and is the honest "is my branch sane?"; `check` is the gates only and must pass offline, so it can be green with a failing suite. `format` writes changes.                         |
| `frontpage-build`, `docs-site`, `docs-packages[-write]`, `links`, `surface[-write]`, `readme[-check]`     | Build or check docs and generated files; `-write`/`readme` modifies tracked files.                                                                                                                                                   |
| `llms[-check]`                                                                                            | Regenerate or verify `llms.txt`, the documentation index written for a model. `check` fails when a page was added, moved or retitled without regenerating it.                                                                        |
| `dist`, `build`, `verify-dist`, `release-pack[-fast]`                                                     | Build, test and package generated artifacts. Verify uses Node when present; release packaging needs `tar`, registry access and Bun. On macOS verify checksums with `shasum -a 256 -c SHA256SUMS.txt`; Linux also has `sha256sum -c`. |
| `proto`, `proto-check`                                                                                    | Regeneration needs `buf`; `proto-check` explicitly skips without it.                                                                                                                                                                 |
| `db-up`, `db-down`, `test-integration`, `migrate`, `migrate-status`, `seed`                               | Database operations; Compose needs Docker and `POSTGRES_PASSWORD`. Integration tests need `DATABASE_URL`; migration/seed targets need `APP=path`. Check the destination before running writes.                                       |
| `deploy-plan`, `deploy-diff`, `deploy-build`, `deploy-validate`, `route-list`, `route-compile`, `openapi` | Operate on an app. Most use the HTTP example when `APP` is omitted; `route-compile` targets that example; `openapi` requires `APP`. Deploy build emits artifacts, not live infrastructure.                                           |
| `changeset`, `release-version`, `new-package`, `bench-write`, `clean`, `clean-cache`                      | Mutating maintenance commands. Supply the documented arguments; inspect the effects before running.                                                                                                                                  |

Use `make help` and inspect the Makefile for all targets and flags. Paths and platform tools may
vary. macOS/Linux CI checks the build on both operating systems; it is not a guarantee for every
local setup, external service, Docker version or shell customization.
