# AGENTS.md

Orientation for a coding agent (or a person arriving cold) working in this repository. It is
deliberately short and factual: what the project is, how to verify a change, and the conventions a
change is judged against. **If something here disagrees with the code, the code is right — and this
file has a bug, so fix it.**

`CONTRIBUTING.md` covers the same ground for humans in more depth. Read this first; read that when
you need the reasoning.

---

## 1. What this is

Tsir is a **backend-only TypeScript framework** that runs the same code on three targets — Bun,
Cloudflare Workers, and AWS Lambda — and stays inside each one's free tier. It is pre-alpha
(`status.json` is the machine-readable truth). Packages are not on npm; the distribution is built
locally with `make dist`.

**Nothing here is a normal app.** It is a framework monorepo: 34 packages under `src/framework/`,
an example application under `src/apps/`, and a set of gates under `src/tools/` that CI runs.

## 2. Before you change anything

```bash
make install        # bun install --frozen-lockfile
make verify         # make check + the whole test suite, ~3–4 min. This is "is my branch sane?"
make check          # the gates only, ~2.5 min — excludes the suite, on purpose (needs no DB/network)
bun test            # the suite alone, ~40 s — the fast loop while you work
bun test path/to/file.test.ts   # one file, sub-second
```

**`make check` can be green while `bun test` is red.** That is deliberate — `check` has to pass
offline with no database, and some tests need Postgres and Docker — so it is not the whole answer.
`make verify` is. Run `make verify` before you call something done; run `bun test <file>` while you
iterate. Individual gates are listed by `make help`.

**Do not skip a failing gate to save time.** Each one exists because something already went wrong
in a way that was expensive to find. If a gate is genuinely wrong, fix the gate in the same change
and say why in the commit.

### The gates that will reject a plausible-looking change

| Gate                                         | Rejects                                                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `check-error-codes`                          | A new `TsirError` code not registered in the package's union. Run `bun src/tools/check-error-codes.ts --write` after adding one. |
| `check-boundaries`                           | A framework package importing another it may not (`src/tools/check-boundaries.ts` has the matrix).                               |
| `check-plans`                                | A plan row that disagrees with its own index, a dangling `ADR-`/`Q` reference, a completed task with no acceptance text.         |
| `check-coercion`                             | A `String()`/`Number()`/`as` cast with no justification comment — see §6.                                                        |
| `make docs-pr` (`check-docs-in-pr.ts`)       | A framework source change with no changeset in `.changeset/`.                                                                    |
| `check-plans` / `check-links` / `check-make` | A doc naming a `make` target that does not exist, or a link to a file that moved.                                                |
| `check-driver-defaults`                      | A `DRIVER_DEFAULTS` row naming a driver the build does not ship, or an ephemeral default on a stateless target.                  |
| `check-production-wiring`                    | An app bootstrap that does not pass `production`, which would leave the package's production refusals unreachable.               |

## 3. Verify behaviour, not just types

Two patterns in this repo exist because a plausible change passed every test and was still wrong.
Both are worth copying.

**A guard nothing reaches is not a guard.** If you add a refusal or a production check, write the
test that makes it fire _and_ the wiring that reaches it from a real app (see `CAP-007`). Then run
it by hand once:

```bash
APP_ENV=production bun -e "…construct the thing…"
```

**A conformance kit's cases must fail a broken driver.** If you add cases, add a deliberately
broken implementation that violates exactly that rule, and assert the case catches it — otherwise
the case may be passing for a reason unrelated to what it claims (`src/framework/scout/src/conformance.test.ts`
is the model).

## 4. Conventions that are enforced, not stylistic

- **Errors are coded.** Anything an application can observe throws `TsirError` with a stable code
  (`ERR-003`). The code is registered in the package's union and in `src/docs/error-codes.json`.
  Message = what happened. `hint` = what to do. Never put the actionable part in the message.
- **No new runtime dependency** without an ADR, and it must be ESM and tree-shakeable. Two
  dependencies exist (`zod`, `drizzle-orm`); the bar is high.
- **No claim without evidence.** A performance or security statement in a doc carries a test or a
  measurement, or it is deleted.
- **Capabilities are configured by name in `tsir.js`.** A driver is selected by config, not wired in
  the app entry — that is what lets the production refusal run at boot (`CAP-006`). If you add a
  driver, add: a `*_DRIVERS` constant, the switch, a `*FromConfig` builder, the bootstrap wiring, and
  a `DRIVER_DEFAULTS` row.
- **A refusal happens at construction, never at first use.** A configuration that cannot work must
  fail while the config is still the thing being read.
- **Comments explain _why_, especially when the obvious thing would have been wrong.** Read a few
  before writing new ones; the house style is a short paragraph on the trap, not a restatement of
  the line under it.

## 5. Documentation map

| You need                                          | Read                                                   |
| ------------------------------------------------- | ------------------------------------------------------ |
| How a request flows, repo layout, git workflow    | `CONTRIBUTING.md`                                      |
| What each capability supports and what it refuses | `src/docs/guides/drivers.md`                           |
| Every error code and its meaning                  | `src/docs/errors.md` (`error-codes.json` is generated) |
| Using the framework in an app                     | `src/docs/guides/*.md`                                 |
| Why something is the way it is                    | the decision records (`ADR-nnnn`) and the task index   |
| What is actually built vs. planned                | `README.md` § "What is real today", `status.json`      |

When you change behaviour a doc describes, change the doc in the same commit. `check-links` and
`check-plans` catch the structural drift; only you catch the semantic kind.

## 6. Coercion

Dynamic JSON needs narrowing, and this repo makes that explicit rather than implicit. `as` is not
banned, but a cast over untrusted input needs a `// coercion-ok: <reason>` comment saying what was
validated and where. `String(x)` on a value that could be an object is usually a bug: it produces
`"[object Object]"`, which then travels. `src/framework/scout/src/hosted.ts` shows the pattern —
`idOf()` returns `''` for a non-primitive so the row is _visibly_ wrong rather than plausibly wrong.

## 7. Git

- One branch: this session's branch. Commit there, push there, open PRs from there.
- Conventional commits with an **allowed scope** — `router`, `http`, `validate`, `core`,
  `container`, `config`, `console`, `tui`, `dist`, `testing`, `frontpage`, `tools`, `ci`, `release`,
  `deps`, `repo`. A package name is _not_ a scope (`feat(pennant):` is rejected); use `repo` or the
  layer. `commitlint` runs on commit.
- A framework source change needs a changeset in `.changeset/`.
- The commit body is for the _why_. Several commits here explain what the first attempt got wrong
  and why it was observable; that is the house style and it is useful — keep it.

## 8. When you are stuck

- `make help` lists every target.
- `bun src/tools/<gate>.ts` runs one gate with its own output.
- The task index is the honest backlog; a task marked `[x]` should match the code, and if it does
  not, that discrepancy is the bug. Cite tasks by id (`CAP-007`), never by path — the plans
  directory is internal on purpose (`DOC-016`) and `check-plan-refs` enforces it.
- If the sandbox lost `bun`: `npm pack @oven/bun-linux-x64@<version>` → extract → `bin/bun` into a
  directory on `PATH`, then `bun install --frozen-lockfile`.
