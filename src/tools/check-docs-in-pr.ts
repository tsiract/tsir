/**
 * Docs-in-PR, run locally (`DXS-012`): a branch that changes what the framework does must say so.
 *
 *   · a change under `src/framework/*\/src` (not a test) needs a changeset in `.changeset/`;
 *   · a change to the public surface (`src/docs/api-surface.json`) needs a doc change as well,
 *     under `src/docs/` or a `README.md`;
 *   · a branch that renames a `tsir.js` key, a CLI command or an error code needs a doc change too
 *     (`DOCS-011`). The names come from `src/docs/contracts.json`, and which ones disappeared is
 *     read from the diff of that file — the same mechanism `check-contracts.ts` uses locally, with
 *     the change list available so it can ask whether a document moved.
 *
 * The base is `DOCS_BASE`, or `origin/main`. Without git history, or without that base, the check
 * **skips with a note** rather than passing silently: the rule cannot be checked without a diff.
 *
 * Usage: bun src/tools/check-docs-in-pr.ts
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Contracts } from './check-contracts.ts';
import { contractProblems, currentContracts, readSnapshot } from './check-contracts.ts';

const ROOT = resolve(import.meta.dir, '..', '..');

/**
 * The rule, as a pure function of the changed paths and the two snapshots.
 *
 * `before` is `src/docs/contracts.json` **at the base commit**, not the working tree: a branch that
 * renames a command and forgets to run `--write` leaves the working snapshot identical to the base,
 * so comparing the file to itself would find nothing. `after` defaults to the current contracts.
 */
export function docsInPrProblems(
  changed: readonly string[],
  before: Contracts = readSnapshot(),
  after: Contracts = currentContracts(),
): string[] {
  const problems: string[] = [];
  const frameworkSource = changed.filter(
    (path) =>
      /^src\/framework\/[^/]+\/src\//u.test(path) &&
      !/\.test\.ts$/u.test(path) &&
      !path.includes('/fixtures/'),
  );
  const hasChangeset = changed.some((path) => /^\.changeset\/[^/]+\.md$/u.test(path));
  if (frameworkSource.length > 0 && !hasChangeset) {
    problems.push(
      `${String(frameworkSource.length)} framework source file(s) changed with no changeset (run make changeset SUMMARY=\"...\")`,
    );
  }
  // A contract rename (`DOCS-011`): the names are the ones in the base commit's snapshot, the
  // current ones are in the code. A removal is acceptable only alongside a document change.
  for (const problem of contractProblems(before, after, changed)) {
    problems.push(problem.message);
  }

  const surface = changed.includes('src/docs/api-surface.json');
  // The surface file is generated from the code: it does not count as the doc that explains a change.
  const hasDocs = changed.some(
    (path) =>
      path !== 'src/docs/api-surface.json' && (/^src\/docs\//u.test(path) || path === 'README.md'),
  );
  if (surface && !hasDocs) {
    problems.push('the public surface changed (src/docs/api-surface.json) with no doc change');
  }
  return problems;
}

export type DocsInPrResult =
  | { readonly kind: 'skipped'; readonly reason: string }
  | {
      readonly kind: 'checked';
      readonly base: string;
      readonly changed: number;
      readonly problems: readonly string[];
    };

function gitLines(root: string, args: readonly string[]): string[] | undefined {
  const result = spawnSync('git', [...args], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  return result.stdout.split('\n').filter((line) => line.length > 0);
}

/** Runs the rule against `base...HEAD` in the git repository at `root`. Skips when there is none. */
export function checkDocsInPr(root: string, base: string): DocsInPrResult {
  if (gitLines(root, ['rev-parse', '--is-inside-work-tree']) === undefined) {
    return { kind: 'skipped', reason: 'not a git repository, so nothing can be diffed' };
  }
  const changed = gitLines(root, ['diff', '--name-only', `${base}...HEAD`]);
  if (changed === undefined) {
    return { kind: 'skipped', reason: `base ${base} is not available` };
  }
  // The snapshot at the base commit, through git: a branch that renames a name and does not run
  // `--write` leaves the working file identical, and comparing it to itself finds nothing.
  const atBase = gitLines(root, ['show', `${base}:src/docs/contracts.json`]);
  const before =
    atBase === undefined ? readSnapshot() : (JSON.parse(atBase.join('\n')) as Contracts);
  return {
    kind: 'checked',
    base,
    changed: changed.length,
    problems: docsInPrProblems(changed, before),
  };
}

function main(): number {
  const base = process.env['DOCS_BASE'] ?? 'origin/main';
  const result = checkDocsInPr(ROOT, base);
  if (result.kind === 'skipped') {
    console.log(`  \x1b[2mdocs-in-pr skipped: ${result.reason}\x1b[0m`);
    return 0;
  }
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(`  ✗ docs-in-pr: ${problem}`);
    return 1;
  }
  console.log(`  ✓ docs-in-pr: ${String(result.changed)} changed file(s) are sane against ${base}`);
  return 0;
}

if (import.meta.main) process.exitCode = main();
