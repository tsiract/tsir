import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../index.ts';
import { toolArgv } from './tools.ts';

describe('application tool wrappers', () => {
  test('use the application scripts rather than repository-only tools', () => {
    expect(toolArgv('test', ['--watch']).slice(1)).toEqual(['test', '--watch']);
    expect(toolArgv('lint', []).slice(1)).toEqual(['run', 'lint']);
    expect(toolArgv('typecheck', []).slice(1)).toEqual(['run', 'typecheck']);
  });

  test('passes through failures and executes project scripts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsir-tools-'));
    const originalCwd = process.cwd();
    try {
      process.chdir(dir);
      writeFileSync(
        'package.json',
        JSON.stringify({ scripts: { lint: 'bun -e "process.exit(7)"' } }),
      );
      expect(await runCli(['lint'])).toBe(7);
      expect(await runCli(['typecheck'])).not.toBe(0);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
