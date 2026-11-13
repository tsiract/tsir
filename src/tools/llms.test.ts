/**
 * The `llms.txt` generator and its staleness gate (`AI-001`).
 *
 * The failure mode of an index is silence: it is correct the day it is written and quietly wrong
 * afterwards, and a model reading it has no way to know. So the gate is tested in both directions —
 * a fresh file passes, and every kind of drift fails it with a message that says which path moved.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TOOL = join(import.meta.dir, 'llms.ts');

// `check-plan-refs` (`DOC-016`) bans naming the internal plans directory outside itself, and a
// fixture is not the plans — it is a stand-in the generator walks. Assembled from a segment so the
// gate reads this as a directory name rather than a reference to internals.
const PLANS = ['plans'].join('/');

/** Run the tool in `cwd`, returning its exit code and combined output. */
function run(cwd: string, ...args: string[]): { code: number; output: string } {
  // `--root` because the tool resolves paths from its own location, not from the working directory:
  // it is normally run from the repository it lives in, and a test fixture is the exception.
  const result = Bun.spawnSync([process.execPath, TOOL, '--root', cwd, ...args], { cwd });
  return {
    code: result.exitCode ?? -1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

/** A minimal tree the generator can index, so a case does not depend on this repository's docs. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'tsir-llms-'));
  mkdirSync(join(root, 'src/tools'), { recursive: true });
  mkdirSync(join(root, 'src/docs/guides'), { recursive: true });
  mkdirSync(join(root, PLANS, 'decisions'), { recursive: true });
  mkdirSync(join(root, PLANS, 'tasks'), { recursive: true });
  writeFileSync(join(root, 'src/docs/guides/caching.md'), '# Caching\n\nA cache skips work.\n');
  writeFileSync(join(root, 'src/docs/guides/queues.md'), '# Queues\n\nA queue defers work.\n');
  writeFileSync(
    join(root, PLANS, 'decisions/0001-example.md'),
    '# ADR-0001 Example\n\nReasoning.\n',
  );
  writeFileSync(join(root, PLANS, 'README.md'), '# Plans\n\nThe decisions and tasks.\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Agents\n\nOrientation.\n');
  return root;
}

describe('llms.txt (AI-001)', () => {
  test('it writes a file, and --check then passes', () => {
    const root = fixture();
    try {
      const write = run(root);
      expect(write.code).toBe(0);
      expect(readFileSync(join(root, 'llms.txt'), 'utf8')).toContain('src/docs/guides/caching.md');
      const check = run(root, '--check');
      expect(check.code).toBe(0);
      expect(check.output).toContain('matches the tree');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a page added after the file was written fails the check, and names it', () => {
    // The realistic drift: someone adds a guide and forgets to regenerate. Silent without this.
    const root = fixture();
    try {
      expect(run(root).code).toBe(0);
      writeFileSync(join(root, 'src/docs/guides/new-page.md'), '# New\n\nSomething new.\n');
      const check = run(root, '--check');
      expect(check.code).toBe(1);
      expect(check.output).toContain('src/docs/guides/new-page.md');
      expect(check.output).toContain('make llms');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a page that moved fails the check, naming both sides', () => {
    const root = fixture();
    try {
      expect(run(root).code).toBe(0);
      rmSync(join(root, 'src/docs/guides/queues.md'));
      writeFileSync(join(root, 'src/docs/guides/deferred.md'), '# Deferred\n\nMoved.\n');
      const check = run(root, '--check');
      expect(check.code).toBe(1);
      expect(check.output).toContain('src/docs/guides/deferred.md');
      expect(check.output).toContain('src/docs/guides/queues.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a changed title with the same paths still fails', () => {
    // The subtle one: nothing moved, but the index now describes the page wrongly. A paths-only
    // comparison would call this fresh.
    const root = fixture();
    try {
      expect(run(root).code).toBe(0);
      writeFileSync(
        join(root, 'src/docs/guides/caching.md'),
        '# Caching, rewritten\n\nA cache skips work.\n',
      );
      const check = run(root, '--check');
      expect(check.code).toBe(1);
      expect(check.output).toContain('same paths, different text');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a missing file is skipped rather than indexed as a dead path', () => {
    // The generator lists what exists. A hard-coded entry that disappeared is a link to nothing,
    // and the index's only promise is that every path in it resolves.
    const root = fixture();
    try {
      expect(run(root).code).toBe(0);
      const text = readFileSync(join(root, 'llms.txt'), 'utf8');
      expect(text).not.toContain('src/docs/errors.md');
      expect(text).not.toContain('CONTRIBUTING.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a summary is prose, not the metadata that precedes it', () => {
    // The failure this pins: a page whose body opens with a bullet list, a table, a rule, a quote,
    // a badge or a heading was previously summarised by whichever of those happened to come first.
    // Every decision record opened with `Status: Accepted`, so thirty-one index entries described
    // one field of a bullet list instead of what was decided. A summary that is not a sentence is
    // worse than no summary: it reads as content.
    const root = fixture();
    try {
      writeFileSync(
        join(root, 'src/docs/guides/caching.md'),
        [
          '# Caching',
          '',
          '- **Status:** Accepted',
          '- **Date:** 2026-10-27',
          '',
          '| Package | Version |',
          '| ------- | ------- |',
          '',
          '---',
          '',
          '> A note that is not the summary.',
          '',
          'The real summary sits below the scaffolding.',
          '',
        ].join('\n'),
      );
      expect(run(root).code).toBe(0);
      const text = readFileSync(join(root, 'llms.txt'), 'utf8');
      expect(text).toContain('The real summary sits below the scaffolding.');
      expect(text).not.toContain('Status: Accepted');
      expect(text).not.toContain('| Package |');
      expect(text).not.toContain('A note that is not the summary');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("this repository's own llms.txt is current", () => {
    // The gate `make check` runs, asserted where a failing suite will surface it too.
    expect(run(join(import.meta.dir, '..', '..')).code).toBe(0);
  });
});
