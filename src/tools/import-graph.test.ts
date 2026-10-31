/**
 * The import-graph helper behind ADR-0022.
 *
 * The parser is a regex by design (see the module comment); these tests pin the shapes
 * it must see, because a missed specifier is a false "this dependency never reaches the
 * root entrypoint" — the one wrong answer that would let a heavy dependency leak into
 * every bundle.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importClosure, importedSpecifiers, packageOf } from './import-graph.ts';

const SCRATCH = mkdtempSync(join(tmpdir(), 'tsir-import-graph-'));

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function file(name: string, source: string): string {
  const path = join(SCRATCH, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, source);
  return path;
}

describe('specifiers', () => {
  test('static, re-export, dynamic and bare imports are all seen', () => {
    const path = file(
      'specifiers/all.ts',
      [
        "import { z } from 'zod';",
        "import type { X } from './x.ts';",
        "export * from './y.ts';",
        "export { a } from '@scope/pkg/deep';",
        "const lazy = await import('./lazy.ts');",
        "import 'node:fs';",
        "import style from './style.css';",
      ].join('\n'),
    );

    expect(importedSpecifiers(path).sort()).toEqual(
      ['./lazy.ts', './style.css', './x.ts', './y.ts', '@scope/pkg/deep', 'node:fs', 'zod'].sort(),
    );
  });

  test('a specifier inside a string is not an import', () => {
    const path = file('specifiers/strings.ts', 'const sql = "select \'from \\"x\\"\'";\n');
    expect(importedSpecifiers(path)).toEqual([]);
  });

  test('package names are trimmed to the package, and relative paths are not packages', () => {
    expect(packageOf('zod')).toBe('zod');
    expect(packageOf('zod/mini')).toBe('zod');
    expect(packageOf('@grpc/grpc-js')).toBe('@grpc/grpc-js');
    expect(packageOf('@grpc/grpc-js/build/src/server')).toBe('@grpc/grpc-js');
    expect(packageOf('./local.ts')).toBeUndefined();
    expect(packageOf('node:fs')).toBeUndefined();
  });
});

describe('closure', () => {
  test('follows relative imports and records which file imports what', () => {
    const entry = file(
      'closure/index.ts',
      ["import { helper } from './helper.ts';", 'export const a = helper;'].join('\n'),
    );
    file('closure/helper.ts', ["import { z } from 'zod';", 'export const helper = z;'].join('\n'));

    const result = importClosure([entry]);

    expect(result.files).toHaveLength(2);
    expect(result.unresolved).toEqual([]);
    expect([...(result.packages.get('zod') ?? [])]).toEqual([
      join(SCRATCH, 'closure', 'helper.ts'),
    ]);
  });

  test('a clean root has no third-party packages at all', () => {
    const entry = file('clean/index.ts', ["export * from './types.ts';"].join('\n'));
    file('clean/types.ts', 'export interface A { readonly id: string }\n');

    expect(importClosure([entry]).packages.size).toBe(0);
  });

  test('a dangling relative import is reported, not skipped', () => {
    const entry = file('dangling/index.ts', ["import './missing.ts';"].join('\n'));

    const result = importClosure([entry]);

    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toContain('missing.ts');
  });

  test('the root entrypoint importing a scoped dependency is exactly what fails the check', () => {
    // The shape ADR-0022 forbids: `@tsir/link`'s root importing the gRPC runtime.
    const entry = file(
      'leak/index.ts',
      ["import { Channel } from '@grpc/grpc-js';", 'export const channel = Channel;'].join('\n'),
    );

    const result = importClosure([entry]);

    expect(result.packages.has('@grpc/grpc-js')).toBe(true);
  });

  test('cycles terminate instead of looping', () => {
    const a = file('cycle/a.ts', ["import './b.ts';"].join('\n'));
    file('cycle/b.ts', ["import './a.ts';"].join('\n'));

    const result = importClosure([a]);
    expect(result.files).toHaveLength(2);
  });
});
