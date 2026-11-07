/**
 * The disk wrapper: key rules in **one** place, in front of every driver.
 *
 * A driver that validated its own keys would be a driver that forgets to — and the one that
 * forgets is `local`, where the key becomes a path. So the rules live here and are applied
 * before a driver method is called, which also means the same key is accepted or refused
 * whatever disk it lands on: moving a file from `s3` to `local` must not change whether its
 * name is legal.
 *
 * The rules, and why each one is not paranoia:
 *
 *   · **No leading `/`** — a key is relative to the disk's root. `/uploads/x` and `uploads/x`
 *     must not be two objects.
 *   · **No `.` or `..` segment** — the classic traversal, and it reaches the filesystem only on
 *     one driver, which is exactly why it cannot be that driver's job.
 *   · **No backslash** — `a\..\b` is a path on Windows and a literal name everywhere else. One
 *     key must mean one object on every backend.
 *   · **No control characters** — a `\n` in a key breaks every log line that prints it, and a
 *     `\0` truncates the filesystem path.
 *   · **Bounded length** (`maxKeyBytes`, 1024 by default) — S3's limit is 1024 bytes, and a
 *     local filesystem's is 255 *per component*. Refusing here means the failure is a message
 *     about the key rather than `ENAMETOOLONG` from three layers down.
 */

import { forbiddenInProduction, invalidKey, unsupportedOperation } from './errors.ts';
import type {
  Disk,
  DiskCapabilities,
  GetOptions,
  ListOptions,
  ListResult,
  PutOptions,
  StorageDriver,
  StoredBody,
  StoredObject,
  Visibility,
} from './port.ts';

/** S3's own limit, and a sane one for the rest: 1024 bytes of key. */
export const MAX_KEY_BYTES = 1024;

