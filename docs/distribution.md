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
├── templates/<framework>/  # the frontends this distribution supports (see § 2.1)
├── apps/                   # maintained example applications
├── src/docs/               # developer documentation
├── package.json bun.lock   # the distribution's own workspace
└── manifest.json           # what was built: packages, sizes, exports, templates
```

### What a template contains

Each `templates/<framework>/` is a complete Vite project: `index.html`, `src/main.*`, a strict
`tsconfig.json`, `vite.config.ts`, `src/api.ts` and a README. It is **a frontend, not an
application** — the API it calls is your `tsir dev`, reached through the dev-server proxy at
`/api`:

```ts
// vite.config.ts
server: { proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true } } }
```

Three properties are checked rather than promised: the entry file `index.html` names exists, the
manifest is `private` and depends on no `@tsir/*` package (a template that imported the framework
would be a second application), and every framework in `manifest.json` has a directory — and vice
versa, so a template nobody configured cannot accumulate.

Styling (`tailwind`, `daisyui` on top of it, or nothing at all) and client routing are per
template, because they are answers the wizard asks for rather than defaults. The committed
configuration ships all three frontends with Tailwind, and DaisyUI for Svelte.

`make dist-check` proves these properties and fails the build otherwise:

1. the launcher exists and is executable
2. every `src/framework/*` package has an emitted directory with a distributable manifest
   (no `private`, no `workspace:*`)
3. no engineering asset leaked — no tests, fixtures, CI config, benchmarks or plans
4. no manifest names an absolute path on the machine that built it
5. templates and docs travel, checked by identity against the source
6. every configured frontend is emitted, and each template is a private Vite project that depends on
   no `@tsir/*` package

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
cp -r ../dist/templates/svelte ./web  # a frontend in front of this app (see § 2.1)
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

### The compiled launcher

`make verify-dist` also compiles the distribution's CLI into a single executable
(`bun build --compile`) and runs `tsir new` out of it. `make compile-cli` runs that one proof on its
own, in about ten seconds.

A compiled binary is a **third layout**, and it does not have what the other two have: no
`package.json` to read a version from, and no `stubs/` directory beside the code. Two things make it
work, and both are asserted rather than assumed:

- the templates reach the bundle through text imports (`stubs/*.slug.txt`), so the files stay
  editable on disk and are inlined at build time;
- the version is baked in with `--define TSIR_BUILT_VERSION='"0.0.0"'`, because `--define` rewrites an
  identifier and `readFileSync` finds nothing inside the binary.

The per-platform OpenTUI libraries are passed as `--external` and stay beside the binary: a `.so` or
`.dylib` is not something a bundler can inline. The binary is ~120 MiB, which is what embedding the
whole module graph costs.

## 5. Known limitations

- The templates are validated by `make verify-templates`, which installs, typechecks and builds each
  one from the registry. CI runs it after `make release-pack`; it is deliberately **not** part of
  `make check`, which has to pass offline.
- A template is a starting point, not a maintained application: it has one screen and one API call,
  and no tests of its own. `make verify-templates` proves it compiles and builds; it does not prove
  the page looks right, which nobody has asserted since the templates were written.
- `tsir proto:generate` requires `buf` and a `protoc-gen-es` devDependency in the application. It
  says so, with the install command, rather than failing obscurely.
- Package managers other than Bun are expressed in configuration and documentation; the generated
  `package.json` is manager-agnostic, but `npm`/`pnpm` installs are not yet exercised by CI.
- The compiled launcher is proven on this platform only. The `--external` list names every platform
  package, so the compile is portable in principle, but the darwin and win32 binaries are not built
  or run by CI.
