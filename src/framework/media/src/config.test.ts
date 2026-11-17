/**
 * `media.adapter` from `tsir.js` (`CAP-017`).
 *
 * The driver that matters most here is the one that must be *refused*: `sharp` and `ffmpeg`
 * transform a buffer and hand it back, which is a real choice on a server with a disk and a lost
 * upload on a Worker. A test that only checked "it builds an adapter" would pass on the version
 * that shipped the bug.
 */
import { describe, expect, test } from 'bun:test';

import { adapterFor, mediaFromConfig, MEDIA_DRIVERS, PERSISTENT_MEDIA_DRIVERS } from './config.ts';
import type { ConfiguredMedia } from './config.ts';

/** The error as a person reads it: message plus hint (`format()`), which is where the list lives. */
function rendered(fn: () => unknown): string {
  try {
    fn();
    return '(no error)';
  } catch (error: unknown) {
    const shape = error as { format?: () => string };
    return typeof shape.format === 'function' ? shape.format() : String(error);
  }
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error: unknown) {
    return (error as { code?: string }).code ?? 'NOT_TSIR';
  }
}

describe('media registry', () => {
  test('every shipped adapter is a name tsir.js can use', () => {
    for (const driver of MEDIA_DRIVERS) {
      const media: ConfiguredMedia = {
        adapters: {
          main: {
            driver,
            accountId: 'acct',
            apiToken: { fromEnv: 'CF_IMAGES_TOKEN' },
            cloudName: 'shop',
            uploadPreset: 'unsigned_default',
            publicKey: 'pk',
            privateKey: { fromEnv: 'IMAGEKIT_PRIVATE' },
            urlEndpoint: 'https://ik.imagekit.io/shop',
          },
        },
      };
      const adapters = mediaFromConfig({
        media,
        env: { CF_IMAGES_TOKEN: 't', IMAGEKIT_PRIVATE: 'p' },
      });
      expect(adapters[0]?.name).toBe(driver);
    }
  });

  test('an unknown adapter name lists the ones this build ships', () => {
    const media: ConfiguredMedia = { adapters: { main: { driver: 'imgix' } } };
    // The list is in the hint, which is what `format()` renders. Asserting on the message alone
    // would let a hintless error pass, and the hint is the whole value of this refusal.
    const shown = rendered(() => mediaFromConfig({ media }));
    expect(shown).toMatch(/imgix/u);
    for (const driver of MEDIA_DRIVERS) expect(shown).toContain(driver);
    expect(codeOf(() => mediaFromConfig({ media }))).toBe('CAP_DRIVER_MISSING');
  });

  test('a missing service value fails at build, not on the first upload', () => {
    // A `cloudflare` adapter built with an undefined token authenticates as nothing and answers
    // 401 from inside a request — the failure this file exists to move to boot.
    const media: ConfiguredMedia = { adapters: { images: { driver: 'cloudflare' } } };
    expect(codeOf(() => mediaFromConfig({ media }))).toBe('CAP_DRIVER_MISSING');
  });

  test('an unset { fromEnv } names the variable that was empty', () => {
    const media: ConfiguredMedia = {
      adapters: {
        images: { driver: 'cloudflare', accountId: 'acct', apiToken: { fromEnv: 'CF_TOKEN' } },
      },
    };
    let caught: unknown;
    try {
      mediaFromConfig({ media, env: {} });
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(String(caught)).toContain('CF_TOKEN');
  });

  test('a service adapter is accepted in production', () => {
    // The three services store the asset, so the guard has nothing to say about them.
    for (const driver of PERSISTENT_MEDIA_DRIVERS) {
      expect(() =>
        adapterFor('main', {
          driver,
          accountId: 'a',
          apiToken: 't',
          cloudName: 'c',
          uploadPreset: 'p',
          publicKey: 'k',
          privateKey: 's',
          urlEndpoint: 'https://x',
        }),
      ).not.toThrow();
    }
  });

  test('the process adapters are refused in production, by target', () => {
    // `sharp` and `ffmpeg` return bytes. On a Worker nobody writes them anywhere; the route
    // reports success and the image is gone.
    for (const driver of ['sharp', 'ffmpeg']) {
      const media: ConfiguredMedia = { adapters: { main: { driver } } };
      expect(codeOf(() => mediaFromConfig({ media, production: true, target: 'cloudflare' }))).toBe(
        'CAP_FORBIDDEN_IN_PRODUCTION',
      );
    }
  });

  test('the same process adapters are allowed in development', () => {
    for (const driver of ['sharp', 'ffmpeg']) {
      const media: ConfiguredMedia = { adapters: { main: { driver } } };
      expect(() => mediaFromConfig({ media })).not.toThrow();
    }
  });

  test('a declared default that names no adapter is refused with the declared list', () => {
    const media: ConfiguredMedia = { default: 'video', adapters: { images: { driver: 'sharp' } } };
    const shown = rendered(() => mediaFromConfig({ media }));
    expect(shown).toMatch(/video/u);
    expect(shown).toContain('images');
  });

  test('an empty adapters map is refused rather than building nothing', () => {
    expect(codeOf(() => mediaFromConfig({ media: { adapters: {} } }))).toBe('MEDIA_NO_ADAPTER');
  });

  test('no media block is no adapters, and that is not an error', () => {
    // A project that does not process media should not have to declare anything, and an empty
    // manager answers the same "no adapter for image" an empty config would.
    expect(mediaFromConfig({})).toEqual([]);
  });

  test('declaration order is kept, because it decides the default per kind', () => {
    const media: ConfiguredMedia = {
      adapters: {
        video: { driver: 'ffmpeg' },
        images: { driver: 'sharp' },
      },
    };
    expect(mediaFromConfig({ media }).map((adapter) => adapter.name)).toEqual(['ffmpeg', 'sharp']);
  });
});
