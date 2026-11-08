/**
 * `@tsir/tui` — the terminal interface shared by every Tsir command.
 *
 * Three environments use this, and they get different amounts of it:
 *
 *   - **Core engineering** (`make dev`, `make dist`) runs the full interactive surface.
 *   - **Distribution engineering** (`make dist`'s wizard) configures what the product offers.
 *   - **Application developers** (`tsir new`, `tsir doctor`) get prompts and reports.
 *
 * The renderer is not written here. `@opentui/core` provides it: a real terminal renderer with
 * flexbox layout, focus management and keyboard handling (ADR-0031). What this package adds is the
 * part that must not vary between commands — the wording, the layout conventions, the interaction
 * keys, the behaviour when there is no terminal, and the guarantee that a crash leaves the terminal
 * usable.
 *
 * ## Two entrypoints
 *
 *   `@tsir/tui`       reporting only — theme, `Reporter`, identity. **No renderer dependency**, so a
 *                     command that prints facts never loads a native binary.
 *   `@tsir/tui/ui`    the interactive surface — `withSession`, `select`, `multiSelect`, `confirm`,
 *                     `text`, `canPrompt`.
 *
 * ## Why there is a prompt fallback
 *
 * Interactive mode is the default *when attached to a terminal*. A command run from a script, a CI
 * job, or a pipe has no terminal to draw into, and a wizard that waits for a keypress that can never
 * arrive is a hang. `requireInteractive()` therefore refuses with the flags that would have answered
 * the question, and `Reporter` produces the same facts on that path.
 */

export * from './theme.ts';
export * from './report.ts';
export { frameworkVersion, versionLine } from './branding.ts';
