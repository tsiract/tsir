/**
 * The interactive surface: renderer session + prompts.
 *
 * Separate from the root entrypoint on purpose. `/` is the reporting path and has no renderer
 * dependency at all, so a command that only *prints* (`tsir route:list`, a `--json` run, a test)
 * never loads `@opentui/core` or its per-platform native binary. Only the commands that actually ask
 * a question import from here.
 *
 * ```ts
 * import { Reporter } from '@tsir/tui';
 * import { withSession, select } from '@tsir/tui/ui';
 * ```
 */

export * from './session.ts';
export * from './prompts.ts';
export * from './branding.ts';
