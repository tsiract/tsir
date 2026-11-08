# `@tsir/tui`

The terminal interface shared by Tsir's commands — engineering, distribution and developer-facing.

The renderer is [`@opentui/core`](https://github.com/anomalyco/opentui); this package is the part that
must not vary between commands.

| Module        | Responsibility                                                              |
| ------------- | --------------------------------------------------------------------------- |
| `theme.ts`    | Palette, glyphs, widths. Colour is off under `NO_COLOR`, `TERM=dumb`, pipes. |
| `session.ts`  | TTY detection, renderer lifetime, and terminal restoration on every exit.    |
| `prompts.ts`  | `select`, `multiSelect`, `confirm`, `text` — typed async functions.          |
| `report.ts`   | Headings, checks, tables and summaries with no renderer dependency.          |
| `branding.ts` | The version and banner every screen shares.                                  |

## Interaction contract

One set of keys, shown on every prompt footer: arrows navigate, `Enter` accepts, `Space` toggles a
multi-select, `Esc` goes back, `Ctrl+C` cancels. Cancelling throws `PromptCancelled`, so a caller
unwinds without writing anything.

## Interactivity is a capability, not a default

`canPrompt()` requires a TTY on stdin and stdout, and refuses under `--no-interactive`,
`TSIR_NO_INTERACTIVE=1` and `CI`. A command that needs a terminal calls `requireInteractive()` and
reports `NotInteractiveError` with the flags that would have answered the question — it never waits
for a keypress that cannot arrive. `Reporter` produces the same facts on that path, so
`--no-interactive`, `--json` and a test all read the same output.

## Terminal restoration

`openSession()` installs `SIGINT`, `SIGTERM` and `SIGHUP` handlers that restore the terminal and then
re-raise the signal, and `session.run()` restores in a `finally`. A wizard that throws, is `Ctrl+C`'d,
or is killed leaves a usable shell.

## Why this is a package and not a `src/tools/` module

`make dist` emits every `src/framework/*` package, so the same implementation serves the core
Makefile, the distribution wizard and the public `tsir` CLI without a second copy — and a developer
command never imports an engineering module to draw a prompt.
