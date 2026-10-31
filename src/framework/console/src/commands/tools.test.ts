import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../index.ts';
import { TOOL_RECIPES, toolArgv } from './tools.ts';

// CLI-008: each wrapper runs the same command as its `make` target. The Makefile is the source of
// truth, so these tests read it: if a recipe drifts, the wrapper fails here before it misleads CI.

const MAKEFILE = join(import.meta.dir, '..', '..', '..', '..', '..', 'Makefile');

function recipeOf(target: string): string {
  const text = readFileSync(MAKEFILE, 'utf8');
  const block = text.split('\n');
  const start = block.findIndex((line) => line.startsWith(`${target}:`));
  if (start === -1) throw new Error(`no make target ${target}`);
  for (let i = start + 1; i < block.length; i += 1) {
    const line = block[i] ?? '';
    if (!line.startsWith('\t')) break;
    const match = /\$\(BUN\)\s+(.*)$/.exec(line);
    if (match?.[1] !== undefined) return match[1].trim();
  }
  throw new Error(`no $(BUN) recipe in ${target}`);
}

describe('CLI-008: wrappers match their make targets', () => {
  test.each(['test', 'lint', 'typecheck'] as const)(
    '%s runs the same command as make %s',
    (name) => {
      expect(TOOL_RECIPES[name].join(' ')).toBe(recipeOf(name));
    },
  );

  test('extra arguments are appended after the canonical command', () => {
    expect(toolArgv('test', ['--watch']).slice(1)).toEqual(['test', '--watch']);
    expect(toolArgv('typecheck', []).slice(1)).toEqual([
      'x',
      'tsc',
      '--noEmit',
      '-p',
      'tsconfig.json',
    ]);
  });
});

describe('CLI-008: exit codes pass through', () => {
  test('tsir test returns the same code as running bun test directly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsir-tools-'));
    const originalCwd = process.cwd();
    try {
      process.chdir(dir); // an empty directory: `bun test` finds nothing and fails
      const direct = Bun.spawnSync([process.execPath, 'test'], {
        cwd: dir,
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const wrapped = await runCli(['test']);
      expect(wrapped).toBe(direct.exitCode);
      expect(wrapped).not.toBe(0);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
