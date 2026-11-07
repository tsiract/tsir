/**
 * ImageKit adapter — upload + transform via ImageKit API.
 */
import { imagekitUploadFailed, imagekitDeliveryFailed } from '../errors.ts';
import type { MediaAdapter } from '../media.ts';

export interface ImageKitAdapterOptions {
  publicKey: string;
  privateKey: string;
  urlEndpoint: string;
}

export function imagekitAdapter(options: ImageKitAdapterOptions): MediaAdapter {
  return {
    name: 'imagekit',
    kind: 'image',
    async process(input, opts) {
      // 1. Upload with base64 encoding (ImageKit accepts base64 in the file field).
      const base64 = Buffer.from(input).toString('base64');
      const uploadUrl = 'https://upload.imagekit.io/api/v1/files/upload';
      const auth = `Basic ${Buffer.from(`${options.publicKey}:${options.privateKey}`).toString('base64')}`;

      const form = new FormData();
      form.append('file', base64);
      form.append('fileName', 'upload');

      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: { Authorization: auth },
        body: form,
      });
      if (!uploadRes.ok) {
        throw imagekitUploadFailed(`ImageKit upload failed: ${uploadRes.status}`);
      }
      const json = (await uploadRes.json()) as { url: string; width: number; height: number };

      // 2. Apply transformations via URL query params.
      const params = new URLSearchParams();
      if (opts.width !== undefined) params.set('w', String(opts.width));
      if (opts.height !== undefined) params.set('h', String(opts.height));
      if (opts.quality !== undefined) params.set('q', String(opts.quality));
      if (opts.format !== undefined) params.set('f', opts.format);

      const qs = params.toString();
      const url = qs ? `${json.url}?${qs}` : json.url;

      // 3. Fetch the transformed image.
      const out = await fetch(url);
      if (!out.ok) throw imagekitDeliveryFailed(`ImageKit delivery failed: ${out.status}`);
      const buf = new Uint8Array(await out.arrayBuffer());
      return {
        data: buf,
        contentType: out.headers.get('content-type') ?? 'image/jpeg',
        width: json.width,
        height: json.height,
        size: buf.length,
      };
    },
  };
}