/** Refuse a key, or return it unchanged. Exported because `tsir storage:*` validates too. */
export function assertKey(key: string, disk: string, maxKeyBytes = MAX_KEY_BYTES): string {
  if (key === '') throw invalidKey(key, 'a key cannot be empty', disk);
  if (key.startsWith('/')) throw invalidKey(key, 'a key is relative to the disk root', disk);
  if (key.includes('\\')) {
    throw invalidKey(
      key,
      'a backslash is a path separator on one platform and a literal on others',
      disk,
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(key)) {
    throw invalidKey(key, 'control characters break log lines and truncate paths', disk);
  }
  for (const segment of key.split('/')) {
    if (segment === '') throw invalidKey(key, 'an empty path segment (`//`) names nothing', disk);
    if (segment === '.' || segment === '..') {
      throw invalidKey(key, `the segment "${segment}" can escape the disk root`, disk);
    }
  }
  const bytes = new TextEncoder().encode(key).length;
  if (bytes > maxKeyBytes) {
    throw invalidKey(
      key,
      `${String(bytes)} bytes is longer than this disk allows (${String(maxKeyBytes)})`,
      disk,
    );
  }
  return key;
}

/**
 * Wrap a driver as a `Disk`.
 *
 * The wrapper does three things and nothing else: validate the key, enforce the driver's own
 * declared capabilities (a `false` capability throws rather than degrading), and pass through.
 * Anything else here would be a second implementation of a driver.
 */
export function createDisk(input: {
  readonly name: string;
  readonly driver: StorageDriver;
  /** Overrides the default `temporaryUrl` lifetime: one hour. */
  readonly temporaryUrlTtlMs?: number | undefined;
}): Disk {
  const { driver, name } = input;
  const capabilities: DiskCapabilities = driver.capabilities;
  const defaultTtl = input.temporaryUrlTtlMs ?? 60 * 60_000;

  const key = (value: string): string => assertKey(value, name, capabilities.maxKeyBytes);

  const refuseUnless = (capability: boolean, operation: string, detail: string): void => {
    if (!capability) throw unsupportedOperation(operation, name, driver.name, detail);
  };

  return {
    name,
    driver: driver.name,
    capabilities,

    async put(rawKey: string, body: Uint8Array, options: PutOptions = {}): Promise<StoredObject> {
      const path = key(rawKey);
      if (!(body instanceof Uint8Array)) {
        // A `Buffer` is a `Uint8Array` and passes; a string does not, on purpose: the caller has
        // to say `utf8(...)` so the encoding is visible where the value is.
        throw new TypeError(
          `disk "${name}".put(${JSON.stringify(path)}) needs a Uint8Array — use \`utf8(text)\` for a string, so the encoding is at the call site`,
        );
      }
      // `ifNoneMatch` is the driver's promise to keep: S3 does it with `If-None-Match: *` in one
      // round trip, and the others check-then-write, which is a race — but a race the caller
      // asked for on a disk that has no alternative. The conformance kit tests both shapes.
      return driver.put(path, body, options);
    },

    async get(rawKey: string, options: GetOptions = {}): Promise<StoredBody | undefined> {
      const path = key(rawKey);
      if (options.range !== undefined) {
        refuseUnless(
          capabilities.rangeReads,
          'range reads',
          'this driver returns the whole object; read it and slice, or use a driver with range support',
        );
      }
      return driver.get(path, options);
    },

    head(rawKey: string): Promise<StoredObject | undefined> {
      return driver.head(key(rawKey));
    },

    async exists(rawKey: string): Promise<boolean> {
      return (await driver.head(key(rawKey))) !== undefined;
    },

    delete(rawKey: string): Promise<boolean> {
      return driver.delete(key(rawKey));
    },

    async list(options: ListOptions = {}): Promise<ListResult> {
      refuseUnless(capabilities.list, 'listing', 'this driver cannot enumerate its keys');
      if (options.prefix !== undefined && options.prefix !== '') {
        // A prefix is not a key: it may be a partial segment (`uploads/2026-`), so only the
        // traversal rules apply to it — not the "no empty segment" one.
        if (options.prefix.includes('..') || options.prefix.startsWith('/')) {
          throw invalidKey(
            options.prefix,
            'a list prefix is relative and cannot contain `..`',
            name,
          );
        }
      }
      if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
        throw new TypeError(`disk "${name}".list({ limit }) must be a positive integer`);
      }
      return driver.list(options);
    },

    async directories(prefix = ''): Promise<readonly string[]> {
      if (prefix !== '' && (prefix.includes('..') || prefix.startsWith('/'))) {
        throw invalidKey(prefix, 'a directory prefix is relative and cannot contain `..`', name);
      }
      return driver.directories(prefix);
    },

    async setVisibility(rawKey: string, visibility: Visibility): Promise<StoredObject> {
      if (visibility !== 'public' && visibility !== 'private') {
        throw new TypeError(`disk "${name}".setVisibility needs "public" or "private"`);
      }
      return driver.setVisibility(key(rawKey), visibility);
    },

    async copy(rawSource: string, rawDestination: string): Promise<StoredObject> {
      return driver.copy(key(rawSource), key(rawDestination));
    },

    async move(rawSource: string, rawDestination: string): Promise<StoredObject> {
      return driver.move(key(rawSource), key(rawDestination));
    },

    async stream(
      rawKey: string,
      options: GetOptions = {},
    ): Promise<ReadableStream<Uint8Array> | undefined> {
      const path = key(rawKey);
      if (options.range !== undefined) {
        refuseUnless(
          capabilities.rangeReads,
          'range reads',
          'this driver returns the whole object; read it and slice, or use a driver with range support',
        );
      }
      return driver.stream(path, options);
    },

    url(rawKey: string): string {
      const path = key(rawKey);
      refuseUnless(
        capabilities.publicUrls,
        'a public URL',
        'this disk has no public base URL — a private bucket answers 403 to an unsigned link, so returning one would be a link that only looks shareable',
      );
      return driver.url(path);
    },

    async temporaryUrl(rawKey: string, expiresInMs: number = defaultTtl): Promise<string> {
      const path = key(rawKey);
      refuseUnless(
        capabilities.signedUrls,
        'a signed URL',
        'this driver has no signing scheme; serve the bytes through your own route instead',
      );
      if (!Number.isFinite(expiresInMs) || expiresInMs <= 0) {
        throw new TypeError(`disk "${name}".temporaryUrl needs a positive lifetime in ms`);
      }
      return driver.temporaryUrl(path, expiresInMs);
    },
  };
}

/** A `memory` disk as the default is fine in dev and wrong in production. Boot-time check. */
export function assertDurable(disk: Disk): void {
  if (!disk.capabilities.persistent) throw forbiddenInProduction(disk.name, disk.driver);
}
