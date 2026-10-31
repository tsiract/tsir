/**
 * `tsir test`, `tsir lint`, `tsir typecheck` (CLI-008).
 *
 * Each runs the same command as the matching `make` target, with the same Bun binary, in the
 * working directory. The exit code is passed through unchanged, so a CI script can use either
 * entry point. Extra arguments are appended: `tsir test --watch` runs `bun test --watch`.
 */

import { EXIT, info } from '../output.ts';

/** The argv after the Bun binary. The Makefile recipes are the source of truth; a test pins them. */
export const TOOL_RECIPES = {
  test: ['test'],
  lint: ['src/tools/lint.ts'],
  typecheck: ['x', 'tsc', '--noEmit', '-p', 'tsconfig.json'],
} as const satisfies Record<string, readonly string[]>;

export type ToolName = keyof typeof TOOL_RECIPES;

export function toolArgv(name: ToolName, extra: readonly string[]): string[] {
  return [process.execPath, ...TOOL_RECIPES[name], ...extra];
}

export function toolCommand(name: ToolName) {
  return async (argv: readonly string[]): Promise<number> => {
    const command = toolArgv(name, argv);
    info(`  → ${command.slice(1).join(' ')}`);
    const child = Bun.spawn(command, {
      cwd: process.cwd(),
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const code = await child.exited;
    return code === 0 ? EXIT.ok : code;
  };
}
