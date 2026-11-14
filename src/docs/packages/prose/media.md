## Example

An adapter takes bytes and returns bytes. `createMediaManager` picks one per `kind`, so the caller
says "process this image" and the configured adapter decides whether that means `sharp` on a server,
Cloudflare Images at the edge, or an upload to Cloudinary.

```ts
import { createMediaManager, type MediaAdapter } from '@tsir/media';

// A stand-in for sharp/Cloudinary: the point of the example is the manager's contract, not the
// encoder. A real adapter resizes and re-encodes; this one returns what it was given.
const passthrough: MediaAdapter = {
  name: 'passthrough',
  kind: 'image',
  async process(input, options) {
    return {
      data: input,
      contentType: `image/${options.format ?? 'png'}`,
      width: options.width ?? 1,
      height: options.height ?? 1,
      size: input.byteLength,
    };
  },
};

const manager = createMediaManager([passthrough]);
const result = await manager.process('image', new Uint8Array([137, 80, 78, 71]), {
  width: 800,
  format: 'webp',
});

console.log(result.contentType, result.width, result.size);
console.log('adapter found:', manager.adapter('passthrough')?.name);
```

## Failure modes

- `MEDIA_NO_ADAPTER`: `process()` was asked for a `kind` — `image`, `video` — that no configured
  adapter handles. The message names the kind and the adapters that were registered, because the
  usual cause is a config entry with the wrong driver, not a missing feature.
- `CAP_DRIVER_MISSING`: `media.adapters.<name>` names a driver that is not one of `cloudflare`,
  `cloudinary`, `imagekit`, `sharp`, `ffmpeg`.
- `CAP_FORBIDDEN_IN_PRODUCTION`: a local adapter — `sharp`, `ffmpeg` — was configured for production.
  Both need a native binary and a writable filesystem, so a Worker cannot load them; the refusal at
  boot is the alternative to a request that fails on the isolate that happens to have no `sharp`.
- `CLOUDINARY_UPLOAD_FAILED` / `CLOUDINARY_DELIVERY_FAILED`: Cloudinary rejected the upload, or the
  CDN would not deliver the transformed URL. The message carries the provider's status.
- `CLOUDFLARE_UPLOAD_FAILED` / `CLOUDFLARE_DELIVERY_FAILED`: the same two steps through Cloudflare
  Images. On the edge they are one binding call, so a failure here is a binding or an account limit,
  not a network path.
- `IMAGEKIT_UPLOAD_FAILED` / `IMAGEKIT_DELIVERY_FAILED`: ImageKit's upload endpoint, then the
  transformation URL it returns.
- `FFMPEG_FAILED`: the `ffmpeg` process exited non-zero. The message carries its exit status; keep
  the input file, because a transcode failure is almost always about the input.

## Security notes

The adapters that store what they produce — `cloudflare`, `cloudinary`, `imagekit` — upload to a
third party and then hand back a public URL. That URL is not access-controlled by the framework: it is
as public as the provider's configuration makes it, which is why `@tsir/storage` is the package for
"a file only some callers may read". Use media for derived assets (a resized avatar) and storage for
the original when it is private.

`sharp` and `ffmpeg` run on a native binary, and both take their input as bytes. A decoder is the part
of a media pipeline that parses hostile input, so the input size cap belongs in the route that accepts
the upload, not in the adapter — the adapter is already holding the bytes by the time it is called.
Keys for `cloudinary` and `imagekit` are `EnvRef`s: a literal in `tsir.js` is refused at load, the same
rule every secret in the framework follows.
