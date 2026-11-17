/**
 * `media.adapter` in `tsir.js` — the registry half of `@tsir/media` (`CAP-017`, `CAP-006`).
 *
 * The package shipped five adapters and no way to name one from a file, so every app built them
 * in its entry module: `tsir doctor` could not report which one production used, and — the part
 * that matters — the production guard had nowhere to live. `sharp` was therefore a selectable
 * "production" adapter on Lambda and on Workers, where it writes bytes to a process that will not
 * exist on the next request.
 *
 * ## Two kinds of adapter, and the config has to know which
 *
 * `cloudflare`, `cloudinary` and `imagekit` are **services**: they upload, they answer a URL, and
 * the asset outlives the request. `sharp` and `ffmpeg` are **processes**: they transform a buffer
 * and hand it back. On a long-lived server with a disk that is a legitimate choice; on a
 * stateless target the caller has nowhere to put the result, and the upload is lost.
 *
 * So `production: true` refuses the two process adapters. That is the same rule `mail` applies to
 * `log` and `broadcast` applies to `memory`, and it is a refusal rather than a warning because the
 * failure is silent: a route returns 200 and the image is gone.
 *
 * ## Several adapters, one per kind
 *
 * A project usually wants images at one service and video at another — Cloudflare Stream compresses
 * video and does nothing for a JPEG pipeline. `adapters` is therefore a named map, each entry with
 * its own driver, and `createMediaManager` already resolves one adapter per `kind`. The first
 * declared adapter of each kind is the default, which is why ordering in the file is meaningful
 * and why the error names the kind rather than "no adapter".
 */

import { TsirError } from '@tsir/container';

import { cloudflareAdapter } from './adapters/cloudflare.ts';
import { cloudinaryAdapter } from './adapters/cloudinary.ts';
import { ffmpegAdapter } from './adapters/ffmpeg.ts';
import { imagekitAdapter } from './adapters/imagekit.ts';
import { sharpAdapter } from './adapters/sharp.ts';
import { driverMissing, forbiddenInProduction } from './errors.ts';
import type { MediaAdapter } from './media.ts';

/** Every adapter this build ships, in the order an error message lists them. */
export const MEDIA_DRIVERS = ['cloudflare', 'cloudinary', 'imagekit', 'sharp', 'ffmpeg'] as const;

export type MediaDriverName = (typeof MEDIA_DRIVERS)[number];

/**
 * The adapters that store what they produce.
 *
 * Everything else transforms a buffer and returns it. The distinction is what the production
 * guard reads — not a per-adapter flag, because the same adapter is a fine choice on a server and
 * a lost write on a Worker, so the *target* is the other half of the question.
 */
export const PERSISTENT_MEDIA_DRIVERS: readonly string[] = ['cloudflare', 'cloudinary', 'imagekit'];

/** A string, or a reference to one in the environment — the rule every secret follows. */
export type EnvRef = string | { readonly fromEnv: string };

/** One `media.adapters.<name>` entry, as configuration sees it. */
export interface ConfiguredMediaAdapter {
  /**
   * As written in `tsir.js`. Typed `string`, not `MediaDriverName`: an unknown name must fail with
   * a coded error listing what this build ships (the rule every registry here follows).
   */
  readonly driver: string;
  /** `cloudflare` only: the account the Images and Stream products live in. */
  readonly accountId?: string | undefined;
  /** The key or preset the service accepts, always through `{ fromEnv }`. */
  readonly apiToken?: EnvRef | undefined;
  /** `cloudinary`: the cloud's name. */
  readonly cloudName?: string | undefined;
  /** `cloudinary`: the unsigned upload preset. */
  readonly uploadPreset?: string | undefined;
  /** `imagekit`: the public key and the delivery endpoint. */
  readonly publicKey?: string | undefined;
  /** `imagekit`: the private key, through `{ fromEnv }`. */
  readonly privateKey?: EnvRef | undefined;
  /** `imagekit`: the CDN base URL. */
  readonly urlEndpoint?: string | undefined;
  /** `cloudflare`: the variant used when a request names no dimensions. */
  readonly imageVariant?: string | undefined;
  /** `sharp`: default output format. */
  readonly defaultFormat?: string | undefined;
  /** `sharp` / `ffmpeg`: default quality. */
  readonly defaultQuality?: number | undefined;
  /** `ffmpeg`: the binary. */
  readonly ffmpegPath?: string | undefined;
}

/** One `media` block, as configuration sees it. */
export interface ConfiguredMedia {
  /** The adapter used when a call does not name one. Must be a key of `adapters`. */
  readonly default?: string | undefined;
  readonly adapters: Readonly<Record<string, ConfiguredMediaAdapter>>;
}

