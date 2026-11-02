/**
 * `tsir test`, `tsir lint`, `tsir typecheck` (CLI-008).
 *
 * Runs application-local tools in the working directory. The exit code passes through unchanged. Extra arguments are appended: `tsir test --watch` runs `bun test --watch`.
 */

import { EXIT, info } from '../output.ts';

/** The argv after the Bun binary. Applications define their own lint and typecheck scripts. */
export const TOOL_RECIPES = {
  test: ['test'],
  lint: ['run', 'lint'],
  typecheck: ['run', 'typecheck'],
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
