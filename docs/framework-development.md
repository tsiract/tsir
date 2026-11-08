# Working on Tsir itself

The short version: this repository builds the framework. It is not an application, and `make` is not
a way to run one. If you find yourself wanting `make start` or `make migrate`, the answer is that
those are application verbs and they live behind `dist/tsir` — see [distribution.md](./distribution.md).

## The loop

```bash
make install    # once
make dev        # preflight, kill what we started, serve frontpage + docs + admin
make test       # the framework's tests
make check      # everything CI runs
```

`make check` is the gate. It runs: `typecheck`, `lint`, `boundaries`, `docs-pr`, `modules`,
`frontpage`, `license`, `deps`, `plan-refs`, `plans`, `error-codes`, `docs-packages`, `docs-site`,
`links`, `surface`, `readme-check`, `version`, `format-check`, `codegen-check`, `coercion`, `crypto`,
`flakes`, `proto-check`. Most of those are constraints rather than tests, and each one exists because
something broke once.

## Where a change belongs

| You want to…                       | Put it in                                        |
| ---------------------------------- | ------------------------------------------------ |
| add framework behaviour            | `src/framework/<package>/src/`                   |
| add a CLI command                  | `@tsir/console`'s `COMMANDS` table               |
| change what a generated app gets   | `@tsir/console/src/stubs/`                       |
| change what the distribution ships | `src/tools/dist.ts` + `src/tools/dist-config.ts` |
| change how commands look           | `@tsir/tui`                                      |
| change an engineering gate         | `src/tools/check-*.ts`                           |
| record a decision                  | a new ADR, following `ADR-0031`                  |

## The rules that are enforced, not suggested

- **Internal plan paths stay inside the plan tree.** Elsewhere, cite an id (`HTP-013`,
  `ADR-0027`) instead; the plans are not part of the shipped material.
  `make plan-refs`.
- **Packages declare what they import.** `make boundaries` holds the graph; a new edge is a decision
  with a comment, not an accident.
- **Runtime dependencies are allowlisted.** `make deps` requires a rationale, a scope and an ADR
  entry before a third-party package becomes a runtime dependency (ADR-0012, ADR-0022).
- **Error codes are append-only and documented.** `make error-codes`.
- **The public surface is recorded.** `make surface`.
- **Generated code is committed and current.** `make codegen-check`, `make proto-check`.

## Testing expectations

- Framework tests run against **source** packages, never against `dist/`. `make test` must work
  without building anything.
- A test that asserts on user-visible output should use `Reporter`'s lines, not a rendered screen.
- A test for an interactive path belongs under a pty (`make tui-check`), because a prompt that looks
  right in a snapshot and hangs in a terminal is exactly the failure worth catching.
- Independence of the distribution is proved by copying `dist/` somewhere else and scaffolding an
  application there. A test that scaffolds from inside this repository proves nothing: the relative
  `link:` ranges still reach the monorepo.

## Adding a framework package

1. `src/framework/<name>/package.json` — `private: true`, `workspace:*` ranges, explicit `exports`.
2. `src/framework/<name>/src/index.ts` — the public surface, nothing else exported.
3. `src/framework/<name>/README.md` — one paragraph and the surface.
4. Register it in `src/tools/check-boundaries.ts` with its permitted dependencies and a comment
   saying why they are those.
5. Nothing else: `make build`, `make dist`, the dependency checks and the generated applications'
   `overrides` block all discover it by directory.

## Adding a gate

A gate is worth adding when a rule cannot be kept by attention alone. Write it as
`src/tools/check-<thing>.ts`, exit 0/1, print one line on success and the offending paths on failure,
add it to `make check`, and say in the file's header which failure it prevents.
