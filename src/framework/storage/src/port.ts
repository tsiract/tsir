/**
 * The storage port (`CAP-001`).
 *
 * A disk stores **bytes**, and that is the whole contract. There is no codec here and no
 * `JSON.parse` anywhere in this package: the cache owns serialization because a cache value is
 * a typed thing with a lifetime, while an object is a file with a content type and a length.
 * A storage layer that guessed would turn an uploaded JPEG into `text/plain` the first time
 * nobody set a header — and the bug would surface as a broken image, not an error.
 *
 * Five decisions are load-bearing:
 *
 *   · **A missing key is `undefined`, not an exception.** `get` and `head` answer "is it there"
 *     with a value or nothing. Throwing would make the common case (`if (!exists) upload`)
 *     a `try`/`catch`, which is how a 404 becomes a swallowed bug.
 *   · **`put` takes bytes, never a string.** A string silently becomes UTF-8, and then a binary
 *     upload is corrupted by a layer nobody looked at.
 *   · **`etag` is opaque.** S3's is an MD5 of the parts, R2's matches it, a local file's is a
 *     SHA-256 of the contents, and `memory`'s is a length-prefixed hash: the caller compares
 *     them and never parses one.
 *   · **`list` is bounded and paginated.** A bucket with a million keys must not become a
 *     million-row array because someone called `list()` in a request handler.
 *   · **A URL says what it is.** `url()` is a public URL — and refuses where the disk cannot
 *     serve one; `temporaryUrl()` is signed, and refuses on a driver with no signing scheme
 *     (`CAP_UNSUPPORTED_OPERATION`, both names in the message). A disk that quietly returned an
 *     unsigned URL to a private bucket would be a data leak with a passing test.
 */

/** What one disk's driver can actually do. **Per disk, not per driver** (`§ 2.2`). */
export interface DiskCapabilities {
  /** Survives the process. `false` for `memory`. */
  readonly persistent: boolean;
  /** Visible to other instances. `false` for `memory`. */
  readonly sharedAcrossInstances: boolean;
  /** `url()` answers without credentials — a public bucket or a CDN in front of one. */
  readonly publicUrls: boolean;
  /** `temporaryUrl()` can sign. `false` for `local` and `memory`, which have nothing to sign with. */
  readonly signedUrls: boolean;
  /** `list()` is implemented rather than emulated with a scan of the process's own keys. */
  readonly list: boolean;
  /** `get({ range })` is a real byte-range read, not a full body sliced in the client. */
  readonly rangeReads: boolean;
  /**
   * The driver needs a filesystem. `false` everywhere except `local` — and the reason a Worker
   * calling a `local` disk gets `STO_FILESYSTEM_UNAVAILABLE` instead of a module-resolution
   * error from inside a bundler.
   */
  readonly filesystem: boolean;
  /** Longest key the backend accepts, in bytes. Keys are validated against it before the call. */
  readonly maxKeyBytes: number;
}

export interface PutOptions {
  /** Defaults to `application/octet-stream` — never guessed from the key's extension. */
  readonly contentType?: string | undefined;
  readonly cacheControl?: string | undefined;
  /** Arbitrary user metadata. S3 lowercases the names; the driver does not reformat them. */
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  /** Refuse an existing key with `STO_ALREADY_EXISTS` instead of replacing it. */
  readonly ifNoneMatch?: boolean | undefined;
  /**
   * Object ACL. `public` means an unauthenticated reader can fetch it; `private` is the default.
   * Local maps this to file mode bits; S3 maps it to a canned ACL.
   */
  readonly visibility?: Visibility | undefined;
}

/** Whether an object can be read without credentials. */
export type Visibility = 'public' | 'private';

/** What the backend knows about an object. What `head` returns, and what `list` reports. */
export interface StoredObject {
  /** The key, relative to the disk's root. Never begins with `/`. */
  readonly key: string;
  readonly size: number;
  /** Defaults to `application/octet-stream` when the backend stored no type. */
  readonly contentType: string;
  /** Opaque: compare it, never parse it. */
  readonly etag: string;
  /** Epoch ms, when the backend knows it. */
  readonly lastModified?: number | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  /** Object ACL, when the backend tracks it. */
  readonly visibility?: Visibility | undefined;
}

/** A body plus what is known about it. `get` returns this, or `undefined`. */
export interface StoredBody {
  readonly body: Uint8Array;
  readonly object: StoredObject;
}