/** What `mediaFromConfig` needs that config cannot carry. */
export interface MediaBuildOptions {
  /** The `media` block, or nothing. */
  readonly media?: ConfiguredMedia | undefined;
  /** Where `{ fromEnv }` references are read from. Defaults to `process.env` when available. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Refuse the process adapters, which cannot store what they produce. */
  readonly production?: boolean | undefined;
  /** The target name used in the refusal message, e.g. `cloudflare`. */
  readonly target?: string | undefined;
}

function resolveRef(
  ref: EnvRef | undefined,
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  adapter: string,
): string | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === 'string') return ref;
  const value = env[ref.fromEnv];
  if (value === undefined || value === '') {
    throw new TsirError(
      'CAP_DRIVER_MISSING',
      `media adapter "${adapter}" reads ${key} from ${ref.fromEnv}, which is not set`,
      {
        kind: 'capability',
        hint: `set ${ref.fromEnv} — a value that changes per environment never belongs in tsir.js`,
        context: { adapter, key, variable: ref.fromEnv },
      },
    );
  }
  return value;
}

function required(value: string | undefined, key: string, adapter: string): string {
  if (value === undefined || value === '') {
    throw new TsirError('CAP_DRIVER_MISSING', `media adapter "${adapter}" needs \`${key}\``, {
      kind: 'capability',
      hint: `add \`${key}\` to that adapter's entry — see tsir docs media`,
      context: { adapter, key },
    });
  }
  return value;
}

/**
 * Build one adapter from its entry.
 *
 * The per-driver requirements are checked here rather than in each adapter, because an adapter
 * constructed with `undefined` for its token would authenticate as nothing and answer 401 from
 * inside a request — the failure shape this whole file exists to move to boot.
 */
export function adapterFor(
  name: string,
  config: ConfiguredMediaAdapter,
  env: Readonly<Record<string, string | undefined>> = {},
): MediaAdapter {
  switch (config.driver) {
    case 'cloudflare':
      return cloudflareAdapter({
        accountId: required(config.accountId, 'accountId', name),
        apiToken: required(resolveRef(config.apiToken, env, 'apiToken', name), 'apiToken', name),
        ...(config.imageVariant === undefined ? {} : { imageVariant: config.imageVariant }),
      });
    case 'cloudinary':
      return cloudinaryAdapter({
        cloudName: required(config.cloudName, 'cloudName', name),
        uploadPreset: required(config.uploadPreset, 'uploadPreset', name),
      });
    case 'imagekit':
      return imagekitAdapter({
        publicKey: required(config.publicKey, 'publicKey', name),
        privateKey: required(
          resolveRef(config.privateKey, env, 'privateKey', name),
          'privateKey',
          name,
        ),
        urlEndpoint: required(config.urlEndpoint, 'urlEndpoint', name),
      });
    case 'sharp':
      return sharpAdapter({
        ...(config.defaultFormat === undefined ? {} : { defaultFormat: config.defaultFormat }),
        ...(config.defaultQuality === undefined ? {} : { defaultQuality: config.defaultQuality }),
      });
    case 'ffmpeg':
      return ffmpegAdapter({
        ...(config.ffmpegPath === undefined ? {} : { ffmpegPath: config.ffmpegPath }),
      });
    default:
      // The unknown name reached here, so the list is the hint rather than a type error nobody
      // could have written.
      throw driverMissing(config.driver, MEDIA_DRIVERS);
  }
}

/**
 * Build every adapter from `tsir.js`.
 *
 * Returns them in declaration order, which is what decides the default adapter per kind:
 * `createMediaManager` keeps the first one it sees for each `MediaKind`.
 */
export function mediaFromConfig(options: MediaBuildOptions): readonly MediaAdapter[] {
  const media = options.media;
  if (media === undefined) return [];

  const entries = Object.entries(media.adapters);
  if (entries.length === 0) {
    throw new TsirError('MEDIA_NO_ADAPTER', 'media is declared but `adapters` is empty', {
      kind: 'capability',
      hint: `declare at least one, e.g. \`adapters: { images: { driver: 'cloudflare' } }\` — this build ships: ${MEDIA_DRIVERS.join(', ')}`,
      context: { adapters: 0 },
    });
  }
  if (media.default !== undefined && !Object.hasOwn(media.adapters, media.default)) {
    throw new TsirError(
      'CAP_DRIVER_MISSING',
      `media.default names "${media.default}", which is not one of the declared adapters`,
      {
        kind: 'capability',
        hint: `declared: ${entries.map(([name]) => name).join(', ')}`,
        context: { default: media.default },
      },
    );
  }

  return entries.map(([name, entry]) => {
    const persistent = PERSISTENT_MEDIA_DRIVERS.includes(entry.driver);
    if (options.production === true && !persistent) {
      throw forbiddenInProduction(entry.driver, options.target ?? 'this target');
    }
    return adapterFor(name, entry, options.env ?? {});
  });
}
