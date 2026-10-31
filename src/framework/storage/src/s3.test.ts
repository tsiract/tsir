/**
 * The `s3` driver, and therefore R2 (`§ 6`).
 *
 * No bucket, no network: `fetch` is a function that records the request and answers from a map.
 * That is enough to test the four things a fake bucket would not make clearer — the URL shape
 * (path-style on R2, virtual-hosted on AWS), the signature actually attached, the status → error
 * mapping, and the `ListObjectsV2` XML, including a key with an `&` in it.
 */

import { describe, expect, test } from 'bun:test';

import { decodeEntities, parseListObjectsV2 } from './list-xml.ts';
import { utf8 } from './port.ts';
import { s3Driver } from './drivers/s3.ts';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const CREDENTIALS = { accessKeyId: 'key-id', secretAccessKey: 'secret' };

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | undefined;
}

/** A `fetch` that records and answers from a map of `"METHOD url"` handlers. */
function fakeFetch(handlers: Record<string, (request: Recorded) => Response>): {
  fetch: typeof fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];

  const fetchLike = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const body =
      init?.body === undefined || init.body === null
        ? undefined
        : new Uint8Array(init.body as ArrayBuffer);
    const recorded: Recorded = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      ...(body === undefined ? {} : { body }),
    };
    requests.push(recorded);

    const key = `${recorded.method} ${url}`;
    const handler = handlers[key] ?? handlers[`${recorded.method} *`];
    if (handler === undefined) throw new Error(`fake fetch has no handler for ${key}`);
    return handler(recorded);
  }) as unknown as typeof fetch;

  return { fetch: fetchLike, requests };
}

const r2 = (handlers: Parameters<typeof fakeFetch>[0]) => fakeFetch(handlers);

const baseOptions = {
  bucket: 'tsir-assets',
  region: 'auto',
  credentials: CREDENTIALS,
  endpoint: 'https://account.r2.cloudflarestorage.com',
  now: () => NOW,
};

describe('the URL shape', () => {
  test('R2 is path-style: the bucket is a segment, not a host', async () => {
    const { fetch, requests } = r2({
      'PUT *': () => new Response(null, { status: 200, headers: { etag: '"abc"' } }),
    });
    const driver = s3Driver({ ...baseOptions, fetch });

    await driver.put('uploads/report.pdf', utf8('pdf'), { contentType: 'application/pdf' });

    expect(requests[0]?.url).toBe(
      'https://account.r2.cloudflarestorage.com/tsir-assets/uploads/report.pdf',
    );
    expect(requests[0]?.headers['host']).toBe('account.r2.cloudflarestorage.com');
  });

  test('AWS is virtual-hosted, and a bucket with a dot still works', async () => {
    const { fetch, requests } = r2({
      'PUT *': () => new Response(null, { status: 200 }),
    });
    const driver = s3Driver({
      bucket: 'tsir.assets',
      region: 'eu-west-1',
      credentials: CREDENTIALS,
      fetch,
      now: () => NOW,
    });

    await driver.put('a.txt', utf8('x'), {});
    expect(requests[0]?.url).toBe('https://tsir.assets.s3.eu-west-1.amazonaws.com/a.txt');
  });

  test('a key with a space and a unicode character is encoded once, in the path', async () => {
    const { fetch, requests } = r2({ 'PUT *': () => new Response(null, { status: 200 }) });
    const driver = s3Driver({ ...baseOptions, fetch });

    await driver.put('a b/ü.png', utf8('x'), {});
    expect(requests[0]?.url).toBe(
      'https://account.r2.cloudflarestorage.com/tsir-assets/a%20b/%C3%BC.png',
    );
  });
});

describe('the requests', () => {
  test('a put sends the content type, the length and a signature that covers the body', async () => {
    const { fetch, requests } = r2({
      'PUT *': () => new Response(null, { status: 200, headers: { etag: '"etag-1"' } }),
    });
    const driver = s3Driver({ ...baseOptions, fetch });

    const stored = await driver.put('a.txt', utf8('hello'), {
      contentType: 'text/plain',
      metadata: { Owner: 'billing' },
    });

    const request = requests[0];
    expect(request?.headers['content-type']).toBe('text/plain');
    expect(request?.headers['content-length']).toBe('5');
    // S3 lowercases user metadata; a caller must read back the name it wrote.
    expect(request?.headers['x-amz-meta-owner']).toBe('billing');
    expect(request?.headers['x-amz-content-sha256']).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(request?.headers['authorization']).toContain('AWS4-HMAC-SHA256 Credential=key-id/');
    expect(stored).toMatchObject({ key: 'a.txt', size: 5, contentType: 'text/plain' });
  });

  test('`ifNoneMatch` is one round trip: If-None-Match, and a 412 becomes the coded error', async () => {
    const { fetch, requests } = r2({ 'PUT *': () => new Response(null, { status: 412 }) });
    const driver = s3Driver({ ...baseOptions, fetch });

    expect(driver.put('a.txt', utf8('x'), { ifNoneMatch: true })).rejects.toThrow(
      /already exists on disk "s3"/u,
    );
    expect(requests[0]?.headers['if-none-match']).toBe('*');
  });

  test('a missing key is undefined on get and head; a 403 is an error that names the credential', async () => {
    const { fetch } = r2({
      'GET *': () => new Response(null, { status: 404 }),
      'HEAD *': () => new Response(null, { status: 404 }),
    });
    const driver = s3Driver({ ...baseOptions, fetch });

    expect(await driver.get('gone.txt', {})).toBeUndefined();
    expect(await driver.head('gone.txt')).toBeUndefined();

    const forbidden = r2({
      'GET *': () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }),
    });
    const denied = s3Driver({ ...baseOptions, fetch: forbidden.fetch });
    expect(denied.get('a.txt', {})).rejects.toThrow(/answered 403/u);
    try {
      await denied.get('a.txt', {});
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe('STO_REQUEST_FAILED');
      expect((error as { hint?: string }).hint).toContain('credentials or the bucket policy');
    }
  });

  test('a range read sends Range and reports the object size, not the slice', async () => {
    const { fetch, requests } = r2({
      'GET *': () =>
        new Response(utf8('ell'), {
          status: 206,
          headers: {
            'content-range': 'bytes 1-3/5',
            'content-length': '3',
            'content-type': 'text/plain',
          },
        }),
    });
    const driver = s3Driver({ ...baseOptions, fetch });

    const body = await driver.get('a.txt', { range: { start: 1, end: 3 } });
    expect(requests[0]?.headers['range']).toBe('bytes=1-3');
    expect(body?.body.length).toBe(3);
    expect(body?.object.size).toBe(5);
  });

  test('delete is idempotent: a 204 is true, and a second call is true too, not an error', async () => {
    const { fetch } = r2({ 'DELETE *': () => new Response(null, { status: 204 }) });
    const driver = s3Driver({ ...baseOptions, fetch });

    expect(await driver.delete('a.txt')).toBe(true);
    expect(await driver.delete('a.txt')).toBe(true);
  });
});

