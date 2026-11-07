/**
 * Media bootstrap for the admin app.
 *
 * Uses the sharp adapter for local image optimization. In production, swap
 * in `cloudflareAdapter`, `cloudinaryAdapter`, or `imagekitAdapter` based on
 * config.
 */
import { createMediaBootstrap, sharpAdapter } from '@tsir/media';

export const media = createMediaBootstrap({
  adapters: [sharpAdapter({ defaultQuality: 80, defaultFormat: 'webp' })],
});
export const mediaManagerToken = media.mediaManagerToken;
export const mediaManagerProvider = media.mediaManagerProvider;
