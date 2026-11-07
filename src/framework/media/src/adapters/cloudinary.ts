/**
 * Cloudinary adapter — upload + transform via Cloudinary API.
 *
 * Uses the unsigned upload endpoint (requires an upload preset) to avoid
 * signing requests server-side. For signed uploads, use the `cloudinary` SDK
 * directly.
 */
import { cloudinaryUploadFailed, cloudinaryDeliveryFailed } from '../errors.ts';
import type { MediaAdapter } from '../media.ts';

export interface CloudinaryAdapterOptions {
  cloudName: string;
  /** Upload preset name (unsigned). */
  uploadPreset: string;
}

export function cloudinaryAdapter(options: CloudinaryAdapterOptions): MediaAdapter {
  return {
    name: 'cloudinary',
    kind: 'image',
    async process(input, opts) {
      // 1. Upload.
      const uploadUrl = `https://api.cloudinary.com/v1_1/${options.cloudName}/image/upload`;
      const form = new FormData();
      form.append('file', new Blob([input]), 'upload');
      form.append('upload_preset', options.uploadPreset);

      const uploadRes = await fetch(uploadUrl, { method: 'POST', body: form });
      if (!uploadRes.ok) {
        throw cloudinaryUploadFailed(`Cloudinary upload failed: ${uploadRes.status}`);
      }
      const json = (await uploadRes.json()) as {
        public_id: string;
        format: string;
        width: number;
        height: number;
      };

      // 2. Build transformation URL.
      const transforms: string[] = [];
      if (opts.width !== undefined) transforms.push(`w_${opts.width}`);
      if (opts.height !== undefined) transforms.push(`h_${opts.height}`);
      if (opts.quality !== undefined) transforms.push(`q_${opts.quality}`);
      if (opts.fit === 'cover') transforms.push('c_fill');
      else if (opts.fit === 'contain') transforms.push('c_fit');
      else if (opts.fit === 'fill') transforms.push('c_scale');

      const tx = transforms.length > 0 ? `${transforms.join(',')}/` : '';
      const url = `https://res.cloudinary.com/${options.cloudName}/image/upload/${tx}${json.public_id}.${opts.format ?? json.format}`;

      // 3. Fetch the transformed image.
      const out = await fetch(url);
      if (!out.ok) throw cloudinaryDeliveryFailed(`Cloudinary delivery failed: ${out.status}`);
      const buf = new Uint8Array(await out.arrayBuffer());
      return {
        data: buf,
        contentType: `image/${opts.format ?? json.format}`,
        width: json.width,
        height: json.height,
        size: buf.length,
      };
    },
  };
}
