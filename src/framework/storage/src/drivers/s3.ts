/**
 * `s3` — S3, and therefore R2.
 *
 * R2 speaks S3's API at `https://<account>.r2.cloudflarestorage.com`, so **there is no `r2`
 * driver**: the same code serves a bucket on AWS and a bucket on Cloudflare, and a project that
 * moves between them changes an endpoint and a credential. That is the whole argument for S3 as
 * the default storage API, and it is worth not re-litigating per driver.
 *
 * The defaults are chosen for the Workers case, where this runs:
 *
 *   · **Path-style addressing when an `endpoint` is set** (`…/<bucket>/<key>`). R2 requires it,
 *     MinIO requires it, and virtual-hosted style needs a DNS name that a `*.r2.cloudflarestorage.com`
 *     account endpoint does not provide.
 *   · **Virtual-hosted style on AWS** (`<bucket>.s3.<region>.amazonaws.com`), which is the only
 *     form that works with a bucket whose name contains a dot.
 *   · **`fetch` is injectable.** The conformance kit and the tests drive this driver with a
 *     function that records requests and answers from a map, so the signing, the headers and the
 *     error mapping are all tested without a bucket.
 *
 * What it deliberately does not do: multipart uploads (one request, bounded by the caller's
 * memory), retries (a retry policy belongs to whoever knows whether the write is idempotent), and
 * `copy`. Each is a real feature and none is one a first version can fake.
 */

import { TsirError } from '@tsir/container';
import { alreadyExists, requestFailed } from '../errors.ts';
import { parseListObjectsV2 } from '../list-xml.ts';
import { parseCount } from '../numbers.ts';
import type {
  DiskCapabilities,
  GetOptions,
  ListOptions,
  ListResult,
  PutOptions,
  StorageDriver,
  StoredBody,
  StoredObject,
} from '../port.ts';
import {
  MAX_PRESIGN_SECONDS,
  presignUrl,
  sha256Hex,
  signRequest,
  type AwsCredentials,
} from '../sigv4.ts';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
/** Seven days, S3's ceiling for a presigned URL. */

export interface S3DriverOptions {
  readonly bucket: string;
  readonly region: string;
  readonly credentials: AwsCredentials;
  /** `https://<account>.r2.cloudflarestorage.com`. Omit for AWS S3. */
  readonly endpoint?: string | undefined;
  /** Force `…/<bucket>/<key>` even on AWS. Defaults to `true` when an endpoint is set. */
  readonly forcePathStyle?: boolean | undefined;
  /**
   * Where objects are publicly readable (`https://cdn.example.com`). This — not the API
   * endpoint — is what `url()` returns, and it is the only thing that makes `publicUrls` true:
   * an unsigned link to a private bucket is a 403 that looks like a shareable link.
   */
  readonly publicBaseUrl?: string | undefined;
  /** The disk's name, for error messages. */
  readonly name?: string | undefined;
  /** Injectable for tests; `fetch` otherwise. */
  readonly fetch?: typeof fetch | undefined;
  /** Injectable clock: a signature is a function of time, so this is how it is tested. */
  readonly now?: (() => number) | undefined;
}

