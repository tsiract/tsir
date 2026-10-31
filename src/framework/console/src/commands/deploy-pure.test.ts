/**
 * Pure parts of `deploy:invoke` and `deploy:validate` output. No project and no registry is
 * loaded, so these run in-process and count toward coverage.
 */

import { describe, expect, test } from 'bun:test';

import { matchesRoutePath } from './deploy.ts';
import { formatValidation, type ValidationReport } from './deploy-validate.ts';

describe('matchesRoutePath', () => {
  test('a literal route matches only itself', () => {
    expect(matchesRoutePath('/api/users', '/api/users')).toBe(true);
    expect(matchesRoutePath('/api/users', '/api/orders')).toBe(false);
  });

  test('a :param segment matches any non-empty segment', () => {
    expect(matchesRoutePath('/users/:id', '/users/42')).toBe(true);
    expect(matchesRoutePath('/users/:id', '/users/')).toBe(false);
  });

  test('a different number of segments never matches', () => {
    expect(matchesRoutePath('/a/:b', '/a')).toBe(false);
    expect(matchesRoutePath('/a', '/a/b')).toBe(false);
  });

  test('trailing slashes are ignored', () => {
    expect(matchesRoutePath('/a/b', '/a/b/')).toBe(true);
  });
});

const artifact = (overrides: Partial<ValidationReport['artifacts'][number]>) => ({
  target: 'bun',
  unit: 'http',
  file: 'bun/server.mjs',
  bytes: 2048,
  gzipBytes: 1024,
  budget: 500_000,
  overBudget: false,
  stale: false,
  missing: false,
  ...overrides,
});

const report = (overrides: Partial<ValidationReport>): ValidationReport => ({
  ok: true,
  outDir: 'build/deploy',
  targets: ['bun'],
  artifacts: [],
  findings: [],
  problems: [],
  warnings: [],
  missingBuild: false,
  secretNames: [],
  scanned: 0,
  ...overrides,
});

describe('formatValidation', () => {
  test('a missing build document tells the user the one command that fixes it', () => {
    const text = formatValidation(report({ missingBuild: true, ok: false }));
    expect(text).toContain('tsir deploy:build');
    expect(text).toContain('build/deploy');
  });

  test('a clean build reports its artifact count', () => {
    const text = formatValidation(report({ artifacts: [artifact({})] }));
    expect(text).toContain('1 artifact(s)');
    expect(text).not.toContain('changed since the build');
  });

  test('a stale, missing, or over-budget artifact is named in the output', () => {
    const text = formatValidation(
      report({
        ok: false,
        artifacts: [
          artifact({ file: 'bun/a.mjs', stale: true }),
          artifact({ file: 'bun/b.mjs', missing: true }),
          artifact({ file: 'bun/c.mjs', overBudget: true }),
        ],
      }),
    );
    expect(text).toContain('bun/a.mjs changed since the build');
    expect(text).toContain('bun/b.mjs is listed');
    expect(text).toContain('bun/c.mjs');
  });
});
