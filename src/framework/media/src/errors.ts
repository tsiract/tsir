/**
 * Media error codes.
 *
 * Adapter upload/delivery failures, ffmpeg transcoding failures, and the
 * no-adapter-configured case.
 */
import { TsirError } from '@tsir/container';

export type MediaErrorCode =
  | 'CLOUDINARY_UPLOAD_FAILED'
  | 'CLOUDINARY_DELIVERY_FAILED'
  | 'CLOUDFLARE_UPLOAD_FAILED'
  | 'CLOUDFLARE_DELIVERY_FAILED'
  | 'FFMPEG_FAILED'
  | 'IMAGEKIT_UPLOAD_FAILED'
  | 'IMAGEKIT_DELIVERY_FAILED'
  | 'MEDIA_NO_ADAPTER';

/** A Cloudinary upload failed. */
export function cloudinaryUploadFailed(message: string): TsirError {
  return new TsirError('CLOUDINARY_UPLOAD_FAILED', message, { kind: 'internal' });
}

/** A Cloudinary delivery (URL generation) failed. */
export function cloudinaryDeliveryFailed(message: string): TsirError {
  return new TsirError('CLOUDINARY_DELIVERY_FAILED', message, { kind: 'internal' });
}

/** A Cloudflare Images upload failed. */
export function cloudflareUploadFailed(message: string): TsirError {
  return new TsirError('CLOUDFLARE_UPLOAD_FAILED', message, { kind: 'internal' });
}

/** A Cloudflare Images delivery (URL generation) failed. */
export function cloudflareDeliveryFailed(message: string): TsirError {
  return new TsirError('CLOUDFLARE_DELIVERY_FAILED', message, { kind: 'internal' });
}

/** An ffmpeg transcoding operation failed. */
export function ffmpegFailed(message: string): TsirError {
  return new TsirError('FFMPEG_FAILED', message, { kind: 'internal' });
}

/** An ImageKit upload failed. */
export function imagekitUploadFailed(message: string): TsirError {
  return new TsirError('IMAGEKIT_UPLOAD_FAILED', message, { kind: 'internal' });
}

/** An ImageKit delivery (URL generation) failed. */
export function imagekitDeliveryFailed(message: string): TsirError {
  return new TsirError('IMAGEKIT_DELIVERY_FAILED', message, { kind: 'internal' });
}

/** No media adapter is configured. */
export function noAdapter(kind: string): TsirError {
  return new TsirError('MEDIA_NO_ADAPTER', `no media adapter for kind: ${kind}`, {
    kind: 'internal',
    hint: 'set media.driver to one of: cloudinary, cloudflare, imagekit',
  });
}
