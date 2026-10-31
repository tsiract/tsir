/**
 * AWS Signature Version 4, in WebCrypto and nothing else (`§ 6`).
 *
 * The `s3` driver covers R2 because R2 speaks S3's API — which means it speaks S3's *auth*, and
 * re-implementing SigV4 is the price of not taking a dependency. It is about 150 lines and it is
 * fully specified, which is a better trade than an SDK that would be the third runtime dependency
 * of the framework and the only one that has to sign requests by hand anyway.
 *
 * Three details are where a homegrown implementation goes wrong, so they are named here:
 *
 *   · **The canonical URI is not normalised for S3.** Every other service encodes and normalises
 *     the path; S3's documentation says do not, because `a/./b` and `a/b` can be two different
 *     objects in a bucket. The signing function encodes each segment and leaves `/` alone.
 *   · **Encoding is RFC 3986, not `encodeURIComponent`.** The two differ on `!*'()`, which
 *     `encodeURIComponent` leaves alone and SigV4 requires encoded. A key containing `!` would
 *     otherwise sign one string and send another.
 *   · **Query parameters are sorted by their *encoded* name**, in ASCII order, and both halves
 *     encoded — a presigned URL with `X-Amz-Expires` after `X-Amz-SignedHeaders` is a 403 that
 *     names no field.
 *
 * Verified against AWS's own published vectors in `sigv4.test.ts`: the signing-key derivation
 * example and the complete `GET https://iam.amazonaws.com/?Action=ListUsers` request.
 */

import { signingFailed } from './errors.ts';

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** For STS credentials and R2's scoped tokens. Sent as `x-amz-security-token`. */
  readonly sessionToken?: string | undefined;
}

export interface SigningContext {
  readonly credentials: AwsCredentials;
  readonly region: string;
  readonly service: string;
  /** The instant to sign at. Injectable, because a signature is a function of the clock. */
  readonly date: number;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';

/** S3's documented ceiling for `X-Amz-Expires`: seven days, in seconds. */
export const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;
/** `UNSIGNED-PAYLOAD` is what a presigned URL signs: the body is not known when it is created. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** `20130524T000000Z` — the timestamp SigV4 puts in `x-amz-date` and in the string to sign. */
export function amzDate(date: number): string {
  return new Date(date)
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '');
}

