/**
 * @tsir/media — media processing (image, video, 3rd-party CDNs).
 *
 * ```ts
 * import { createMediaBootstrap, sharpAdapter } from '@tsir/media';
 *
 * const { manager } = createMediaBootstrap({
 *   adapters: [sharpAdapter({ defaultQuality: 80 })],
 * });
 *
 * const out = await manager.process('image', buffer, { width: 800, format: 'webp' });
 * ```
 */

export {
  createMediaManager,
  type MediaAdapter,
  type MediaKind,
  type MediaManager,
  type ProcessOptions,
  type ProcessResult,
} from './media.ts';

export { sharpAdapter, type SharpAdapterOptions } from './adapters/sharp.ts';
export { ffmpegAdapter, type FfmpegAdapterOptions } from './adapters/ffmpeg.ts';
export { cloudflareAdapter, type CloudflareAdapterOptions } from './adapters/cloudflare.ts';
export { cloudinaryAdapter, type CloudinaryAdapterOptions } from './adapters/cloudinary.ts';
export { imagekitAdapter, type ImageKitAdapterOptions } from './adapters/imagekit.ts';

export {
  MEDIA_DRIVERS,
  PERSISTENT_MEDIA_DRIVERS,
  adapterFor,
  mediaFromConfig,
  type ConfiguredMedia,
  type ConfiguredMediaAdapter,
  type EnvRef,
  type MediaBuildOptions,
  type MediaDriverName,
} from './config.ts';
export { createMediaBootstrap } from './bootstrap.ts';
export type { MediaBootstrap, MediaBootstrapOptions } from './bootstrap.ts';
