# 0031 — A terminal UI layer behind one shared package

**Status:** Accepted · 2026-11-07

## Context

Tsir's commands had three unrelated interfaces. `make dev` printed `printf` lines, `tsir doctor`
printed its own check list, `tsir new` printed a `✓ created …` list, and any command that needed a
decision instead of a flag had no way to ask. Three consequences followed:

1. **No question was ever asked.** Every choice a person makes — which frontend a distribution
   ships, which package manager an application gets — could only be expressed as a flag. A developer
   who did not already know the flag got a default and never learned that a choice existed.
2. **Automation and interaction were the same code path.** Nothing could tell whether a terminal was
   attached, so behaviour could not differ between a person and a CI job.
3. **Every command looked different.** No shared keys, no shared wording, no shared failure shape.

The task specified a research step rather than a preference: evaluate OpenTUI, Ink and Clack, use
Bubble Tea's Model–Update–View as the architectural reference, and reject OpenTUI if its portability
or packaging constraints are unacceptable.

## Decision

**`@tsir/tui` is a framework package** (not `src/tools/`, not part of `@tsir/console`) wrapping
[`@opentui/core`](https://github.com/anomalyco/opentui) `0.8.3` as the renderer. It owns five things
and nothing else: theme, session, prompts, reporting, identity.

`make dist` emits every `src/framework/*` package, so one implementation serves the core Makefile,
the distribution wizard and the public `tsir` CLI. A developer-facing command never imports an
engineering module to draw a prompt — it imports the package that was shipped for exactly that.

### Interaction contract

Arrows navigate, `Enter` accepts, `Space` toggles a multi-select, `Esc` cancels, `Ctrl+C` cancels.
The legend is printed on every prompt. Cancelling throws `PromptCancelled` (`TUI_CANCELLED`), so a
caller unwinds without writing anything.

### Interactivity is a capability, never a default

`canPrompt()` requires a TTY on **both** stdin and stdout, and refuses under `--no-interactive`,
`TSIR_NO_INTERACTIVE=1` and `CI`. `requireInteractive()` throws `NotInteractiveError`
(`TUI_NO_TERMINAL`) naming the flags that would have answered the question. `Reporter` renders the
same facts on that path, so `--no-interactive`, `--json`, a pipe and a test all read one output.

### The renderer is not trusted to clean up after itself

`openSession()` installs `SIGINT`/`SIGTERM`/`SIGHUP` handlers that restore and re-raise, and
`session.run()` restores in a `finally`. `renderer.destroy()` is idempotent here, so a throw, a
cancel and a signal cannot leave the shell without its cursor.

## Evidence

Measured on this branch, Bun 1.4.4, linux-x64:

| Check                    | Result                                                                        |
| ------------------------ | ----------------------------------------------------------------------------- |
| Renders                  | `createCliRenderer` + box/text renders correctly in a real pty                |
| Keyboard                 | `↑`/`↓` move, default selected, `Enter` accepts, `Esc` cancels (`PromptCancelled`) |
| Ctrl+C                   | Cancels, exits 0, and the pty log shows `\e[?25h` + `\e[?1049l` (restored)    |
| Platforms                | Prebuilt natives: darwin-x64/arm64, linux-x64/arm64 (+musl), win32-x64/arm64   |
| Node compatibility       | `import('@opentui/core')` succeeds under Node 22 via its `node` condition     |
| Package integrity        | `@opentui/core` MIT; optional platform packages `MIT AND LGPL-2.1-or-later`   |
| Alternative: Ink 8       | React reconciler for a terminal; no prebuilt binary, but a virtual DOM to maintain |
| Alternative: Clack 1.8   | Excellent prompts, no layout/focus model for a dashboard-style wizard         |

### Why OpenTUI despite the LGPL binary

The alternative to a prebuilt renderer is not a simpler binary — it is no renderer at all in this
project, because writing one is exactly what the task forbids. The LGPL rides on the *optional*
platform package, is statically linked into a separate shared object that is transparently
replaceable in the published tree, and Tsir consumes it unmodified through its public API. It is
recorded here, and in `check-deps`' policy, rather than left for a licence scanner to discover.

The dependency is declared with an explicit optional-dependency contract: the distribution ships all
platform packages in its manifest, so `bun install` on any supported platform resolves exactly one
native without a compile step.

## Consequences

- One prompt wording, one key set, one failure shape, across three environments.
- `@tsir/console` depends on `@tsir/tui`; `@tsir/tui` depends on nothing else in the framework, so
  there is no cycle and no reason for a runtime package to acquire a UI dependency.
- Colour is opt-out (`NO_COLOR`, `TERM=dumb`, non-TTY) and glyphs fall back to ASCII under
  `TSIR_TUI=ascii`, so a pipe and a legacy console both stay readable.
- The interactive layer is tested by driving a pty (`make tui-check`), because a prompt that "looks
  right" in a snapshot and hangs in a real terminal is the failure this layer exists to prevent.
- Adding a second UI library later would mean re-implementing `session.ts` and `prompts.ts`, which
  is the seam the wrapper exists to keep narrow.

## Alternatives considered

- **Ink.** Maintained and familiar, but it renders React: a wizard screen becomes a component tree
  and a test becomes a renderer harness, for prompts that are a list and a cursor.
- **Clack.** The best-looking prompts of the three and the least machinery. Rejected because it is a
  sequence of questions, not a screen: no layout, no focus model, no way to draw a summary the user
  navigates back into, which the distribution wizard requires.
- **Hand-rolled ANSI.** Explicitly out of scope, and the reason this ADR exists.
