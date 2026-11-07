/**
 * Cloudflare adapter — Cloudflare Images + Stream.
 *
 * Uses the Cloudflare Images API for image variants and Stream for video.
 * Docs: https://developers.cloudflare.com/images/
 */
import { cloudflareUploadFailed, cloudflareDeliveryFailed } from '../errors.ts';
import type { MediaAdapter } from '../media.ts';

export interface CloudflareAdapterOptions {
  accountId: string;
  apiToken: string;
  /** Images variant name to use for transforms. */
  imageVariant?: string;
  /** Base URL for the images CDN (defaults to imagedelivery.net). */
  imagesBaseUrl?: string;
}

export function cloudflareAdapter(options: CloudflareAdapterOptions): MediaAdapter {
  const base = options.imagesBaseUrl ?? `https://imagedelivery.net/${options.accountId}`;

  return {
    name: 'cloudflare',
    kind: 'image',
    async process(input, opts) {
      // 1. Upload the image to Cloudflare Images (direct upload API).
      const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/images/v1`;
      const form = new FormData();
      form.append('file', new Blob([input]), 'upload');

      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiToken}` },
        body: form,
      });
      if (!uploadRes.ok) {
        throw cloudflareUploadFailed(
          `Cloudflare upload failed: ${uploadRes.status} ${await uploadRes.text()}`,
        );
      }
      const json = (await uploadRes.json()) as { result: { id: string } };
      const imageId = json.result.id;

      // 2. Build the delivery URL with the variant / dimensions.
      const variant = options.imageVariant ?? 'public';
      let url = `${base}/${imageId}/${variant}`;
      if (opts.width !== undefined || opts.height !== undefined) {
        url = `${base}/${imageId}/w=${opts.width ?? 0},h=${opts.height ?? 0}`;
      }

      // 3. Fetch the processed image.
      const out = await fetch(url);
      if (!out.ok) throw cloudflareDeliveryFailed(`Cloudflare delivery failed: ${out.status}`);
      const buf = new Uint8Array(await out.arrayBuffer());
      return {
        data: buf,
        contentType: out.headers.get('content-type') ?? 'image/webp',
        size: buf.length,
      };
    },
  };
}
