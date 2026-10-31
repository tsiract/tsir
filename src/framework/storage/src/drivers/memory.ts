/**
 * `memory` — a disk in one process's memory.
 *
 * It exists for tests, for `tsir storage:probe` in a fresh project, and for the one deployment
 * that runs a single long-lived Bun process. `persistent: false` and `shared: false` are the
 * whole story, and `createDisks({ production: true })` refuses it as the default — a disk that
 * forgets on restart is not a storage layer.
 *
 * Bytes are copied on the way in **and** on the way out. A caller that uploads a `Uint8Array`
 * and then reuses the buffer (a pooled read, a `Buffer` that gets overwritten) must not corrupt
 * what the disk is holding, and a caller that mutates what `get` returned must not corrupt it
 * either. Both copies are cheap next to the bug they prevent, and neither is a driver's
 * optimisation to skip.
 */

import { alreadyExists, unsupportedOperation } from '../errors.ts';
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

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

interface Entry {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
  readonly lastModified: number;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

const CAPABILITIES: DiskCapabilities = {
  persistent: false,
  sharedAcrossInstances: false,
  publicUrls: false,
  signedUrls: false,
  list: true,
  rangeReads: true,
  filesystem: false,
  maxKeyBytes: 1024,
};

/** A counter, not a clock: two writes in one millisecond must not share an `etag`. */
let sequence = 0;

function etagOf(body: Uint8Array): string {
  sequence += 1;
  // Length + a rolling 32-bit FNV-1a over the bytes + the sequence number. It is deliberately
  // not a real hash: this disk is not shared, so the only property `etag` needs is "changes when
  // the bytes change, and is stable while they do not".
  let hash = 0x811c9dc5;
  for (const byte of body) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `"${body.length.toString(16)}-${hash.toString(16)}-${sequence.toString(16)}"`;
}

function objectOf(key: string, entry: Entry): StoredObject {
  return {
    key,
    size: entry.body.length,
    contentType: entry.contentType,
    etag: entry.etag,
    lastModified: entry.lastModified,
    ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
  };
}

export function memoryDriver(options: { readonly name?: string } = {}): StorageDriver {
  const disk = options.name ?? 'memory';
  const objects = new Map<string, Entry>();

  return {
    name: 'memory',
    capabilities: CAPABILITIES,

    async put(key, body, putOptions: PutOptions): Promise<StoredObject> {
      if (putOptions.ifNoneMatch === true && objects.has(key)) throw alreadyExists(key, disk);
      const entry: Entry = {
        body: new Uint8Array(body),
        contentType: putOptions.contentType ?? DEFAULT_CONTENT_TYPE,
        etag: etagOf(body),
        lastModified: Date.now(),
        ...(putOptions.metadata === undefined ? {} : { metadata: putOptions.metadata }),
      };
      objects.set(key, entry);
      return objectOf(key, entry);
    },

    async get(key, options: GetOptions): Promise<StoredBody | undefined> {
      const entry = objects.get(key);
      if (entry === undefined) return undefined;
      const body =
        options.range === undefined
          ? new Uint8Array(entry.body)
          : new Uint8Array(
              entry.body.slice(
                options.range.start,
                options.range.end === undefined ? entry.body.length : options.range.end + 1,
              ),
            );
      return { body, object: objectOf(key, entry) };
    },

    async head(key) {
      const entry = objects.get(key);
      return entry === undefined ? undefined : objectOf(key, entry);
    },

    async delete(key) {
      return objects.delete(key);
    },

    async list(options: ListOptions): Promise<ListResult> {
      const prefix = options.prefix ?? '';
      const limit = Math.min(options.limit ?? 1000, 1000);
      // Keys are visited in insertion order, which is what makes the cursor stable between two
      // calls on an unmodified map — the same property S3 gives with a continuation token, and
      // the one a test that lists in pages depends on.
      const matched = [...objects.entries()].filter(([key]) => key.startsWith(prefix));
      const cursor = options.cursor;
      const found = cursor === undefined ? 0 : matched.findIndex(([key]) => key > cursor);
      const start = cursor === undefined ? 0 : found === -1 ? matched.length : found;
      const page = matched.slice(start, start + limit);
      const last = page.at(-1);
      return {
        objects: page.map(([key, entry]) => objectOf(key, entry)),
        ...(start + page.length < matched.length && last !== undefined ? { cursor: last[0] } : {}),
      };
    },

    /**
     * Unreachable through `Disk` — the wrapper refuses first, because `publicUrls` is false — and
     * still an error rather than a `memory://` string: a driver called directly is the one path
     * that would otherwise hand back a URL that means nothing anywhere else.
     */
    url() {
      throw unsupportedOperation('a public URL', disk, 'memory', 'a `Map` has no address');
    },

    async temporaryUrl() {
      throw unsupportedOperation('a signed URL', disk, 'memory', 'there is nothing to sign');
    },
  };
}
