import { describe, expect, test } from 'bun:test';
import { TsirError } from '@tsir/container';

import {
  checkNamedRegistry,
  checkProjectFile,
  suggestKey,
  unknownProjectKeys,
} from './project-file.ts';

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof TsirError ? error.code : 'NOT_TSIR';
  }
}

describe('unknown keys (CFG_UNKNOWN_KEY)', () => {
  test('a clean documented file passes', () => {
    expect(
      codeOf(() =>
        checkProjectFile({
          app: { name: 'demo', entry: 'src/app.ts' },
          database: { default: 'primary', connections: { primary: { driver: 'postgres' } } },
          presets: ['minimal'],
        }),
      ),
    ).toBeUndefined();
  });

  test('a near-miss top-level key is refused with a suggestion', () => {
    const lines = unknownProjectKeys({ databse: {} });
    expect(lines).toEqual(['databse: unknown key (did you mean "database"?)']);
    expect(codeOf(() => checkProjectFile({ databse: {} }))).toBe('CFG_UNKNOWN_KEY');
  });

  test('nested keys are checked inside app, console, and connection entries', () => {
    const lines = unknownProjectKeys({
      app: { nmae: 'x' },
      database: { connections: { primary: { drvier: 'postgres' } } },
    });
    expect(lines).toContain('app.nmae: unknown key (did you mean "name"?)');
    expect(lines.some((line) => line.startsWith('database.connections.primary.drvier'))).toBe(true);
  });

  test('strict: false allows unknown keys', () => {
    expect(codeOf(() => checkProjectFile({ strict: false, whatever: 1 }))).toBeUndefined();
  });

  test('suggestKey ignores far-away names', () => {
    expect(suggestKey('zzzzzz', ['database', 'cache'])).toBeUndefined();
    expect(suggestKey('cahce', ['database', 'cache'])).toBe('cache');
  });
});

describe('registries (CFG_MISSING_DEFAULT, CFG_UNKNOWN_DEFAULT, CFG_AMBIGUOUS_CONNECTION)', () => {
  test('a registry with no default is refused, and the hint lists the names', () => {
    let caught: unknown;
    try {
      checkNamedRegistry({ section: 'database', entries: { primary: {}, analytics: {} } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TsirError);
    if (caught instanceof TsirError) {
      expect(caught.code).toBe('CFG_MISSING_DEFAULT');
      expect(caught.hint).toContain('primary, analytics');
    }
  });

  test('a default that is not declared is refused', () => {
    expect(
      codeOf(() =>
        checkNamedRegistry({ section: 'database', default: 'nope', entries: { primary: {} } }),
      ),
    ).toBe('CFG_UNKNOWN_DEFAULT');
  });

  test('a connection with both a binding and a url is ambiguous', () => {
    expect(
      codeOf(() =>
        checkNamedRegistry({
          section: 'database',
          default: 'primary',
          entries: { primary: { binding: 'DB', url: { fromEnv: 'X' } } },
        }),
      ),
    ).toBe('CFG_AMBIGUOUS_CONNECTION');
  });

  test('a valid registry passes', () => {
    expect(
      codeOf(() =>
        checkNamedRegistry({
          section: 'database',
          default: 'primary',
          entries: { primary: { binding: 'DB' }, analytics: { url: { fromEnv: 'X' } } },
        }),
      ),
    ).toBeUndefined();
  });
});

describe('format 1 (CFG_CONFIG_VERSION_STALE)', () => {
  test('the flat database block is refused and points at the migration', () => {
    let caught: unknown;
    try {
      checkProjectFile({ database: { driver: 'postgres', url: { fromEnv: 'DATABASE_URL' } } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TsirError);
    if (caught instanceof TsirError) {
      expect(caught.code).toBe('CFG_CONFIG_VERSION_STALE');
      expect(caught.hint).toContain('--migrate-config');
    }
  });
});
