# The terminal interface

`@tsir/tui` is the one place Tsir decides how it looks and asks questions. It is a framework package,
not a `src/tools/` module, because three environments need the same behaviour: the core Makefile, the
distribution wizard, and the public `tsir` CLI. A developer-facing command must never import an
engineering module to draw a prompt.

The renderer is [`@opentui/core`](https://github.com/anomalyco/opentui); the decision and the
evidence behind it are in **ADR-0031**. This page is how to use it.

## Two entrypoints, because the difference is a dependency

```ts
import { Reporter, createPalette } from '@tsir/tui'; // reporting: no renderer
import { withSession, select, confirm } from '@tsir/tui/ui'; // interactive: renderer + prompts
```

`@tsir/tui` loads **no renderer at all**, so a command that only prints (`route:list`, any `--json`
run, a test) never pulls in the per-platform native binary. `@tsir/tui/ui` is the interactive
surface. `make deps` proves the split: `@opentui/core` is scoped to the `@tsir/tui/ui` subpath and
the import graph shows the root path never reaches it.

## Reporting

```ts
const reporter = new Reporter();
reporter.section('Doctor', { note: 'runtime, config, manifest' });
reporter.check({ status: 'ok', label: 'runtime', detail: 'bun 1.4.4' });
reporter.check({ status: 'warn', label: 'manifest', detail: 'not generated yet' });
reporter.field('config', '2 keys valid');
reporter.table([{ header: 'template' }, { header: 'pkgs', align: 'right' }], [['backend', '10']]);
reporter.summary({ ok: 7, warnings: 1, next: ['run tsir build'] });
reporter.flush();
```

`Reporter` has no renderer dependency and no TTY requirement, so the same call produces the output a
test asserts on, a CI log records, and a person reads. Colour is opt-out: `NO_COLOR`, `TERM=dumb`, or
a non-TTY all yield plain text.

## Interactivity is a capability

```ts
if (!canPrompt()) return headlessPath(); // pipe, CI, --no-interactive
await withSession({ what: 'the wizard', hint: 'pass --frontend svelte' }, async (renderer) => {
  const frontend = await select(renderer, { message: 'Frontend', options });
  const tools = await multiSelect(renderer, { message: 'Tooling', options });
  if (!(await confirm(renderer, { message: 'Generate?' }))) return;
});
```

`canPrompt()` requires a TTY on **both** stdin and stdout, and refuses under `--no-interactive`,
`TSIR_NO_INTERACTIVE=1` and `CI`. `withSession` throws `NotInteractiveError`
(`TUI_NO_TERMINAL`) naming the flags that would have answered the question. A prompt never waits for
a keystroke that cannot arrive.

Every interactive command must have a non-interactive path that answers the same questions with
flags. That is not a courtesy: it is what makes the command usable in a script, in CI, and in a
review.

## The key set, everywhere

| Key       | Effect                                |
| --------- | ------------------------------------- |
| `↑` / `↓` | move the selection                    |
| `Enter`   | accept                                |
| `Space`   | toggle (multi-select only)            |
| `Esc`     | cancel the wizard (`PromptCancelled`) |
| `Ctrl+C`  | cancel, and restore the terminal      |

`Ctrl+C` is a **keypress**, not a signal: in raw mode the terminal owns the byte, so no `SIGINT` is
ever delivered. The prompts handle `{name:'c', ctrl:true}` themselves, which is what makes "cancel
safely" true rather than aspirational.

## Terminal restoration

`openSession()` installs `SIGINT`, `SIGTERM` and `SIGHUP` handlers that restore the terminal and then
re-raise the signal; `session.run()` restores in a `finally`. `renderer.destroy()` is idempotent here.

This is tested by driving a real pty, not by inspecting a screenshot: `make tui-check` runs the
prompts under a pseudo-terminal, sends arrow keys and `Ctrl+C`, and asserts on what came back —
including the escape sequences that prove the cursor and the alternate screen were restored.

## Adding a screen

1. Prefer `Reporter`. If the command can be complete without a question, it should be.
2. If it must ask, ask with these prompts rather than a new one, so the keys and the wording stay
   consistent.
3. Give every question a flag, and make `--no-interactive` produce the same decisions.
4. If the screen needs something this package does not do, add it _here_ with a test, and record why
   in ADR-0031 rather than reaching into `@opentui/core` from a command.
