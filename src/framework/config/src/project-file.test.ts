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

describe('broadcast and search sections (CAP-014, CAP-015)', () => {
  test('a project that names a broadcaster and an engine is accepted', () => {
    expect(
      codeOf(() =>
        checkProjectFile({
          app: { name: 'demo', entry: 'src/app.ts' },
          broadcast: {
            default: 'realtime',
            connections: { realtime: { driver: 'durable-object', connection: 'realtime' } },
          },
          search: {
            default: 'catalog',
            engines: {
              catalog: {
                driver: 'typesense',
                host: 'https://x.a1.typesense.net',
                collection: 'products',
                apiKey: { fromEnv: 'TYPESENSE_API_KEY' },
              },
            },
          },
        }),
      ),
    ).toBeUndefined();
  });

  test('a key no driver reads is refused, in the nested entry too', () => {
    // `connection` is the binding name; `connections` is the registry. One letter apart and only
    // one of them is read, which is precisely why the entry keys are listed.
    const lines = unknownProjectKeys({
      broadcast: { connections: { realtime: { connection: 'x', prefixx: 'y' } } },
      search: { engines: { catalog: { driver: 'sqlite', connetcion: 'primary' } } },
    });
    expect(lines).toEqual([
      'broadcast.connections.realtime.prefixx: unknown key (did you mean "prefix"?)',
      'search.engines.catalog.connetcion: unknown key (did you mean "connection"?)',
    ]);
  });

  test('an empty broadcast block is refused rather than silently ignored', () => {
    // A `broadcast: {}` reads as "configured" and resolves to nothing. The registry check is what
    // turns that into a message, and it is the same rule every other registry follows.
    expect(codeOf(() => checkProjectFile({ broadcast: {} }))).toBe('CFG_MISSING_DEFAULT');
  });
});

describe('media section (CAP-017)', () => {
  test('a named adapter per destination is accepted', () => {
    expect(
      codeOf(() =>
        checkProjectFile({
          media: {
            default: 'images',
            adapters: {
              images: {
                driver: 'cloudflare',
                accountId: 'acct',
                apiToken: { fromEnv: 'CF_IMAGES_TOKEN' },
              },
              video: { driver: 'ffmpeg' },
            },
          },
        }),
      ),
    ).toBeUndefined();
  });

  test('a key no adapter reads is refused, in the nested entry too', () => {
    // `uploadPreset` is cloudinary's; `preset` is what somebody would type from memory.
    const lines = unknownProjectKeys({
      media: { adapters: { images: { driver: 'cloudinary', cloudName: 'c', preset: 'p' } } },
    });
    expect(lines).toEqual(['media.adapters.images.preset: unknown key']);
  });

  test('an empty media block is refused rather than resolving to nothing', () => {
    expect(codeOf(() => checkProjectFile({ media: {} }))).toBe('CFG_MISSING_DEFAULT');
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
