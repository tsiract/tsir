/**
 * Sharp adapter — local image optimization.
 *
 * Requires the `sharp` package to be installed. We import it lazily so the
 * adapter can be loaded without sharp present (it throws at process time, not
 * import time).
 */
import type { MediaAdapter } from '../media.ts';

/** Minimal sharp surface used by this adapter. */
interface SharpInstance {
  resize(opts: { width?: number; height?: number; fit?: string }): SharpInstance;
  toFormat(format: string, opts: { quality: number }): SharpInstance;
  toBuffer(): Promise<Buffer>;
  metadata(): Promise<SharpMetadata>;
}

interface SharpMetadata {
  width?: number;
  height?: number;
}

interface SharpModule {
  readonly default: (input: Uint8Array | Buffer) => SharpInstance;
}

export interface SharpAdapterOptions {
  /** Default output format if none specified. */
  defaultFormat?: string;
  /** Default quality 1-100. */
  defaultQuality?: number;
}

export function sharpAdapter(options: SharpAdapterOptions = {}): MediaAdapter {
  const defaultFormat = options.defaultFormat ?? 'webp';
  const defaultQuality = options.defaultQuality ?? 80;

  return {
    name: 'sharp',
    kind: 'image',
    async process(input, opts) {
      const { default: sharp } = (await import('sharp')) as SharpModule;
      const format = opts.format ?? defaultFormat;
      const quality = opts.quality ?? defaultQuality;

      const pipeline = sharp(input).resize({
        ...(opts.width !== undefined ? { width: opts.width } : {}),
        ...(opts.height !== undefined ? { height: opts.height } : {}),
        ...(opts.fit !== undefined ? { fit: opts.fit } : {}),
      });

      const data = await pipeline.toFormat(format, { quality }).toBuffer();
      const metadata = await sharp(data).metadata();

      return {
        data: new Uint8Array(data),
        contentType: `image/${format}`,
        ...(metadata.width !== undefined ? { width: metadata.width } : {}),
        ...(metadata.height !== undefined ? { height: metadata.height } : {}),
        size: data.length,
      };
    },
  };
}
