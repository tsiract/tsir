/**
 * `defineCommand` (CLI-019): a project command is a name, a summary, and a run function.
 *
 * Names are kebab-case words, optionally `:`-separated like the framework's own (`make:job`).
 * `registerCommands` refuses two commands with one name, so a project command can never silently
 * shadow a framework command or another project command.
 */

import { UsageError } from './output.ts';

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly run: (argv: readonly string[]) => Promise<number>;
}

const COMMAND_NAME = /^[a-z][a-z0-9]*(?::[a-z][a-z0-9]*|-[a-z0-9]+)*$/u;

/** Validates a command definition. Returns it unchanged so it can be exported as a constant. */
export function defineCommand(spec: CommandSpec): CommandSpec {
  if (!COMMAND_NAME.test(spec.name)) {
    throw new UsageError(
      `"${spec.name}" is not a valid command name`,
      'use lowercase words, optionally joined by `-` or `:`, e.g. `ping` or `db:reset`',
    );
  }
  if (spec.summary.trim() === '') {
    throw new UsageError(`command "${spec.name}" needs a summary`, 'one line for `tsir help`');
  }
  return spec;
}

/** Returns the commands in order, or throws naming the first name that appears twice. */
export function registerCommands<T extends { readonly name: string }>(
  commands: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  for (const command of commands) {
    if (seen.has(command.name)) {
      throw new UsageError(
        `command "${command.name}" is defined twice`,
        'rename one of them: each command name is registered once',
      );
    }
    seen.add(command.name);
  }
  return commands;
}
