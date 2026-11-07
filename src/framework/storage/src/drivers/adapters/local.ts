/**
 * `local` — a directory on the machine the process is running on.
 *
 * The driver that makes `node:fs` a deployment decision, so three things are deliberate:
 *
 *   · **`node:fs` is imported inside the call, not at the top of the module.** A Worker bundle
 *     that merely *declares* a local disk for development must still build; pulling `node:fs`
 *     into the graph would turn "this project has a dev disk" into a bundling failure that reads
 *     like a framework bug. When the disk is actually used on such a runtime, the answer is
 *     `STO_FILESYSTEM_UNAVAILABLE`, which says what to do.
 *   · **Writes are atomic.** `put` writes `<name>.<random>.tmp` beside the target and renames it
 *     over, so a reader never sees half a file and a crash mid-write never leaves a truncated
 *     object under the real name.
 *   · **The root is resolved once, and every path is checked against it.** The key rules in
 *     `disk.ts` already refuse `..`, and this is the second lock on the same door: a driver that
 *     trusted its caller for path safety would be one refactor away from a traversal.
 */

import { TsirError } from '@tsir/container';
import { dirname, join, resolve, sep } from 'node:path';
import type * as FsPromises from 'node:fs/promises';

import {
  alreadyExists,
  filesystemUnavailable,
  notFound,
  unsupportedOperation,
} from '../../errors.ts';
import { sha256Hex } from '../../sigv4.ts';
import type {
  DiskCapabilities,
  GetOptions,
  ListOptions,
  ListResult,
  PutOptions,
  StorageDriver,
  StoredBody,
  StoredObject,
  Visibility,
} from '../../port.ts';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const CAPABILITIES: DiskCapabilities = {
  persistent: true,
  sharedAcrossInstances: true,
  publicUrls: false,
  signedUrls: false,
  list: true,
  rangeReads: true,
  filesystem: true,
  maxKeyBytes: 1024,
};

/**
 * `node:fs/promises`, or a coded refusal.
 *
 * The import is textual here and executed lazily: a bundler sees `node:fs/promises` and stubs it
 * for a browser target (which is what `browser` means), and this function then fails with the
 * error a person can act on instead of `fs.readFile is not a function`.
 */
async function fsModule(disk: string): Promise<typeof FsPromises> {
  try {
    const module = await import('node:fs/promises');
    if (typeof module.readFile !== 'function')
      throw new TsirError('STO_FILESYSTEM_UNAVAILABLE', 'node:fs/promises has no readFile', {
        kind: 'capability',
      });
    return module;
  } catch {
    throw filesystemUnavailable(disk);
  }
}

/** Sidecar metadata: S3 returns a content type, a directory cannot, so it is stored beside it. */
interface Sidecar {
  readonly contentType: string;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  readonly visibility?: Visibility | undefined;
}

export interface LocalDriverOptions {
  /** The directory that is this disk's root. Created on first write, not at boot. */
  readonly root: string;
  /** The disk name, used in error messages. `local` by default. */
  readonly name?: string | undefined;
  /** Extension of the metadata sidecar. Defaults to `.tsir-meta`. */
  readonly sidecarSuffix?: string | undefined;
}

