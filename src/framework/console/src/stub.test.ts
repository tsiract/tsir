import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { STUBS } from './stub-text.ts';
import { renderStub, stubContents } from './stub.ts';

const STUBS_DIR = join(import.meta.dir, 'stubs');

/** Every `.slug` on disk, keyed the way `renderStub()` is called. */
function stubsOnDisk(dir: string = STUBS_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...stubsOnDisk(path));
    else if (entry.name.endsWith('.slug.txt')) {
      // `new/app.ts.slug.txt` → `new/app.ts`, which is the key `renderStub('new/app.ts')` uses.
      const key = relative(STUBS_DIR, path).split('\\').join('/');
      found.push(key.slice(0, -'.txt'.length));
    }
  }
  return found.sort();
}

describe('console · stubs reach a compiled CLI', () => {
  test('every stub on disk is in the bundle map', () => {
    // The whole point: `bun build --compile` has no `stubs/` directory to read, so a `.slug` file
    // missing from the map works in a source run and fails in the executable — `tsir new` was the
    // first command a developer ran, and it printed ENOENT into `/$bunfs`.
    expect([...STUBS.keys()].sort()).toEqual(stubsOnDisk());
  });

  test('the map holds the file that is on disk, byte for byte', () => {
    for (const [key, bundled] of STUBS)
      expect(bundled).toBe(stubContents(key.replace(/\.slug$/u, '')));
  });

  test('an unknown stub fails with a code, not a bare ENOENT', () => {
    expect(() => renderStub('nope/not-a-stub.ts')).toThrow(/not shipped with this build/u);
  });

  test('rendering still substitutes and still refuses a missing variable', () => {
    expect(renderStub('new/config/app.ts', { name: 'shop-api' })).toContain('shop-api');
    expect(() => renderStub('new/config/app.ts', {})).toThrow(/missing variable/u);
  });
});
