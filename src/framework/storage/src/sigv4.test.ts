/**
 * SigV4 (`§ 6`).
 *
 * A homegrown signer is only worth having if it is checked against **AWS's own vectors** — a
 * signature that is merely self-consistent is a 403 in production with no field named in it.
 * The two vectors here are from AWS's "Examples of the complete Signature Version 4 signing
 * process": the signing-key derivation, and the complete `GET https://iam.amazonaws.com` request.
 */

import { describe, expect, test } from 'bun:test';

import {
  amzDate,
  canonicalQuery,
  canonicalUri,
  dateStamp,
  presignUrl,
  sha256Hex,
  signRequest,
  signingKey,
  uriEncode,
} from './sigv4.ts';

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

const hexOf = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

describe('the published vectors', () => {
  test('the signing key for 20120215 / us-east-1 / iam is the documented one', async () => {
    // AWS's "Example: signing key derivation". Everything else in SigV4 is a hex digest of a
    // string; this is the only derived secret, so it is the one worth pinning.
    const key = await signingKey(CREDENTIALS.secretAccessKey, '20120215', 'us-east-1', 'iam');
    expect(hexOf(key)).toBe('f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
  });

  test('the complete IAM ListUsers request signs to the documented signature', async () => {
    const headers = await signRequest({
      method: 'GET',
      url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      credentials: CREDENTIALS,
      region: 'us-east-1',
      service: 'iam',
      date: Date.parse('2015-08-30T12:36:00Z'),
    });

    expect(headers['x-amz-date']).toBe('20150830T123600Z');
    // `x-amz-content-sha256` is S3-only, and adding it here would change the signature — which
    // is exactly how the difference was caught.
    expect(headers['x-amz-content-sha256']).toBeUndefined();
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, ' +
        'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });
});

describe('the details that go wrong', () => {
  test('encoding is RFC 3986, not encodeURIComponent', () => {
    // `encodeURIComponent` leaves these four alone; SigV4 does not. A key containing `!` signed
    // one way and sent another is a 403 with no field named.
    expect(uriEncode("!*'()")).toBe('%21%2A%27%28%29');
    expect(uriEncode('a b+c')).toBe('a%20b%2Bc');
    expect(uriEncode('a/b')).toBe('a%2Fb');
    expect(uriEncode('a/b', false)).toBe('a/b');
    expect(uriEncode('ü')).toBe('%C3%BC');
  });

  test('a path is encoded per segment and never normalised', () => {
    expect(canonicalUri('/bucket/a b/c+d.png')).toBe('/bucket/a%20b/c%2Bd.png');
    expect(canonicalUri('/')).toBe('/');
    expect(canonicalUri('')).toBe('/');
    // S3 can hold both keys; normalising here would sign a different object.
    expect(canonicalUri('/a/./b')).toBe('/a/./b');
  });

  test('query parameters are sorted by their encoded name', () => {
    expect(canonicalQuery({ b: '2', a: '1' })).toBe('a=1&b=2');
    expect(canonicalQuery({ 'list-type': '2', prefix: 'a/b' })).toBe('list-type=2&prefix=a%2Fb');
    expect(canonicalQuery(new URLSearchParams('z=1&a=2'))).toBe('a=2&z=1');
  });

  test('the timestamp formats are the ones SigV4 prints', () => {
    const at = Date.parse('2013-05-24T00:00:00Z');
    expect(amzDate(at)).toBe('20130524T000000Z');
    expect(dateStamp(at)).toBe('20130524');
  });

  test('the payload hash is the hex SHA-256 of the body', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('s3 request signing', () => {
  const base = {
    credentials: CREDENTIALS,
    region: 'auto',
    service: 's3',
    date: Date.parse('2026-01-01T00:00:00Z'),
  };

  test('an S3 request carries the payload hash, because S3 requires it', async () => {
    const headers = await signRequest({
      ...base,
      method: 'PUT',
      url: 'https://example.r2.cloudflarestorage.com/bucket/a.txt',
      headers: { 'content-type': 'text/plain' },
      body: new TextEncoder().encode('hello'),
    });

    expect(headers['x-amz-content-sha256']).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(headers['authorization']).toContain(
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date',
    );
    expect(headers['host']).toBe('example.r2.cloudflarestorage.com');
  });

  test('a session token is signed and sent', async () => {
    const headers = await signRequest({
      ...base,
      credentials: { ...CREDENTIALS, sessionToken: 'token-value' },
      method: 'GET',
      url: 'https://example.r2.cloudflarestorage.com/bucket/a.txt',
    });

    expect(headers['x-amz-security-token']).toBe('token-value');
    expect(headers['authorization']).toContain('x-amz-security-token');
  });

  test('the same request twice is the same signature; a different body is not', async () => {
    const once = await signRequest({ ...base, method: 'GET', url: 'https://x/b/k' });
    const twice = await signRequest({ ...base, method: 'GET', url: 'https://x/b/k' });
    const other = await signRequest({
      ...base,
      method: 'GET',
      url: 'https://x/b/k',
      body: new TextEncoder().encode('different'),
    });

    expect(once['authorization']).toBe(twice['authorization'] as string);
    expect(other['authorization']).not.toBe(once['authorization'] as string);
  });
});

describe('presigned URLs', () => {
  test('the signature is in the query, with the scope and the expiry', async () => {
    const url = new URL(
      await presignUrl({
        method: 'GET',
        url: 'https://example.r2.cloudflarestorage.com/bucket/report.pdf',
        expiresInSeconds: 900,
        credentials: CREDENTIALS,
        region: 'auto',
        service: 's3',
        date: Date.parse('2026-01-01T00:00:00Z'),
      }),
    );

    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIDEXAMPLE/20260101/auto/s3/aws4_request',
    );
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260101T000000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/u);
    // The path is untouched: a signed URL that re-encodes the key names a different object.
    expect(url.pathname).toBe('/bucket/report.pdf');
  });

  test('the signature changes with the expiry, so a shortened URL is a different one', async () => {
    const sign = async (seconds: number): Promise<string> =>
      (
        await presignUrl({
          method: 'GET',
          url: 'https://x/b/k',
          expiresInSeconds: seconds,
          credentials: CREDENTIALS,
          region: 'auto',
          service: 's3',
          date: Date.parse('2026-01-01T00:00:00Z'),
        })
      ).split('X-Amz-Signature=')[1] ?? '';

    expect(await sign(60)).not.toBe(await sign(120));
  });

  test('an expiry S3 would reject is refused at mint time, not as a later 403', async () => {
    // `X-Amz-Expires` is signed, so S3 accepts the URL and refuses *use* of it. A helper that
    // applications call directly should not hand out a URL that cannot work (CAP-P7 F2).
    const withExpiry = (expiresInSeconds: number): Promise<string> =>
      presignUrl({
        method: 'GET',
        url: 'https://x/b/k',
        expiresInSeconds,
        credentials: CREDENTIALS,
        region: 'auto',
        service: 's3',
        date: Date.parse('2026-01-01T00:00:00Z'),
      });

    // Resolved-or-message, rather than `expect(promise).rejects`: the matcher shape is not a
    // Promise, and awaiting it is a lint error in this repository (zero suppressions).
    const mint = async (seconds: number): Promise<string> => {
      try {
        await withExpiry(seconds);
        return 'resolved';
      } catch (error) {
        return (error as Error).message;
      }
    };

    for (const bad of [0, -1, 7 * 24 * 60 * 60 + 1, 1.5, Number.NaN]) {
      expect(await mint(bad)).toMatch(/X-Amz-Expires/u);
    }
    // The two boundaries are legal.
    expect(await withExpiry(1)).toContain('X-Amz-Expires=1');
    expect(await withExpiry(604_800)).toContain('X-Amz-Expires=604800');
  });
});
