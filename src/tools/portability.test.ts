import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilerDiagnostics } from './dist.ts';

const root = process.cwd();

describe('portable development tools', () => {
  test('TypeScript diagnostics from stdout are not lost', () => {
    expect(compilerDiagnostics('error TS1234\n', '', 2)).toBe('error TS1234\n');
    expect(compilerDiagnostics('', 'cannot execute\n', 1)).toBe('cannot execute\n');
    expect(compilerDiagnostics('', '', 2)).toContain('exit 2');
  });

  test('owned-process cleanup handles empty and stale records without touching other processes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsir kill '));
    try {
      mkdirSync(join(dir, '.tsir'));
      const run = () =>
        Bun.spawnSync(['/bin/bash', join(root, 'src/tools/kill-dev.sh')], {
          cwd: root,
          env: { ...process.env, TSIR_ROOT: dir },
          stdout: 'pipe',
          stderr: 'pipe',
        });
      expect(run().exitCode).toBe(0);
      // This is our own live process but not a dev server: it must not be signalled.
      writeFileSync(join(dir, '.tsir/dev.pids'), `${String(process.pid)}\t\t\n`);
      const result = run();
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('not a Tsir dev server');
      expect(() => process.kill(process.pid, 0)).not.toThrow();
      // A changed start label must prevent signalling even before the command check.
      writeFileSync(
        join(dir, '.tsir/dev.pids'),
        `${String(process.pid)}\t0\tdefinitely-not-its-start-time\n`,
      );
      const reused = run();
      expect(reused.exitCode).toBe(0);
      expect(reused.stdout.toString()).toContain('was reused by another process');
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cleanup avoids Bash 4-only associative arrays', () => {
    const script = readFileSync(join(root, 'src/tools/kill-dev.sh'), 'utf8');
    expect(script).not.toContain('declare -A');
  });
});
