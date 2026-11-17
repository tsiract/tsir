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
  | 'MEDIA_NO_ADAPTER'
  | 'CAP_DRIVER_MISSING'
  | 'CAP_FORBIDDEN_IN_PRODUCTION';

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

/**
 * A `media.adapters` name this build does not ship (`CAP-017`).
 *
 * Lists the adapters that exist, because the fix is one string — and because `sharp` and `ffmpeg`
 * are not interchangeable with `cloudflare`: the first two need a binary in the image, the third
 * needs an account.
 */
export function driverMissing(adapter: string, known: readonly string[]): TsirError {
  return new TsirError(
    'CAP_DRIVER_MISSING',
    `media names adapter "${adapter}", which is not registered`,
    {
      kind: 'capability',
      hint: `this build ships: ${known.join(', ')}`,
      context: { adapter },
    },
  );
}

/**
 * `memory`-shaped media work is refused where it would be a lie about durability (`CAP-017`).
 *
 * `sharp` and `ffmpeg` do not produce a stored asset — they hand bytes back to the caller, and on
 * a Worker there is no filesystem to hand them to. That is fine on a long-lived server with a
 * disk, and it is a dropped upload on a stateless target, which is why it is refused rather than
 * documented.
 */
export function forbiddenInProduction(adapter: string, target: string): TsirError {
  return new TsirError(
    'CAP_FORBIDDEN_IN_PRODUCTION',
    `media adapter "${adapter}" cannot be the production adapter on "${target}": it writes to the local process, which a stateless target does not keep`,
    {
      kind: 'capability',
      hint: 'use `cloudflare` (Images and Stream), or `cloudinary` / `imagekit` — all three store the asset where the next request can reach it',
      context: { adapter, target },
    },
  );
}
