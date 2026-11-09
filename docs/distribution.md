# Building and consuming the Tsir distribution

Three environments share this repository, and confusing them is the single most expensive mistake
available here. Read this before changing anything that crosses a boundary.

| Environment                  | Who                   | Entry point                  |
| ---------------------------- | --------------------- | ---------------------------- |
| **Core engineering**         | the Tsir team         | `make` in this repository    |
| **Distribution engineering** | the Tsir team         | `make dist` → `dist/`        |
| **Application development**  | developers using Tsir | `dist/tsir` → `apps/<name>/` |

The root repository builds Tsir. `make dist` packages Tsir. `dist/tsir` delivers Tsir. A generated
application is a _consumer_ of all three and never a part of the repository.

## 1. Core engineering

```bash
make install        # workspace dependencies
make dev            # preflight, then serve frontpage + docs + the admin app
make kill           # stop what `make dev` recorded, then free its ports
make test           # the framework's own tests, against source packages
make check          # typecheck, lint, boundaries, docs, links, policy, codegen
make build          # compile the framework packages into .build/
make clean          # remove .build/ and dist/
```

None of these produce or require an application. `make help` is the authoritative list; it is
generated from the targets that exist, and `make check` fails if `.PHONY` names a target that does
not.

**`make dev` owns exactly two things:** the dev server it starts, and the ports that server recorded.
`make kill` signals a process only when it is alive, its recorded start label still matches (so a
reused PID is not mistaken for the server), and its command line is a Tsir dev server. An unknown
owner of a port is reported, never killed.

## 2. Distribution engineering

`make dist` is not a compile step. It is a **configuration** step followed by a build:

```bash
make dist                     # the wizard (when a terminal is attached), then the build
make dist DIST_YES=1          # build with the committed config, never prompt
make dist DIST_CONFIG_ONLY=1  # write the config and stop — review it before committing
make dist FRONTEND=react STYLING=tailwind,daisyui
make dist-build               # assemble only, no configuration step (what CI runs)
```

### The wizard

Nine questions, each with a default, every answer revisitable, and a review screen before anything
is written:

1. which frontend frameworks the distribution ships templates for
2. per-template styling (Tailwind, DaisyUI, plain CSS)
3. per-template client routing
4. which package managers applications may use
5. which of those is the default
6. testing and code-quality tooling
7. runtime targets (only ones `@tsir/deploy` actually implements)
8. API tooling (OpenAPI, Protocol Buffers)
9. the review

Questions 2 and 3 repeat per chosen framework, so a single-framework distribution asks seven.

Keys are the same on every screen: arrows navigate, `Enter` accepts, `Space` toggles, `Esc` cancels,
`Ctrl+C` cancels. The terminal is restored on every exit path — completion, an exception, or a
signal.

### The configuration is data

Answers are written to **`tsir.dist.config.json`**, which is committed. A distribution is a product
decision — which frontends it supports, which manager its applications get — and a decision that
lives only in someone's terminal history cannot be reviewed or reproduced.

- A rerun reports the existing file and offers to keep it. It never silently replaces a decision.
- Nothing is written until the review is confirmed; declining leaves the file untouched.
- Invalid combinations are refused by the validator, not built: DaisyUI without Tailwind, a default
  manager the distribution does not ship, an unimplemented runtime.
- With no file at all, the documented defaults apply, so a fresh checkout builds without the wizard.

### What the build produces

```
dist/
├── tsir                    # the developer executable
├── bin/tsir                # same thing, for PATH
├── framework/<package>/    # every @tsir/* package: JS, .d.ts, exports map, README
├── apps/                   # maintained example applications
├── src/docs/               # developer documentation
├── package.json bun.lock   # the distribution's own workspace
└── manifest.json           # what was built: packages, sizes, exports
```

`make dist-check` proves five properties and fails the build otherwise:

1. the launcher exists and is executable
2. every `src/framework/*` package has an emitted directory with a distributable manifest
   (no `private`, no `workspace:*`)
3. no engineering asset leaked — no tests, fixtures, CI config, benchmarks or plans
4. no manifest names an absolute path on the machine that built it
5. templates and docs travel, checked by identity against the source

The build is **reproducible**: two runs over the same sources produce the same tree. That is why
`manifest.json` carries no timestamp.

## 3. Consuming the distribution

Extract or build the distribution where applications will live beside it:

```
somewhere/
├── dist/          ← the distribution
└── apps/          ← applications you create
```

```bash
cd somewhere/apps
../dist/tsir new billing-api       # creates apps/billing-api/
cd billing-api
bun install                        # or npm / pnpm, per the distribution's default
bun x tsc --noEmit                 # typechecks as generated
../dist/tsir test                  # the scaffold's tests pass as generated
../dist/tsir dev                   # serves the exported handler
../dist/tsir build                 # writes .tsir/manifest.json + drivers.gen.ts
../dist/tsir clean                 # removes that build output and nothing else
```

Creating an application **inside `dist/`** is refused: the next `make dist` replaces that directory.
Applications always live in `apps/<name>/` next to the distribution, never `app/` at the root.

The scaffold's `package.json` reaches the framework with **relative `link:` ranges** and an
`overrides` block covering every shipped package. Both are required, and both were arrived at by
breaking:

- `file:` installs, but bun copies a `file:` dependency **once per dependent**, so `@tsir/router`
  exists several times over. The framework keeps process-local registries (routes, controllers, the
  container), and two copies are two registries — the application registered a route in one and the
  test harness looked for it in another.
- `overrides` covers transitive `@tsir/*` ranges. A `file:`/`link:` dependency covers only what the
  application imports directly; without overrides every framework package's own dependencies look
  for a registry that has no Tsir packages on it yet.

## 4. Extending

- **A new framework package**: add `src/framework/<name>/` with a manifest and `src/index.ts`. It is
  picked up by `make build`, `make dist`, `check-boundaries` and `check-deps` automatically, and the
  scaffold's `overrides` block will include it without an edit. If it needs a third-party runtime
  dependency, the policy (ADR-0012) requires a rationale, a scope and an ADR entry first.
- **A new CLI command**: add it to `COMMANDS` in `@tsir/console` with a `summary` and a `run`. A
  command with no `run` is listed as planned and exits 3 — the surface stays honest either way.
- **A new distribution template**: describe it in the config schema before writing files for it. The
  wizard asks the questions the schema can validate.
- **A new application template**: it must share the backend. A frontend is an integration over HTTP
  contracts, never a second backend implementation.

## 5. Known limitations

- Frontend templates are configured but not yet emitted: the config accepts `svelte`, `react` and
  `vue`, and the committed baseline is deliberately backend-only until the templates exist.
- `tsir proto:generate` requires `buf` and a `protoc-gen-es` devDependency in the application. It
  says so, with the install command, rather than failing obscurely.
- Package managers other than Bun are expressed in configuration and documentation; the generated
  `package.json` is manager-agnostic, but `npm`/`pnpm` installs are not yet exercised by CI.
