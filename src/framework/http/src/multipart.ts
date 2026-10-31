/**
 * `multipart/form-data` (VLD-006).
 *
 * Three things make this more than "call `request.formData()`":
 *
 * 1. **Limits are enforced before the parts are trusted.** `formData()` parses
 *    the whole body into memory, so the byte cap is applied first by reading
 *    through `readWithin` — the same counter every other body type uses.
 * 2. **File contents are sniffed.** A browser-supplied `type` is what the
 *    *client says* the file is. For images and PDFs the first bytes are what it
 *    actually is, and a mismatch is a 422 rather than a stored `.png` that is
 *    really a script.
 * 3. **Field names are deduplicated.** Repeated fields become arrays, exactly
 *    like repeated query parameters — one rule for both directions.
 *
 * Sniffing is a *signal*, not a scanner: it identifies a handful of formats
 * whose magic numbers are unambiguous and says nothing about the rest. It is
 * deliberately not an antivirus claim.
 */

export interface MultipartLimits {
  /** Whole-body cap, in bytes. Shared with `maxBodyBytes`. */
  readonly maxBytes: number;
  /** Per-file cap. Defaults to the body cap. */
  readonly maxFileBytes?: number;
  /** Maximum number of files across all parts. Defaults to 10. */
  readonly maxFiles?: number;
  /** Reject a part whose declared type disagrees with its bytes. Default: true. */
  readonly sniff?: boolean;
}

export type MultipartResult =
  | { readonly kind: 'parsed'; readonly value: Record<string, string | File | (string | File)[]> }
  | { readonly kind: 'too-large'; readonly bytes: number; readonly detail: string }
  | { readonly kind: 'malformed'; readonly detail: string }
  | {
      readonly kind: 'mime-mismatch';
      readonly field: string;
      readonly declared: string;
      readonly sniffed: string;
    };

/** Bytes needed to identify every format below. */
const SNIFF_BYTES = 12;

/**
 * Format detection by magic number.
 *
 * Ordered longest-signature-first so `RIFF….WEBP` is not reported as bare RIFF.
 * Text formats (SVG, CSV, plain text) have no reliable signature and are
 * therefore not in this table — sniffing them would be guesswork, and the
 * declared type is all we have.
 */
const SIGNATURES: readonly {
  readonly type: string;
  readonly bytes: readonly number[];
  readonly offset?: number;
}[] = [
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { type: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  // RIFF <size> WEBP — the tag sits at offset 8.
  { type: 'image/webp', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  // Ogg — audio and video share a container; audio is the common upload.
  { type: 'audio/ogg', bytes: [0x4f, 0x67, 0x67, 0x53] },
  // ID3-tagged MP3.
  { type: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
];

/** The type whose signature `bytes` carries, or `undefined` when unknown. */
export function sniffMimeType(bytes: Uint8Array): string | undefined {
  for (const signature of SIGNATURES) {
    const offset = signature.offset ?? 0;
    if (bytes.length < offset + signature.bytes.length) continue;
    let matched = true;
    for (const [index, expected] of signature.bytes.entries()) {
      if (bytes[offset + index] !== expected) {
        matched = false;
        break;
      }
    }
    if (matched) return signature.type;
  }
  return undefined;
}

async function sniff(file: File): Promise<string | undefined> {
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  return sniffMimeType(head);
}

/**
 * Reads a multipart body into a flat object of fields and files.
 *
 * Field order is preserved for repeated names; nothing is coerced to a number
 * here — that is the schema's job, as everywhere else.
 */
export async function readMultipart(
  request: Request,
  limits: MultipartLimits,
): Promise<MultipartResult> {
  const maxFiles = limits.maxFiles ?? 10;
  const maxFileBytes = limits.maxFileBytes ?? limits.maxBytes;
  const shouldSniff = limits.sniff ?? true;

  // Headers first: they are read before the body is consumed, never after.
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return { kind: 'malformed', detail: 'expected multipart/form-data' };
  }

  // Read through the byte counter first: `formData()` would otherwise consume an
  // unbounded stream before any limit could be checked.
  const body = await request.arrayBuffer();
  if (body.byteLength > limits.maxBytes) {
    return {
      kind: 'too-large',
      bytes: body.byteLength,
      detail: `multipart body exceeds ${limits.maxBytes} bytes`,
    };
  }

  // `formData()` is left un-annotated: Bun and DOM ship structurally identical
  // `FormData`/`File` types from different declarations, and naming one of them
  // picks a fight the value does not have.
  let form: Awaited<ReturnType<Request['formData']>>;
  try {
    form = await new Request('http://multipart.invalid/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    }).formData();
  } catch {
    return { kind: 'malformed', detail: 'multipart body could not be parsed' };
  }

  const out: Record<string, string | File | (string | File)[]> = {};
  let fileCount = 0;

  for (const [name, entry] of form.entries()) {
    // Same policy as the JSON body (`body.ts`): a field named like an object-prototype key is
    // refused, because assigning it onto the result rewrites that object's prototype.
    if (POLLUTION_NAMES.has(name)) {
      return { kind: 'malformed', detail: `form field "${name}" is a forbidden name` };
    }
    if (typeof entry === 'string') {
      append(out, name, entry);
      continue;
    }

    fileCount += 1;
    if (fileCount > maxFiles) {
      return {
        kind: 'too-large',
        bytes: maxFileBytes,
        detail: `more than ${maxFiles} files`,
      };
    }
    if (entry.size > maxFileBytes) {
      return {
        kind: 'too-large',
        bytes: entry.size,
        detail: `${name} exceeds ${maxFileBytes} bytes`,
      };
    }

    if (!shouldSniff) {
      append(out, name, entry);
      continue;
    }

    const sniffed = await sniff(entry);
    const declared = entry.type;

    // No signature (SVG, CSV, text) → nothing to contradict; trust the client.
    if (sniffed === undefined) {
      append(out, name, entry);
      continue;
    }
    // An empty declared type is a client that did not fill `type` in; adopting
    // the sniffed value is strictly more information, not a downgrade.
    if (declared === '' || declared === 'application/octet-stream') {
      append(out, name, new File([entry], entry.name, { type: sniffed }));
      continue;
    }
    if (declared !== sniffed) {
      return { kind: 'mime-mismatch', field: name, declared, sniffed };
    }
    append(out, name, entry);
  }

  return { kind: 'parsed', value: out };
}

/** Object-prototype names: refused as field names, the same rule `body.ts` applies to JSON keys. */
const POLLUTION_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function append(
  target: Record<string, string | File | (string | File)[]>,
  name: string,
  value: string | File,
): void {
  const existing = target[name];
  if (existing === undefined) {
    target[name] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  target[name] = [existing, value];
}
