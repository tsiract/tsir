/**
 * The refusal paths of the scaffolding scripts. Each test runs the real script in a scratch
 * directory, so a refusal that writes anything would be visible as a file in that directory.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TOOLS = resolve(import.meta.dir);

function run(script: string, args: readonly string[], cwd: string) {
  return Bun.spawnSync([process.execPath, join(TOOLS, script), ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('changeset refuses a blank summary', () => {
  test('an empty summary exits 1 and writes no changeset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsir-changeset-'));
    try {
      mkdirSync(join(dir, '.changeset'));
      const result = run('version.ts', ['changeset', '', '--bump', 'patch'], dir);

      expect(result.exitCode).toBe(1);
      expect(readdirSync(join(dir, '.changeset'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a summary with no letters or digits is refused the same way', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsir-changeset-'));
    try {
      mkdirSync(join(dir, '.changeset'));

      expect(run('version.ts', ['changeset', '--- ...', '--bump', 'minor'], dir).exitCode).toBe(1);
      expect(readdirSync(join(dir, '.changeset'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('new-package never takes a flag value as the package name', () => {
  test('`--kind framework` with no name is a usage error, and nothing is scaffolded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsir-newpkg-'));
    try {
      const result = run('new-package.ts', ['--kind', 'framework'], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('usage:');
      expect(existsSync(join(dir, 'src'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
