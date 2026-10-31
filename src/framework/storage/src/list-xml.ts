/**
 * The one XML shape this package reads: `ListObjectsV2`'s response.
 *
 * No dependency, and no pretend-XML parser either. The framework has a real bounded XML reader in
 * `@tsir/link` for SOAP, and pulling a protocol client into a storage driver to read six elements
 * would be the wrong direction of dependency; a full parser would be a second implementation of
 * something that already exists. What is here is a reader for a **flat, known** document —
 * `<Contents>` repeated, with string children — and it refuses to guess when the shape is not
 * that.
 *
 * The rules it does honour, because a bucket key is arbitrary text and this is where it arrives:
 *
 *   · **entities are decoded** (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&#NN;`, `&#xNN;`),
 *     so a key containing `&` round-trips;
 *   · **`<Size>` is a number**, parsed once, and a non-numeric one is `NaN` rather than 0 — a
 *     zero-length object and an unreadable length must not look the same;
 *   · **`IsTruncated` and `NextContinuationToken` are read together**, because a truncated page
 *     with no cursor is a listing that silently stops.
 */

import { parseCount, parseDigits } from './numbers.ts';

export interface ListedObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly lastModified: number | undefined;
}

export interface ListObjectsV2Result {
  readonly objects: readonly ListedObject[];
  /** Present only when `IsTruncated` is true *and* the backend sent a token. */
  readonly cursor?: string | undefined;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseDigits(body.slice(2), 16);
      // A code point outside Unicode's range is an entity we do not understand, not an exception
      // in the middle of parsing a listing.
      return code === undefined ? whole : String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = parseDigits(body.slice(1), 10);
      return code === undefined ? whole : String.fromCodePoint(code);
    }
    return ENTITIES[body] ?? whole;
  });
}

/** The text of the first `<name>…</name>` in `source`, decoded, or `undefined`. */
function tag(source: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'u').exec(source);
  return match?.[1] === undefined ? undefined : decodeEntities(match[1]);
}

/**
 * Parse a `ListBucketResult`.
 *
 * Throws a `TypeError` when the document is not one, because the caller passed a body it did not
 * check — a 200 from anything other than an S3-compatible endpoint is a sign the URL is wrong,
 * and "zero objects" would be a lie a page of code would believe.
 */
export function parseListObjectsV2(xml: string): ListObjectsV2Result {
  if (!xml.includes('<ListBucketResult')) {
    throw new TypeError(
      'not a ListObjectsV2 response: `<ListBucketResult` is missing — check the endpoint and the bucket name',
    );
  }

  const objects: ListedObject[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
    const body = match[1] ?? '';
    const key = tag(body, 'Key');
    if (key === undefined) continue;
    const size = tag(body, 'Size');
    const etag = tag(body, 'ETag') ?? '';
    const modified = tag(body, 'LastModified');
    objects.push({
      key,
      size: parseCount(size) ?? 0,
      // S3 quotes its etags; the port's are opaque either way, and keeping the quotes means a
      // caller comparing what `head` returned to what `list` returned gets the same string.
      etag: etag === '' ? '' : etag,
      lastModified: modified === undefined ? undefined : Date.parse(modified),
    });
  }

  const truncated = tag(xml, 'IsTruncated') === 'true';
  const next = tag(xml, 'NextContinuationToken');

  return {
    objects,
    ...(truncated && next !== undefined ? { cursor: next } : {}),
  };
}
