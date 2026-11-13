/**
 * Media bootstrap for the admin app.
 *
 * Uses the sharp adapter for local image optimization. In production, swap
 * in `cloudflareAdapter`, `cloudinaryAdapter`, or `imagekitAdapter` based on
 * config.
 */
import { createMediaBootstrap, sharpAdapter } from '@tsir/media';
import { isProduction } from '@tsir/core';

export const media = createMediaBootstrap({
  adapters: [sharpAdapter({ defaultQuality: 80, defaultFormat: 'webp' })],
  // `CAP-007`: `sharp` returns bytes, and a Worker has nowhere to put them. This refuses the
  // production boot rather than letting a route report success and drop the image.
  production: isProduction(),
  target: 'cloudflare',
});
export const mediaManagerToken = media.mediaManagerToken;
export const mediaManagerProvider = media.mediaManagerProvider;