/** `20130524` — the scope's date, and the day of the signing key. */
export function dateStamp(date: number): string {
  return amzDate(date).slice(0, 8);
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * A `Uint8Array` WebCrypto will take.
 *
 * `crypto.subtle` is typed against `ArrayBuffer`-backed views, while a caller's bytes may be a
 * view over anything (a pooled `Buffer`, a slice of a larger frame). Copying into a fresh array
 * is a few hundred bytes on a request that is about to cross the network, and it removes the
 * only cast this module would otherwise need.
 */
function bufferOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : bufferOf(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return hex(new Uint8Array(digest));
}

export async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    'raw',
    bufferOf(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}

/** The HMAC chain: `AWS4` + secret → date → region → service → `aws4_request`. */
export async function signingKey(
  secretAccessKey: string,
  stamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), stamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * RFC 3986 encoding: everything except the unreserved set, upper-case hex.
 *
 * `encodeURIComponent` is close enough to be tempting and wrong on exactly `!*'()` — four
 * characters that appear in real filenames.
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const char of value) {
    if (/[A-Za-z0-9\-._~]/u.test(char)) {
      out += char;
      continue;
    }
    if (char === '/' && !encodeSlash) {
      out += char;
      continue;
    }
    for (const byte of new TextEncoder().encode(char)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** The path as SigV4 wants it: each segment encoded, `/` kept, nothing normalised. */
export function canonicalUri(path: string): string {
  if (path === '' || path === '/') return '/';
  return path
    .split('/')
    .map((segment) => (segment === '' ? '' : uriEncode(segment)))
    .join('/');
}

/** Sorted, both halves encoded, joined with `&`. */
export function canonicalQuery(params: Readonly<Record<string, string>> | URLSearchParams): string {
  const entries =
    params instanceof URLSearchParams
      ? [...params.entries()]
      : Object.entries(params).map(([key, value]) => [key, value] as const);
  return entries
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function canonicalHeaders(headers: Readonly<Record<string, string>>): {
  readonly canonical: string;
  readonly signed: string;
} {
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonical = names
    .map((name) => `${name}:${(headers[name] ?? '').trim().replace(/\s+/gu, ' ')}\n`)
    .join('');
  return { canonical, signed: names.join(';') };
}

export interface SignRequestInput extends SigningContext {
  readonly method: string;
  /** The absolute URL, without a body. */
  readonly url: string;
  /** Extra headers to sign and send. `host` and `x-amz-*` are added. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: Uint8Array | undefined;
}

/**
 * Header-based signing: the headers to send, including `Authorization`.
 *
 * `host` is signed, so it cannot be rewritten by a proxy after signing; `x-amz-content-sha256`
 * is signed for the same reason, and it is what makes a tampered body a 400 rather than a
 * successful write of the wrong bytes.
 */
export async function signRequest(
  input: SignRequestInput,
): Promise<Readonly<Record<string, string>>> {
  const url = new URL(input.url);
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  const stamp = amzDate(input.date);
  const payloadHash = input.body === undefined ? await sha256Hex('') : await sha256Hex(input.body);

  headers['host'] = url.host;
  headers['x-amz-date'] = stamp;
  // S3 is the one service that requires the payload hash as a header — it is what makes a
  // tampered body a signature failure rather than a successful write of the wrong bytes. Every
  // other service signs the hash without sending it, and sending it anyway changes the
  // signature (and the published AWS vectors, which is how this was noticed).
  if (input.service === 's3') headers['x-amz-content-sha256'] = payloadHash;
  if (input.credentials.sessionToken !== undefined) {
    headers['x-amz-security-token'] = input.credentials.sessionToken;
  }

  const canonical = [
    input.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders(headers).canonical,
    canonicalHeaders(headers).signed,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp(input.date)}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [ALGORITHM, stamp, scope, await sha256Hex(canonical)].join('\n');
  const key = await signingKey(
    input.credentials.secretAccessKey,
    dateStamp(input.date),
    input.region,
    input.service,
  );
  const signature = hex(await hmac(key, stringToSign));

  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${canonicalHeaders(headers).signed}, Signature=${signature}`,
  };
}

export interface PresignInput extends SigningContext {
  readonly method: string;
  readonly url: string;
  /** Lifetime in seconds. S3 allows 1 … 604 800 (seven days). */
  readonly expiresInSeconds: number;
}

/**
 * Query-based signing: a URL anyone can use until it expires.
 *
 * No headers are signed except `host`, and the payload is `UNSIGNED-PAYLOAD`, because a presigned
 * PUT's body has not been written yet when the URL is handed out.
 */
export async function presignUrl(input: PresignInput): Promise<string> {
  // S3 signs the lifetime into the URL and then rejects it at use time, as a bare 403. That is
  // a bad trade for a helper applications call directly: the mistake is made at mint time and
  // shows up somewhere else. Refuse it here instead. The `s3` driver clamps before it gets
  // here, so this only fires on a hand-built call (`CAP-P7 F2`).
  const seconds = input.expiresInSeconds;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_PRESIGN_SECONDS) {
    throw signingFailed(
      `X-Amz-Expires must be a whole number of seconds between 1 and ${String(MAX_PRESIGN_SECONDS)} (7 days); got ${String(seconds)}`,
    );
  }

  const url = new URL(input.url);
  const stamp = amzDate(input.date);
  const scope = `${dateStamp(input.date)}/${input.region}/${input.service}/aws4_request`;

  url.searchParams.set('X-Amz-Algorithm', ALGORITHM);
  url.searchParams.set('X-Amz-Credential', `${input.credentials.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', stamp);
  url.searchParams.set('X-Amz-Expires', String(Math.round(input.expiresInSeconds)));
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  if (input.credentials.sessionToken !== undefined) {
    url.searchParams.set('X-Amz-Security-Token', input.credentials.sessionToken);
  }

  const canonical = [
    input.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.searchParams),
    `host:${url.host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, stamp, scope, await sha256Hex(canonical)].join('\n');
  const key = await signingKey(
    input.credentials.secretAccessKey,
    dateStamp(input.date),
    input.region,
    input.service,
  );
  url.searchParams.set('X-Amz-Signature', hex(await hmac(key, stringToSign)));
  return url.toString();
}
