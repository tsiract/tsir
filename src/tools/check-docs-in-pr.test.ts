import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { checkDocsInPr, docsInPrProblems } from './check-docs-in-pr.ts';

describe('docs-in-pr catches a renamed contract (DOCS-011)', () => {
  const base = {
    config: ['app', 'database'],
    commands: ['dev', 'migrate'],
    errors: ['CFG_INVALID'],
  };
  const current = {
    config: ['app', 'database'],
    commands: ['dev', 'migrate'],
    errors: ['CFG_INVALID'],
  };

  test('a removed command with no documentation change fails', () => {
    const problems = docsInPrProblems(
      ['src/framework/console/src/index.ts', '.changeset/quiet.md'],
      base,
      { ...current, commands: ['dev'] },
    );
    expect(problems.some((problem) => problem.includes('CLI command migrate'))).toBe(true);
  });

  test('the same removal with a documentation change passes', () => {
    const problems = docsInPrProblems(
      ['src/framework/console/src/index.ts', '.changeset/quiet.md', 'src/docs/guides/make.md'],
      base,
      { ...current, commands: ['dev'] },
    );
    expect(problems).toEqual([]);
  });

  test('a removed tsir.js key is named as a key, not as a command', () => {
    const problems = docsInPrProblems(
      ['src/framework/config/src/project-file.ts', '.changeset/quiet.md'],
      base,
      { ...current, config: ['app'] },
    );
    expect(problems.some((problem) => problem.includes('`tsir.js` key database'))).toBe(true);
  });

  test('a removed error code fails even with a documentation change', () => {
    // Append-only: a page changing does not make deleting a code a caller branches on acceptable.
    const problems = docsInPrProblems(['src/docs/errors.md'], base, { ...current, errors: [] });
    expect(problems.some((problem) => problem.includes('append-only'))).toBe(true);
  });
});

describe('docs-in-pr (DXS-012)', () => {
  test('a framework source change with no changeset is a problem', () => {
    expect(docsInPrProblems(['src/framework/cache/src/memory.ts'])).toHaveLength(1);
  });

  test('a changeset satisfies the source rule', () => {
    expect(
      docsInPrProblems(['src/framework/cache/src/memory.ts', '.changeset/quiet-cats.md']),
    ).toEqual([]);
  });

  test('tests, fixtures and docs alone are not framework source', () => {
    expect(
      docsInPrProblems([
        'src/framework/cache/src/memory.test.ts',
        'src/framework/console/src/commands/fixtures/ract-app/src/app.ts',
        'src/docs/errors.md',
      ]),
    ).toEqual([]);
  });

  test('a public surface change needs a doc change', () => {
    expect(docsInPrProblems(['src/docs/api-surface.json'])).toHaveLength(1);
    expect(docsInPrProblems(['src/docs/api-surface.json', 'README.md'])).toEqual([]);
  });
});

describe('docs-in-pr against a real git diff (DXS-012)', () => {
  const git = (cwd: string, args: readonly string[]): void => {
    const result = spawnSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args],
      { cwd, encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };
  const write = (root: string, path: string, body: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tsir-docs-pr-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('a directory that is not a repository is skipped, not passed', () => {
    expect(checkDocsInPr(root, 'main').kind).toBe('skipped');
  });

  test('a missing base is skipped with the base named', () => {
    git(root, ['init', '-q', '-b', 'trunk']);
    write(root, 'README.md', 'x\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'base']);
    const result = checkDocsInPr(root, 'origin/main');
    expect(result).toEqual({ kind: 'skipped', reason: 'base origin/main is not available' });
  });

  test('a framework change on a branch is checked against the base', () => {
    git(root, ['init', '-q', '-b', 'main']);
    write(root, 'src/framework/cache/src/memory.ts', 'export const a = 1;\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'base']);
    git(root, ['checkout', '-q', '-b', 'feature']);
    write(root, 'src/framework/cache/src/memory.ts', 'export const a = 2;\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'change']);

    const bare = checkDocsInPr(root, 'main');
    expect(bare.kind).toBe('checked');
    if (bare.kind === 'checked') expect(bare.problems).toHaveLength(1);

    write(root, '.changeset/quiet-cats.md', "---\n'@tsir/cache': patch\n---\n\nfix\n");
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'changeset']);
    const sane = checkDocsInPr(root, 'main');
    expect(sane.kind).toBe('checked');
    if (sane.kind === 'checked') expect(sane.problems).toEqual([]);
  });
});
