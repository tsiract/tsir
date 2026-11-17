/**
 * `proto-check` must not pass without checking anything when it is required to check.
 *
 * The check regenerates the committed gRPC contracts and diffs them. Skipping when `buf` is absent
 * is right on a laptop, but it used to be right in CI too — no workflow installed `buf`, so the
 * "contracts are current" line was never printed by a runner and nobody noticed. `REQUIRE_BUF`
 * closes that: the skip becomes a failure. These tests pin both halves, so the flag cannot quietly
 * stop working (a skip that silently returns 0 is indistinguishable from a passing check).
 */

import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const TOOL = join(ROOT, 'src', 'tools', 'check-proto.ts');

function runCheck(env: Record<string, string | undefined>): {
  readonly code: number;
  readonly output: string;
} {
  const result = spawnSync(process.execPath, [TOOL], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Point BUF at a path that cannot exist, so `findBuf` falls through to the PATH probe
      // deterministically regardless of what the machine has installed.
      BUF: '/nonexistent/buf-that-is-not-installed',
      ...env,
    },
  });
  return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

describe('check-proto', () => {
  test('documents the requirement instead of claiming CI installs buf implicitly', () => {
    const source = readFileSync(TOOL, 'utf8');
    expect(source).toContain('REQUIRE_BUF');
    // The old header promised "CI installs it" while no workflow did.
    expect(source).not.toContain('CI installs it; the committed contracts are unchanged');
  });

  test('a missing buf skips without failing when it is not required', () => {
    const { code, output } = runCheck({ REQUIRE_BUF: undefined });
    // Either buf is genuinely absent (skip) or it is present and the contracts verify; both are
    // acceptable here. What must not happen is a failure on a machine that never asked for one.
    if (output.includes('not checked')) {
      expect(code).toBe(0);
      expect(output).toContain('REQUIRE_BUF');
    }
  });

  test('a missing buf fails when it is required', () => {
    const { code, output } = runCheck({ REQUIRE_BUF: '1' });
    // If the machine does have buf, the check runs for real and must still succeed.
    if (output.includes('not checked')) {
      expect(code).toBe(1);
      expect(output).toContain('required here');
    } else {
      expect(code).toBe(0);
    }
  });
});
