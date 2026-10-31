/**
 * `tsir route:compile` helpers (CTN-014 / RTR-011).
 *
 * The compile itself imports the project entry, which fills a process-wide route registry, so it
 * is exercised by subprocess tests (`openapi`, `deploy`). These are the pure parts it depends on:
 * how an exported schema is named, and which relative imports a controller pulls in.
 */

import { describe, expect, test } from 'bun:test';

import { findExportedName, importSpecifiersOf } from './compile.ts';

describe('findExportedName', () => {
  test('returns the export that holds the value, not a copy of it', () => {
    const schema = { parse: (value: unknown) => value };
    expect(findExportedName({ Other: {}, CreateUser: schema }, schema)).toBe('CreateUser');
  });

  test('an aliased export is named deterministically, whatever the insertion order', () => {
    const value = { id: 1 };
    expect(findExportedName({ Zed: value, Alpha: value }, value)).toBe('Alpha');
    expect(findExportedName({ Alpha: value, Zed: value }, value)).toBe('Alpha');
  });

  test('a value nobody exports is undefined, so the caller can say so', () => {
    expect(findExportedName({ A: 1 }, { a: 1 })).toBeUndefined();
    expect(findExportedName({}, 'anything')).toBeUndefined();
  });
});

describe('importSpecifiersOf', () => {
  test('lists relative imports and re-exports in source order', () => {
    const source = [
      "import { z } from 'zod';",
      "import { Shared } from './schemas/shared.ts';",
      "export { Thing } from '../things/thing.ts';",
      "import type { Row } from './row.ts';",
    ].join('\n');
    expect(importSpecifiersOf(source)).toEqual([
      './schemas/shared.ts',
      '../things/thing.ts',
      './row.ts',
    ]);
  });

  test('bare package specifiers are not relative, so they are not listed', () => {
    expect(importSpecifiersOf("import x from '@tsir/core';\nimport y from 'node:fs';")).toEqual([]);
  });

  test('a source with no imports has no specifiers', () => {
    expect(importSpecifiersOf('export const answer = 42;\n')).toEqual([]);
  });
});