export interface GetOptions {
  /** Inclusive byte range. Refused where `rangeReads` is false, rather than sliced client-side. */
  readonly range?: { readonly start: number; readonly end?: number | undefined } | undefined;
}

export interface ListOptions {
  /** Only keys beginning with this. `''` and `undefined` mean the whole disk. */
  readonly prefix?: string | undefined;
  /** Page size. Backends have their own maxima; this is the ceiling, not a promise. */
  readonly limit?: number | undefined;
  /** Where the previous page ended — opaque, from `ListResult.cursor`. */
  readonly cursor?: string | undefined;
}

export interface ListResult {
  readonly objects: readonly StoredObject[];
  /** Present when there is another page. Opaque: hand it back, do not build one. */
  readonly cursor?: string | undefined;
}

/** What a driver implements. One instance per disk; the disk wrapper adds the key rules. */
export interface StorageDriver {
  /** The driver's name as `tsir.js` writes it: `memory`, `local`, `s3`. */
  readonly name: string;
  readonly capabilities: DiskCapabilities;

  put(key: string, body: Uint8Array, options: PutOptions): Promise<StoredObject>;
  get(key: string, options: GetOptions): Promise<StoredBody | undefined>;
  head(key: string): Promise<StoredObject | undefined>;
  delete(key: string): Promise<boolean>;
  list(options: ListOptions): Promise<ListResult>;
  /**
   * Immediate subdirectories (relative keys ending in `/`) under `prefix`. The default
   * implementation returns an empty array; drivers with real directory semantics implement it.
   */
  directories(prefix?: string): Promise<readonly string[]>;
  /** Change an object's ACL in place. No-op on drivers that do not track visibility. */
  setVisibility(key: string, visibility: Visibility): Promise<StoredObject>;
  /** Copy an object within the same disk. Source and dest may be different keys. */
  copy(source: string, destination: string): Promise<StoredObject>;
  /** Move an object within the same disk (copy + delete source). */
  move(source: string, destination: string): Promise<StoredObject>;
  /**
   * Stream an object's bytes. Returns `undefined` when the key does not exist.
   * Drivers without streaming support throw `CAP_UNSUPPORTED_OPERATION`.
   */
  stream(key: string, options: GetOptions): Promise<ReadableStream<Uint8Array> | undefined>;
  /** A public URL. Throws `CAP_UNSUPPORTED_OPERATION` where `publicUrls` is false. */
  url(key: string): string;
  /** A URL that expires. Throws where `signedUrls` is false. */
  temporaryUrl(key: string, expiresInMs: number): Promise<string>;
}

/**
 * One named disk, as application code sees it.
 *
 * Structurally the driver plus `exists`, minus nothing — the wrapper's whole job is to validate
 * the key before any driver sees it and to turn a driver's `false` capability into a coded error
 * with the disk and the driver in the message.
 */
export interface Disk {
  readonly name: string;
  readonly driver: string;
  readonly capabilities: DiskCapabilities;

  put(key: string, body: Uint8Array, options?: PutOptions): Promise<StoredObject>;
  get(key: string, options?: GetOptions): Promise<StoredBody | undefined>;
  head(key: string): Promise<StoredObject | undefined>;
  /** Convenience over `head`, and the question callers actually ask. */
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  list(options?: ListOptions): Promise<ListResult>;
  /** Immediate subdirectories (relative keys ending in `/`) under `prefix`. */
  directories(prefix?: string): Promise<readonly string[]>;
  /** Change an object's ACL in place. No-op on drivers that do not track visibility. */
  setVisibility(key: string, visibility: Visibility): Promise<StoredObject>;
  /** Copy an object within the same disk. */
  copy(source: string, destination: string): Promise<StoredObject>;
  /** Move an object within the same disk (copy + delete source). */
  move(source: string, destination: string): Promise<StoredObject>;
  /** Stream an object's bytes. Returns `undefined` when the key does not exist. */
  stream(key: string, options?: GetOptions): Promise<ReadableStream<Uint8Array> | undefined>;
  url(key: string): string;
  temporaryUrl(key: string, expiresInMs?: number): Promise<string>;
}

/** `put` from a string, explicitly. The only place a string becomes bytes. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The reverse of `utf8`, for the callers that stored text and know it. */
export function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
