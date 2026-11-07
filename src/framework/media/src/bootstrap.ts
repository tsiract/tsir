/**
 * One-call bootstrap for `@tsir/media`.
 */
import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { createMediaManager, type MediaManager } from './media.ts';
import type { MediaAdapter } from './media.ts';

export interface MediaBootstrapOptions {
  readonly adapters: readonly MediaAdapter[];
}

export interface MediaBootstrap {
  readonly manager: MediaManager;
  readonly mediaManagerToken: Token<MediaManager>;
  readonly mediaManagerProvider: Provider<MediaManager>;
}

export function createMediaBootstrap(options: MediaBootstrapOptions): MediaBootstrap {
  const manager = createMediaManager(options.adapters);
  const mediaManagerToken = token<MediaManager>('mediaManager');
  const mediaManagerProvider = valueProvider(mediaManagerToken, manager);
  return { manager, mediaManagerToken, mediaManagerProvider };
}
