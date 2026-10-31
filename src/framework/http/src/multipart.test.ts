import { describe, expect, test } from 'bun:test';

import { Controller, Post, RouteRegistry, compileRoutes } from '@tsir/router';
import { z } from '@tsir/validate';
import { FileField } from '@tsir/validate/http';

import { readMultipart, sniffMimeType } from './multipart.ts';
import { createFetchHandler } from './pipeline.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function upload(fields: Record<string, string | File>): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return new Request('http://tsir.test/upload', { method: 'POST', body: form });
}

function table(build: (registry: RouteRegistry) => void): ReturnType<typeof compileRoutes> {
  const registry = new RouteRegistry();
  build(registry);
  return compileRoutes(registry.entries());
}

describe('http · mime sniffing (VLD-006)', () => {
  test('identifies formats by magic number, and only those', () => {
    expect(sniffMimeType(PNG)).toBe('image/png');
    expect(sniffMimeType(PDF)).toBe('application/pdf');
    expect(sniffMimeType(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeUndefined(); // "<svg" — text, not sniffed
    expect(sniffMimeType(new Uint8Array([]))).toBeUndefined();
    expect(sniffMimeType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
  });

  test('parses fields and files into one flat object', async () => {
    const result = await readMultipart(
      upload({ name: 'ada', file: new File([PNG], 'a.png', { type: 'image/png' }) }),
      { maxBytes: 1_000_000 },
    );
    expect(result.kind).toBe('parsed');
    if (result.kind !== 'parsed') return;
    expect(result.value['name']).toBe('ada');
    expect(result.value['file']).toBeInstanceOf(File);
  });

  test('a file whose bytes contradict its declared type is reported, not stored', async () => {
    const result = await readMultipart(
      upload({ file: new File([ZIP], 'innocent.png', { type: 'image/png' }) }),
      { maxBytes: 1_000_000 },
    );
    expect(result).toEqual({
      kind: 'mime-mismatch',
      field: 'file',
      declared: 'image/png',
      sniffed: 'application/zip',
    });
  });

  test('an empty declared type adopts the sniffed one', async () => {
    const result = await readMultipart(upload({ file: new File([PNG], 'a', { type: '' }) }), {
      maxBytes: 1_000_000,
    });
    expect(result.kind).toBe('parsed');
    if (result.kind !== 'parsed') return;
    const file = result.value['file'];
    expect(file).toBeInstanceOf(File);
    if (file instanceof File) expect(file.type).toBe('image/png');
  });

  test('sniffing can be turned off for formats we do not recognise', async () => {
    const result = await readMultipart(
      upload({ file: new File([ZIP], 'bundle.zip', { type: 'application/zip' }) }),
      { maxBytes: 1_000_000, sniff: false },
    );
    expect(result.kind).toBe('parsed');
  });

  test('the body cap is enforced before parsing', async () => {
    const result = await readMultipart(
      upload({
        file: new File([new Uint8Array(4096)], 'big.bin', { type: 'application/octet-stream' }),
      }),
      { maxBytes: 512 },
    );
    expect(result.kind).toBe('too-large');
  });

  test('per-file and file-count limits produce 413, not 422', async () => {
    const bigFile = await readMultipart(
      upload({ file: new File([new Uint8Array(2048)], 'big.png', { type: 'image/png' }) }),
      { maxBytes: 1_000_000, maxFileBytes: 100 },
    );
    expect(bigFile.kind).toBe('too-large');

    const form = new FormData();
    for (const index of [1, 2, 3])
      form.set(`f${String(index)}`, new File([PNG], `${String(index)}.png`, { type: 'image/png' }));
    const tooMany = await readMultipart(
      new Request('http://tsir.test/upload', { method: 'POST', body: form }),
      {
        maxBytes: 1_000_000,
        maxFiles: 2,
      },
    );
    expect(tooMany.kind).toBe('too-large');
  });
});

describe('http · multipart route (VLD-006)', () => {
  const Avatar = z.object({
    name: z.string().min(1),
    file: FileField({ mimeTypes: ['image/png'], maxBytes: 4096 }),
  });

  function handler(limits: { maxFileBytes?: number; maxFiles?: number } = {}) {
    return createFetchHandler(
      table((registry) => {
        @Controller(registry, '/')
        class Uploads {
          @Post('/upload', {
            consumes: ['multipart/form-data'],
            body: Avatar,
            multipart: limits,
          })
          one({ body }: { body: { name: string; file: File } }): unknown {
            return { name: body.name, size: body.file.size, type: body.file.type };
          }
        }
        void Uploads;
      }),
      { multipart: readMultipart },
    );
  }

  test('a valid upload reaches the handler with a real File', async () => {
    const response = await handler()(
      upload({ name: 'ada', file: new File([PNG], 'a.png', { type: 'image/png' }) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'ada', size: PNG.length, type: 'image/png' });
  });

  test('a declared type the schema does not accept is a 422', async () => {
    const response = await handler()(
      upload({ name: 'ada', file: new File([PDF], 'doc.pdf', { type: 'application/pdf' }) }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { code: string; issues?: { path?: string }[] };
    expect(body.code).toBe('HTP_VALIDATION_FAILED');
    // Issue paths are arrays (`['file']`), one segment per level — the client
    // needs to point at the offending field, not at "the body".
    expect(body.issues?.some((issue) => JSON.stringify(issue.path) === '["file"]')).toBe(true);
  });

  test('a mime mismatch is a 422 that names the field and both types', async () => {
    const response = await handler()(
      upload({ name: 'ada', file: new File([ZIP], 'fake.png', { type: 'image/png' }) }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { code: string; detail?: string };
    expect(body.code).toBe('HTP_MIME_MISMATCH');
    expect(body.detail).toContain('fake.png'.length > 0 ? 'declared image/png' : '');
    expect(body.detail).toContain('application/zip');
  });

  test('an oversize file is a 413, from the route-level limit', async () => {
    const response = await handler({ maxFileBytes: 64 })(
      upload({ name: 'ada', file: new File([PNG], 'a.png', { type: 'image/png' }) }),
    );
    // PNG fixture is 10 bytes, so exceed the cap with a bigger file of the same type.
    expect(response.status).toBe(200);

    const huge = new Uint8Array(256);
    huge.set(PNG);
    const tooBig = await handler({ maxFileBytes: 64 })(
      upload({ name: 'ada', file: new File([huge], 'a.png', { type: 'image/png' }) }),
    );
    expect(tooBig.status).toBe(413);
  });
});

describe('http · multipart is opt-in (budget split)', () => {
  test('a multipart request without a parser is 415, not a crash or an empty body', async () => {
    const bare = createFetchHandler(
      table((registry) => {
        @Controller(registry, '/')
        class Uploads {
          // Declares a real file field: this route *needs* a parser.
          @Post('/upload', {
            consumes: ['multipart/form-data'],
            body: z.object({ image: FileField({ mimeTypes: ['image/png'] }) }),
          })
          one(): unknown {
            return { ok: true };
          }
        }
        void Uploads;
      }),
    );

    const response = await bare(
      upload({ name: 'ada', file: new File([PNG], 'a.png', { type: 'image/png' }) }),
    );
    expect(response.status).toBe(415);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('HTP_UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('multipart: object-prototype field names (SEC-012)', () => {
  const boundary = 'PROTO';
  const form = (name: string) =>
    new Request('https://x/upload', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: [
        `--${boundary}`,
        `Content-Disposition: form-data; name="${name}"`,
        '',
        'value',
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    });

  test('a field named __proto__ is refused, and the prototype of the result is never rewritten', async () => {
    const result = await readMultipart(form('__proto__'), {
      maxBytes: 100_000,
      maxFiles: 5,
      maxFileBytes: 50_000,
      maxFields: 20,
    } as never);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') expect(result.detail).toMatch(/forbidden name/u);
  });

  test('an ordinary field still parses into a plain object', async () => {
    const result = await readMultipart(form('title'), {
      maxBytes: 100_000,
      maxFiles: 5,
      maxFileBytes: 50_000,
      maxFields: 20,
    } as never);
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.value).toEqual({ title: 'value' });
      expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    }
  });
});