describe('listing', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>tsir-assets</Name>
  <Prefix>uploads/</Prefix>
  <KeyCount>2</KeyCount>
  <MaxKeys>2</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>token-2</NextContinuationToken>
  <Contents>
    <Key>uploads/a&amp;b.txt</Key>
    <LastModified>2026-01-01T00:00:00.000Z</LastModified>
    <ETag>&quot;etag-a&quot;</ETag>
    <Size>3</Size>
  </Contents>
  <Contents>
    <Key>uploads/c.png</Key>
    <LastModified>2026-01-02T00:00:00.000Z</LastModified>
    <ETag>&quot;etag-c&quot;</ETag>
    <Size>10</Size>
  </Contents>
</ListBucketResult>`;

  test('the query is ListObjectsV2, with the prefix, the limit and the cursor', async () => {
    const { fetch, requests } = r2({ 'GET *': () => new Response(XML, { status: 200 }) });
    const driver = s3Driver({ ...baseOptions, fetch });

    await driver.list({ prefix: 'uploads/', limit: 2, cursor: 'token-1' });

    const url = new URL(requests[0]?.url ?? '');
    expect(url.pathname).toBe('/tsir-assets');
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(url.searchParams.get('prefix')).toBe('uploads/');
    expect(url.searchParams.get('max-keys')).toBe('2');
    expect(url.searchParams.get('continuation-token')).toBe('token-1');
  });

  test('the page, the entities and the cursor are read correctly', async () => {
    const { fetch } = r2({ 'GET *': () => new Response(XML, { status: 200 }) });
    const driver = s3Driver({ ...baseOptions, fetch });

    const page = await driver.list({ prefix: 'uploads/' });
    expect(page.objects.map((object) => object.key)).toEqual(['uploads/a&b.txt', 'uploads/c.png']);
    expect(page.objects[0]).toMatchObject({ size: 3, etag: '"etag-a"' });
    expect(page.objects[0]?.lastModified).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(page.cursor).toBe('token-2');
  });

  test('the last page has no cursor, even when the token is present', () => {
    const parsed = parseListObjectsV2(XML.replace('<IsTruncated>true', '<IsTruncated>false'));
    expect(parsed.objects.length).toBe(2);
    expect(parsed.cursor).toBeUndefined();
  });

  test('a body that is not a listing is refused rather than read as empty', () => {
    expect(() => parseListObjectsV2('<html>hello</html>')).toThrow(/not a ListObjectsV2 response/u);
    expect(decodeEntities('a&amp;b&#65;&#x42;')).toBe('a&bAB');
  });
});

/** A `fetch` that is never called: these cases only build URLs. */
const noFetch = (): typeof fetch =>
  (() => Promise.resolve(new Response())) as unknown as typeof fetch;

describe('URLs', () => {
  test('a disk with no public base URL cannot answer url()', () => {
    const driver = s3Driver({ ...baseOptions, fetch: noFetch() });
    expect(driver.capabilities.publicUrls).toBe(false);
  });

  test('a public base URL is what makes url() answer, and it is the CDN, not the API', () => {
    const driver = s3Driver({
      ...baseOptions,
      publicBaseUrl: 'https://cdn.example.com/',
      fetch: noFetch(),
    });

    expect(driver.capabilities.publicUrls).toBe(true);
    expect(driver.url('a b/ü.png')).toBe('https://cdn.example.com/a%20b/%C3%BC.png');
  });

  test('a presigned URL is a GET with the expiry in it, capped at seven days', async () => {
    const driver = s3Driver({ ...baseOptions, fetch: noFetch() });

    const url = new URL(await driver.temporaryUrl('report.pdf', 15 * 60_000));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/u);

    const capped = new URL(await driver.temporaryUrl('report.pdf', 30 * 24 * 60 * 60_000));
    expect(capped.searchParams.get('X-Amz-Expires')).toBe(String(7 * 24 * 60 * 60));
  });
});
