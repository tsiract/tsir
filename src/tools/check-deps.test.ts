/**
 * The generated dependency table must not depend on the filesystem.
 *
 * `src/docs/dependencies.md` is generated from the framework packages, and `make check` fails when
 * the committed copy and a fresh generation disagree. The "Used by" column comes from the order
 * `readdir` returns, which is *not* the same everywhere — ext4 hands back hash order while APFS
 * hands back creation order — so an unsorted list made the document platform-specific: it matched
 * on macOS and failed on Ubuntu with `src/docs/dependencies.md is stale`, even though nothing about
 * the dependency policy had changed.
 *
 * These tests pin the property directly, so a future edit that drops the sort fails here rather
 * than in CI on one operating system only.
 */

import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');

/** The generator, read as source: `check-deps.ts` runs its checks at import time. */
function source(): string {
  return readFileSync(join(import.meta.dir, 'check-deps.ts'), 'utf8');
}

describe('check-deps generates a platform-independent document', () => {
  test('the framework package list is sorted', () => {
    const text = source();
    const listing = /const packages = \(await readdir\(FRAMEWORK[^;]+;/u.exec(text)?.[0];
    expect(listing).toBeDefined();
    expect(listing).toContain('.sort()');
  });

  test('the rendered importers are sorted', () => {
    // The row template is the only place `importers` reaches the document.
    expect(source()).toContain('[...use.importers].sort().join');
  });

  test('the committed document lists each package once per row, in sorted order', () => {
    const doc = readFileSync(join(ROOT, 'src/docs/dependencies.md'), 'utf8');
    const rows = doc.split('\n').filter((line) => line.startsWith('| `'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const usedBy = row.split('|')[3]?.trim() ?? '';
      const packages = usedBy.split(',').map((name) => name.trim());
      expect(packages).toEqual([...packages].sort());
    }
  });
});
