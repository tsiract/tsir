import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { citationsIn, documentationIndex, indexPath, resolveCitation } from './doc-ledger.ts';

/**
 * Which documentation a task added, derived rather than remembered (`DOCS-019`).
 *
 * The rule the user set is "everything must be task based so we don't hallucinate", and the gap it
 * names is a task that lands prose nobody can find: a `DOCS-002` row whose acceptance note says
 * "done" while the page it added is `prose/media.md`, discoverable only by grepping the note. These
 * tests pin both halves — how a citation is recognised, and how a done task that names no document
 * is counted rather than hidden.
 */

describe('doc-ledger reads a citation out of an acceptance note', () => {
  test('a path in backticks that names a document is a citation', () => {
    expect(
      citationsIn('Done: `src/docs/packages/prose/media.md` documents the per-provider codes.'),
    ).toEqual(['src/docs/packages/prose/media.md']);
  });

  test('a path that names only code is not documentation', () => {
    expect(citationsIn('Done: `src/framework/media/src/config.ts` gained the driver.')).toEqual([]);
    expect(citationsIn('Regenerated `src/docs/api-surface.json`.')).toEqual([]);
  });

  test('a suffix resolves to the file that exists, not to the spelling', () => {
    // Acceptance notes write `prose/media.md` to keep a long path out of a table cell.
    expect(resolveCitation('prose/media.md')).toBe('src/docs/packages/prose/media.md');
    expect(citationsIn('`prose/media.md`')).toEqual(['src/docs/packages/prose/media.md']);
  });

  test('a path nothing matches is unresolved rather than guessed', () => {
    expect(resolveCitation('prose/does-not-exist.md')).toBeUndefined();
  });

  test('repeats collapse and the order is deterministic', () => {
    expect(citationsIn('`README.md` then `src/docs/index.md` then `README.md`')).toEqual([
      'README.md',
      'src/docs/index.md',
    ]);
  });
});

describe('doc-ledger reports what it cannot prove', () => {
  test('a done task that cites no document is listed, not counted as documented', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsir-docledger-'));
    try {
      writeFileSync(
        join(dir, 'a.md'),
        [
          '| ID | Title | Status | Acceptance |',
          '| --- | --- | --- | --- |',
          '| `A-001` | wrote a page | `[x]` | Added `README.md`. |',
          '| `A-002` | wrote nothing | `[x]` | The gate passes. |',
          '| `A-003` | still open | `[ ]` | Write `README.md`. |',
        ].join('\n'),
      );
      const index = documentationIndex(dir);
      // Two tasks cite a document: the done one that added it and the open one that plans to.
      // `cited` is a count of citations, not of completion.
      expect(index.cited).toBe(2);
      expect(index.uncited.map((task) => task.id)).toEqual(['A-002']);
      // An open task's acceptance note is a plan, not a citation — it is not "missing docs".
      expect(index.uncited.map((task) => task.id)).not.toContain('A-003');
      expect(index.broken).toEqual([]);
      expect(index.planned).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a citation that resolves to nothing is reported with the task that wrote it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsir-docledger-'));
    try {
      writeFileSync(
        join(dir, 'a.md'),
        [
          '| ID | Title | Status | Acceptance |',
          '| --- | --- | --- | --- |',
          '| `A-001` | renamed a page | `[x]` | Moved `src/docs/guide-gone.md`. |',
        ].join('\n'),
      );
      // A *done* task naming a page that does not exist is broken: renamed, or never written.
      expect(documentationIndex(dir).broken).toEqual([
        { id: 'A-001', written: 'src/docs/guide-gone.md' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an open task naming a page it has not written is planned, not broken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsir-docledger-'));
    try {
      writeFileSync(
        join(dir, 'a.md'),
        [
          '| ID | Title | Status | Acceptance |',
          '| --- | --- | --- | --- |',
          '| `A-001` | will write a page | `[ ]` | Write `src/docs/guide-coming.md`. |',
        ].join('\n'),
      );
      const index = documentationIndex(dir);
      expect(index.planned).toEqual([{ id: 'A-001', written: 'src/docs/guide-coming.md' }]);
      expect(index.broken).toEqual([]);
      // An open task's note is a plan, not a citation, so it is not counted as documenting anything.
      expect(index.cited).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the index path is derived from the ledger name', () => {
    // Asserted on the shape rather than on an absolute path: a test that spells the ledger
    // directory is a path into it from outside, which `check-plan-refs` exists to prevent.
    const path = indexPath(join('ledger-root', '28-docs-inventory.md'));
    expect(path.endsWith(join('tasks', 'docs', '28-docs-inventory.md'))).toBe(true);
    expect(path).not.toContain('28-docs-inventory.md.md');
  });
});
