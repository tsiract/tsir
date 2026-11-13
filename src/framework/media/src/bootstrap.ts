/**
 * One-call bootstrap for `@tsir/media`.
 */
import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { mediaFromConfig, type ConfiguredMedia } from './config.ts';
import { createMediaManager, type MediaManager } from './media.ts';
import type { MediaAdapter } from './media.ts';

export interface MediaBootstrapOptions {
  /**
   * Adapters this entry built itself. Mutually exclusive with `media`.
   *
   * Kept because a test needs a double, and a double has no name in config.
   */
  readonly adapters?: readonly MediaAdapter[] | undefined;
  /** The `media` block from `tsir.js`. */
  readonly media?: ConfiguredMedia | undefined;
  /** Where `{ fromEnv }` references are read from. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /**
   * Refuse the adapters that cannot store what they produce.
   *
   * A process adapter (`sharp`, `ffmpeg`) transforms a buffer and returns it; on a stateless
   * target the result is dropped. Refused at boot, because "the upload succeeded" and "the upload
   * was thrown away" are the same status code.
   */
  readonly production?: boolean | undefined;
  /** The target named in that refusal, e.g. `cloudflare`. */
  readonly target?: string | undefined;
}

export interface MediaBootstrap {
  readonly manager: MediaManager;
  readonly mediaManagerToken: Token<MediaManager>;
  readonly mediaManagerProvider: Provider<MediaManager>;
}

export function createMediaBootstrap(options: MediaBootstrapOptions): MediaBootstrap {
  if (options.adapters !== undefined && options.media !== undefined) {
    throw new TypeError(
      'pass either `adapters` (instances) or `media` (the tsir.js block), not both — a registry that can be overridden silently is a registry nobody can trust',
    );
  }

  const manager = createMediaManager(
    options.adapters ??
      mediaFromConfig({
        ...(options.media === undefined ? {} : { media: options.media }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.production === undefined ? {} : { production: options.production }),
        ...(options.target === undefined ? {} : { target: options.target }),
      }),
  );
  const mediaManagerToken = token<MediaManager>('mediaManager');
  const mediaManagerProvider = valueProvider(mediaManagerToken, manager);
  return { manager, mediaManagerToken, mediaManagerProvider };
}