export function s3Driver(options: S3DriverOptions): StorageDriver {
  const disk = options.name ?? 's3';
  const now = options.now ?? ((): number => Date.now());
  const doFetch = options.fetch ?? fetch;
  const pathStyle = options.forcePathStyle ?? options.endpoint !== undefined;

  const base = (): string =>
    options.endpoint !== undefined
      ? options.endpoint.replace(/\/+$/u, '')
      : `https://s3.${options.region}.amazonaws.com`;

  /** The object's URL: which host, and whether the bucket is a path segment. */
  const objectUrl = (key: string, query?: Readonly<Record<string, string>>): string => {
    const encodedBucket = encodeURIComponent(options.bucket);
    const encodedKey = key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const url =
      pathStyle || options.endpoint !== undefined
        ? new URL(`${base()}/${encodedBucket}/${encodedKey}`)
        : new URL(`https://${options.bucket}.s3.${options.region}.amazonaws.com/${encodedKey}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    return url.toString();
  };

  const bucketUrl = (query: Readonly<Record<string, string>>): string => {
    const url =
      pathStyle || options.endpoint !== undefined
        ? new URL(`${base()}/${encodeURIComponent(options.bucket)}`)
        : new URL(`https://${options.bucket}.s3.${options.region}.amazonaws.com/`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url.toString();
  };

  const signed = async (
    method: string,
    url: string,
    headers: Readonly<Record<string, string>>,
    body: Uint8Array | undefined,
  ): Promise<Response> => {
    const signedHeaders = await signRequest({
      method,
      url,
      headers,
      ...(body === undefined ? {} : { body }),
      credentials: options.credentials,
      region: options.region,
      service: 's3',
      date: now(),
    });
    return doFetch(url, {
      method,
      headers: signedHeaders,
      ...(body === undefined ? {} : { body }),
    });
  };

  const failure = async (operation: string, response: Response) =>
    requestFailed({
      disk,
      operation,
      status: response.status,
      body: await response.text().catch(() => undefined),
    });

  const objectOf = (key: string, headers: Headers): StoredObject => {
    const size = parseCount(headers.get('content-length')) ?? 0;
    const etag = headers.get('etag') ?? '';
    const modified = headers.get('last-modified');
    const metadata: Record<string, string> = {};
    headers.forEach((value, name) => {
      if (name.startsWith('x-amz-meta-')) metadata[name.slice('x-amz-meta-'.length)] = value;
    });
    return {
      key,
      size: Number.isFinite(size) ? size : 0,
      contentType: headers.get('content-type') ?? DEFAULT_CONTENT_TYPE,
      etag,
      ...(modified === null ? {} : { lastModified: Date.parse(modified) }),
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    };
  };

  return {
    name: 's3',

    capabilities: {
      persistent: true,
      sharedAcrossInstances: true,
      publicUrls: options.publicBaseUrl !== undefined,
      signedUrls: true,
      list: true,
      rangeReads: true,
      filesystem: false,
      maxKeyBytes: 1024,
    } satisfies DiskCapabilities,

    async put(key, body, putOptions: PutOptions): Promise<StoredObject> {
      const headers: Record<string, string> = {
        'content-type': putOptions.contentType ?? DEFAULT_CONTENT_TYPE,
        'content-length': String(body.length),
      };
      if (putOptions.cacheControl !== undefined) headers['cache-control'] = putOptions.cacheControl;
      for (const [name, value] of Object.entries(putOptions.metadata ?? {})) {
        // S3 lowercases user metadata names on the way in; lowercasing here means the name a
        // caller reads back is the name it wrote, on every backend.
        headers[`x-amz-meta-${name.toLowerCase()}`] = value;
      }
      if (putOptions.ifNoneMatch === true) {
        // One round trip, not a read-then-write: S3 and R2 both honour `If-None-Match: *`.
        headers['if-none-match'] = '*';
      }

      const response = await signed('PUT', objectUrl(key), headers, body);
      // Not a lazy import: `errors.ts` is imported at the top of every driver, and an `await` here
      // only ever bought a second copy of a module the file already had.
      if (response.status === 412) throw alreadyExists(key, disk);
      if (!response.ok) throw await failure('put', response);

      return {
        key,
        size: body.length,
        contentType: headers['content-type'] ?? DEFAULT_CONTENT_TYPE,
        etag: response.headers.get('etag') ?? `"${await sha256Hex(body)}"`,
        lastModified: now(),
        ...(putOptions.metadata === undefined ? {} : { metadata: putOptions.metadata }),
      };
    },

    async get(key, getOptions: GetOptions): Promise<StoredBody | undefined> {
      const headers: Record<string, string> = {};
      if (getOptions.range !== undefined) {
        headers['range'] =
          getOptions.range.end === undefined
            ? `bytes=${String(getOptions.range.start)}-`
            : `bytes=${String(getOptions.range.start)}-${String(getOptions.range.end)}`;
      }
      const response = await signed('GET', objectUrl(key), headers, undefined);
      if (response.status === 404) return undefined;
      if (!response.ok) throw await failure('get', response);

      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        body: bytes,
        object: {
          ...objectOf(key, response.headers),
          // A ranged response reports the range's length, not the object's.
          size:
            response.status === 206
              ? // `bytes <start>-<end>/<total>`: the total is after the slash, and a server that
                // answers something else falls back to the bytes that actually arrived.
                (parseCount(response.headers.get('content-range')?.split('/')[1]) ?? bytes.length)
              : bytes.length,
        },
      };
    },

    async head(key) {
      const response = await signed('HEAD', objectUrl(key), {}, undefined);
      if (response.status === 404) return undefined;
      if (!response.ok) throw await failure('head', response);
      return objectOf(key, response.headers);
    },

    async delete(key) {
      const response = await signed('DELETE', objectUrl(key), {}, undefined);
      // S3 answers 204 for a delete of a key that was never there: the caller asked for "not
      // there", and it is not there. `false` is reserved for a backend that said so.
      if (response.status === 204 || response.status === 200) return true;
      if (response.status === 404) return false;
      throw await failure('delete', response);
    },

    async list(listOptions: ListOptions): Promise<ListResult> {
      const query: Record<string, string> = {
        'list-type': '2',
        'max-keys': String(Math.min(listOptions.limit ?? 1000, 1000)),
      };
      if (listOptions.prefix !== undefined && listOptions.prefix !== '') {
        query['prefix'] = listOptions.prefix;
      }
      if (listOptions.cursor !== undefined) query['continuation-token'] = listOptions.cursor;

      const response = await signed('GET', bucketUrl(query), {}, undefined);
      if (!response.ok) throw await failure('list', response);

      const parsed = parseListObjectsV2(await response.text());
      return {
        objects: parsed.objects.map((object) => ({
          key: object.key,
          size: object.size,
          contentType: DEFAULT_CONTENT_TYPE,
          etag: object.etag,
          ...(object.lastModified === undefined ? {} : { lastModified: object.lastModified }),
        })),
        ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      };
    },

    url(key) {
      if (options.publicBaseUrl === undefined) {
        // Unreachable through `Disk` (`publicUrls: false` refuses first). It throws rather than
        // returning the API URL, because that URL answers 403 to everyone without a signature.
        throw new TsirError(
          'STO_UNSUPPORTED_OPERATION',
          'a disk with no public base URL refuses `url()` first',
          { kind: 'capability' },
        );
      }
      return `${options.publicBaseUrl.replace(/\/+$/u, '')}/${key
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/')}`;
    },

    async temporaryUrl(key, expiresInMs) {
      const seconds = Math.min(Math.floor(expiresInMs / 1000), MAX_PRESIGN_SECONDS);
      return presignUrl({
        method: 'GET',
        url: objectUrl(key),
        expiresInSeconds: Math.max(seconds, 1),
        credentials: options.credentials,
        region: options.region,
        service: 's3',
        date: now(),
      });
    },
  };
}
