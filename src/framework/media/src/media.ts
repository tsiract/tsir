/**
 * @tsir/media — media processing abstractions.
 *
 * A `MediaProcessor` takes an input buffer + options and returns a processed
 * buffer (and metadata). Adapters implement the `MediaAdapter` interface:
 *
 *   · `sharpAdapter`      — local image optimization via `sharp`
 *   · `ffmpegAdapter`     — local video transcoding via `ffmpeg`
 *   · `cloudflareAdapter` — Cloudflare Images + Stream
 *   · `cloudinaryAdapter` — Cloudinary upload + transform
 *   · `imagekitAdapter`   — ImageKit upload + transform
 *
 * The manager picks an adapter by kind (image/video) or by explicit name.
 */

import { noAdapter } from './errors.ts';

export type MediaKind = 'image' | 'video';

export interface ProcessOptions {
  /** Output format. e.g. 'webp', 'avif', 'mp4'. */
  format?: string;
  /** Width in pixels. */
  width?: number;
  /** Height in pixels. */
  height?: number;
  /** Quality 1-100. */
  quality?: number;
  /** Fit mode: cover, contain, fill, inside, outside. */
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  /** Adapter-specific free-form options. */
  [key: string]: unknown;
}

export interface ProcessResult {
  data: Uint8Array;
  contentType: string;
  width?: number;
  height?: number;
  size: number;
}

export interface MediaAdapter {
  readonly name: string;
  readonly kind: MediaKind;
  process(input: Uint8Array, options: ProcessOptions): Promise<ProcessResult>;
}

export interface MediaManager {
  process(kind: MediaKind, input: Uint8Array, options: ProcessOptions): Promise<ProcessResult>;
  adapter(name: string): MediaAdapter | undefined;
}

export function createMediaManager(adapters: readonly MediaAdapter[]): MediaManager {
  const byName = new Map(adapters.map((a) => [a.name, a]));
  const byKind = new Map<MediaKind, MediaAdapter>();
  for (const a of adapters) {
    if (!byKind.has(a.kind)) byKind.set(a.kind, a);
  }

  return {
    async process(kind, input, options) {
      const adapter = byKind.get(kind);
      if (adapter === undefined) {
        throw noAdapter(kind);
      }
      return adapter.process(input, options);
    },
    adapter(name) {
      return byName.get(name);
    },
  };
}