export function localDriver(options: LocalDriverOptions): StorageDriver {
  const disk = options.name ?? 'local';
  const root = resolve(options.root);
  const suffix = options.sidecarSuffix ?? '.tsir-meta';

  const absolute = (key: string): string => {
    const target = resolve(join(root, key));
    if (target !== root && !target.startsWith(root + sep)) {
      // Unreachable through `Disk` (the key rules run first). It stays because a driver that
      // trusts its caller is a driver whose safety depends on the caller's next change.
      throw filesystemUnavailable(disk);
    }
    return target;
  };

  const sidecarOf = (key: string): string => `${absolute(key)}${suffix}`;

  const readSidecar = async (key: string): Promise<Sidecar | undefined> => {
    const fs = await fsModule(disk);
    try {
      const text = await fs.readFile(sidecarOf(key), 'utf8');
      return JSON.parse(text) as Sidecar;
    } catch {
      // No sidecar is the normal case for a file someone copied in by hand, and a corrupt one
      // must not make the object unreadable: the type falls back to `octet-stream`.
      return undefined;
    }
  };

  const statOf = async (key: string): Promise<StoredObject | undefined> => {
    const fs = await fsModule(disk);
    try {
      const info = await fs.stat(absolute(key));
      if (!info.isFile()) return undefined;
      const sidecar = await readSidecar(key);
      // A SHA-256 of the contents, not of the path: it changes exactly when the bytes do, which
      // is the only guarantee an `etag` makes. Signed through WebCrypto, like the `s3` driver's
      // signatures — `node:crypto` is one builtin fewer in a bundle that only declared a dev disk.
      const digest = await sha256Hex(await fs.readFile(absolute(key)));
      // Public read bit on the group/other triplet is the closest filesystem analogue of a
      // public ACL: anyone who can reach the file can read it.
      const visibility: Visibility = (info.mode & 0o004) !== 0 ? 'public' : 'private';
      return {
        key,
        size: info.size,
        contentType: sidecar?.contentType ?? DEFAULT_CONTENT_TYPE,
        etag: `"${digest}"`,
        lastModified: Math.round(info.mtimeMs),
        visibility: sidecar?.visibility ?? visibility,
        ...(sidecar?.metadata === undefined ? {} : { metadata: sidecar.metadata }),
      };
    } catch {
      return undefined;
    }
  };

  return {
    name: 'local',
    capabilities: CAPABILITIES,

    async put(key, body, putOptions: PutOptions): Promise<StoredObject> {
      const fs = await fsModule(disk);
      const target = absolute(key);
      if (putOptions.ifNoneMatch === true) {
        const existing = await statOf(key);
        if (existing !== undefined) throw alreadyExists(key, disk);
      }

      await fs.mkdir(dirname(target), { recursive: true });
      // The global `crypto.randomUUID`, not `node:crypto`'s: WebCrypto is in every runtime this
      // package claims to run on, and `crypto` is a global in Bun, Node and Workers alike.
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, body);
      await fs.rename(temporary, target);

      const visibility = putOptions.visibility ?? 'private';
      // `0o644` = owner rw, group/other r (public); `0o600` = owner rw only (private).
      await fs.chmod(target, visibility === 'public' ? 0o644 : 0o600);

      const sidecar: Sidecar = {
        contentType: putOptions.contentType ?? DEFAULT_CONTENT_TYPE,
        visibility,
        ...(putOptions.metadata === undefined ? {} : { metadata: putOptions.metadata }),
      };
      await fs.writeFile(sidecarOf(key), JSON.stringify(sidecar), 'utf8');

      const stat = await statOf(key);
      if (stat === undefined) {
        throw new TsirError(
          'STO_REQUEST_FAILED',
          `disk "${disk}" wrote ${JSON.stringify(key)} and cannot stat it back`,
          { kind: 'capability' },
        );
      }
      return stat;
    },

    async get(key, getOptions: GetOptions): Promise<StoredBody | undefined> {
      const fs = await fsModule(disk);
      const stat = await statOf(key);
      if (stat === undefined) return undefined;
      const body = await fs.readFile(absolute(key));
      const bytes =
        getOptions.range === undefined
          ? new Uint8Array(body)
          : new Uint8Array(
              body.subarray(
                getOptions.range.start,
                getOptions.range.end === undefined ? body.length : getOptions.range.end + 1,
              ),
            );
      return { body: bytes, object: stat };
    },

    head: statOf,

    async delete(key) {
      const fs = await fsModule(disk);
      try {
        await fs.unlink(absolute(key));
      } catch {
        return false;
      }
      // The sidecar is not the object: failing to remove it must not report the delete failed.
      await fs.unlink(sidecarOf(key)).catch(() => undefined);
      return true;
    },

    async list(listOptions: ListOptions): Promise<ListResult> {
      const fs = await fsModule(disk);
      const prefix = listOptions.prefix ?? '';
      const limit = Math.min(listOptions.limit ?? 1000, 1000);

      const walk = async (directory: string, relative: string): Promise<string[]> => {
        let entries;
        try {
          entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
          return [];
        }
        const keys: string[] = [];
        for (const entry of entries) {
          const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
          if (entry.isDirectory()) {
            keys.push(...(await walk(join(directory, entry.name), childRelative)));
            continue;
          }
          if (entry.name.endsWith(suffix)) continue;
          keys.push(childRelative);
        }
        return keys;
      };

      const all = (await walk(root, '')).filter((key) => key.startsWith(prefix)).sort();
      const cursor = listOptions.cursor;
      const found = cursor === undefined ? 0 : all.findIndex((key) => key > cursor);
      const from = cursor === undefined ? 0 : found === -1 ? all.length : found;
      const page = all.slice(from, from + limit);

      const objects: StoredObject[] = [];
      for (const key of page) {
        const stat = await statOf(key);
        if (stat !== undefined) objects.push(stat);
      }
      const last = page.at(-1);
      return {
        objects,
        ...(from + page.length < all.length && last !== undefined ? { cursor: last } : {}),
      };
    },

    async directories(prefix = ''): Promise<readonly string[]> {
      const fs = await fsModule(disk);
      const normalized = prefix.replace(/\/+$/u, '');
      const base = normalized === '' ? root : absolute(normalized);
      let entries;
      try {
        entries = await fs.readdir(base, { withFileTypes: true });
      } catch {
        return [];
      }
      const dirs: string[] = [];
      const leading = normalized === '' ? '' : `${normalized}/`;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        dirs.push(`${leading}${entry.name}/`);
      }
      return dirs.sort();
    },

    async setVisibility(key: string, visibility: Visibility): Promise<StoredObject> {
      const fs = await fsModule(disk);
      const existing = await statOf(key);
      if (existing === undefined) throw notFound(key, disk);
      await fs.chmod(absolute(key), visibility === 'public' ? 0o644 : 0o600);
      const sidecar = (await readSidecar(key)) ?? { contentType: existing.contentType };
      const updated: Sidecar = { ...sidecar, visibility };
      await fs.writeFile(sidecarOf(key), JSON.stringify(updated), 'utf8');
      const stat = await statOf(key);
      if (stat === undefined) throw notFound(key, disk);
      return stat;
    },

    async copy(source: string, destination: string): Promise<StoredObject> {
      const fs = await fsModule(disk);
      const existing = await statOf(source);
      if (existing === undefined) throw notFound(source, disk);
      const target = absolute(destination);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.copyFile(absolute(source), target);
      // Mirror the source's sidecar and mode, so the copy has the same content type and ACL.
      const sidecar = await readSidecar(source);
      if (sidecar !== undefined) {
        await fs.writeFile(sidecarOf(destination), JSON.stringify(sidecar), 'utf8');
      }
      await fs.chmod(target, (existing.visibility ?? 'private') === 'public' ? 0o644 : 0o600);
      const stat = await statOf(destination);
      if (stat === undefined) throw notFound(destination, disk);
      return stat;
    },

    async move(source: string, destination: string): Promise<StoredObject> {
      const fs = await fsModule(disk);
      const existing = await statOf(source);
      if (existing === undefined) throw notFound(source, disk);
      const target = absolute(destination);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.rename(absolute(source), target);
      // Move the sidecar too, if one exists; otherwise the new object loses its content type.
      try {
        await fs.rename(sidecarOf(source), sidecarOf(destination));
      } catch {
        // No sidecar is the normal case for hand-copied files.
      }
      const stat = await statOf(destination);
      if (stat === undefined) throw notFound(destination, disk);
      return stat;
    },

    async stream(
      key: string,
      getOptions: GetOptions,
    ): Promise<ReadableStream<Uint8Array> | undefined> {
      const existing = await statOf(key);
      if (existing === undefined) return undefined;
      // The local driver reads the whole file into memory and wraps it. A true streaming
      // implementation would pipe `fs.createReadStream`, but that pulls `node:stream` into the
      // Worker bundle graph. For the contract a `ReadableStream` is what callers consume, and
      // `get` already proves the bytes fit in memory on this driver.
      const body = await this.get(key, getOptions);
      if (body === undefined) return undefined;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.body);
          controller.close();
        },
      });
    },

    /**
     * Unreachable through `Disk` — the wrapper refuses first, because `publicUrls` is false — and
     * still an error rather than a `file://` path: that path is not an address a browser can use,
     * and a URL that only works on the machine that wrote it is the classic local-vs-production
     * bug this port exists to make impossible.
     */
    url() {
      throw unsupportedOperation(
        'a public URL',
        disk,
        'local',
        'a filesystem path is not reachable from a browser; put a CDN in front or serve the bytes through a route',
      );
    },

    async temporaryUrl() {
      throw unsupportedOperation('a signed URL', disk, 'local', 'there is nothing to sign');
    },
  };
}
