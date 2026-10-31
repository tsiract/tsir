/**
 * The disk wrapper, the registry and the config half (`STOR-*`).
 *
 * Both real drivers (`memory`, `local`) run the **conformance kit** — the contract is the kit's,
 * not this file's — and what is left here is what only one of them can answer: the key rules and
 * their messages, the registry's refusals, the production check, and the `tsir.js` → driver
 * translation including an unset environment variable.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { disksFromConfig, STORAGE_DRIVERS } from './config.ts';
import { diskConformance } from './conformance.ts';
import { assertDurable, createDisk } from './disk.ts';
import { createDisks, defineDisk } from './disks.ts';
import { localDriver } from './drivers/adapters/local.ts';
import { memoryDriver } from './drivers/memory.ts';
import { text, utf8 } from './port.ts';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tsir-storage-'));
  roots.push(root);
  return root;
}

const memoryDisk = (): ReturnType<typeof createDisk> =>
  createDisk({ name: 'assets', driver: memoryDriver() });

describe('keys', () => {
  test('a key that can escape the disk root is refused before a driver sees it', () => {
    const disk = memoryDisk();
    const refuses = (key: string, pattern: RegExp): void => {
      expect(() => disk.url(key)).toThrow(pattern);
      try {
        disk.url(key);
      } catch (error: unknown) {
        expect((error as { code?: string }).code).toBe('STO_INVALID_KEY');
        expect((error as { context?: { disk?: string } }).context?.disk).toBe('assets');
      }
    };

    refuses('', /cannot be empty/u);
    refuses('/absolute', /relative to the disk root/u);
    refuses('a/../../etc/passwd', /escape the disk root/u);
    refuses('./a', /escape the disk root/u);
    refuses('a//b', /empty path segment/u);
    refuses('a\\b', /backslash/u);
    refuses('a\nb', /control characters/u);
    refuses('x'.repeat(1025), /longer than this disk allows/u);
  });

  test('the shapes a real project uses are accepted', () => {
    const disk = memoryDisk();
    for (const key of [
      'logo.png',
      'uploads/2026/11/report.pdf',
      'a.b:c-d_e/f g',
      'x'.repeat(1024),
    ]) {
      expect(() => disk.url(key)).toThrow(/does not support/u); // accepted, then refused for `url`
    }
  });

  test('a prefix is not a key: it may be a partial segment, but never traversal', async () => {
    const disk = memoryDisk();
    expect((await disk.list({ prefix: 'uploads/2026-' })).objects).toEqual([]);
    expect(disk.list({ prefix: '../x' })).rejects.toThrow(/cannot contain `\.\.`/u);
    expect(disk.list({ prefix: '/x' })).rejects.toThrow(/relative/u);
    expect(disk.list({ limit: 0 })).rejects.toThrow(/positive integer/u);
  });
});

describe('the wrapper', () => {
  test('a string is refused, because an encoding at the call site is the point', async () => {
    const disk = memoryDisk();
    expect(
      // @ts-expect-error -- the whole reason the port takes bytes: this must fail at run time too.
      disk.put('a.txt', 'text'),
    ).rejects.toThrow(/needs a Uint8Array/u);
    expect(disk.put('a.txt', utf8('text'))).resolves.toMatchObject({ size: 4 });
  });

  test('a false capability names the disk and the driver', async () => {
    const disk = memoryDisk();

    expect(() => disk.url('a.png')).toThrow(
      'disk "assets" (driver "memory") does not support a public URL',
    );
    expect(disk.temporaryUrl('a.png')).rejects.toThrow(/does not support a signed URL/u);
    // The capability is checked before the argument: a disk that cannot sign must not answer a
    // question about *how long* it would sign for.
    expect(disk.temporaryUrl('a.png', 0)).rejects.toThrow(/does not support a signed URL/u);
  });

  test('a default content type is stated, never guessed from the extension', async () => {
    const disk = memoryDisk();
    const stored = await disk.put('photo.jpg', new Uint8Array([0xff, 0xd8]));
    expect(stored.contentType).toBe('application/octet-stream');
  });
});

describe('the registry', () => {
  test('no disks is an error with the code that says how to declare one', () => {
    expect(() => createDisks({ disks: {} })).toThrow(/no storage disks are declared/u);
    try {
      createDisks({ disks: {} });
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe('STO_NO_DISKS');
    }
  });

  test('an undeclared name never falls back to the default', () => {
    const disks = createDisks({
      disks: {
        assets: defineDisk({ driver: memoryDriver() }),
        private: defineDisk({ driver: memoryDriver() }),
      },
      default: 'assets',
    });

    expect(disks.names).toEqual(['assets', 'private']);
    expect(disks.disk().name).toBe('assets');
    expect(disks.disk('private').name).toBe('private');
    try {
      disks.disk('nope');
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe('STO_UNKNOWN_DISK');
      expect((error as { message: string }).message).toContain('assets, private');
    }
  });

  test('a default that was never declared is refused, not silently replaced', () => {
    expect(() =>
      createDisks({ disks: { assets: defineDisk({ driver: memoryDriver() }) }, default: 's3' }),
    ).toThrow(/storage.default is "s3"/u);
  });

  test('production refuses an ephemeral default, and an ephemeral required disk', async () => {
    const root = await temporaryRoot();

    expect(() =>
      createDisks({ disks: { default: defineDisk({ driver: memoryDriver() }) }, production: true }),
    ).toThrow(/does not survive the process/u);

    expect(() =>
      createDisks({
        disks: {
          default: defineDisk({ driver: localDriver({ root }) }),
          cdn: defineDisk({ driver: memoryDriver(), required: true }),
        },
        production: true,
      }),
    ).toThrow(/disk "cdn" uses the "memory" driver/u);

    // A durable default passes, and so does an ephemeral disk nobody required.
    expect(() =>
      createDisks({
        disks: {
          default: defineDisk({ driver: localDriver({ root }) }),
          scratch: defineDisk({ driver: memoryDriver() }),
        },
        production: true,
      }),
    ).not.toThrow();
  });
});

describe('the conformance kit', () => {
  for (const case_ of diskConformance({ disk: memoryDisk() })) {
    test(`memory: ${case_.name}`, async () => {
      await case_.run();
    });
  }

  test('local: the whole kit, against a real directory', async () => {
    const root = await temporaryRoot();
    const disk = createDisk({ name: 'local', driver: localDriver({ root }) });
    for (const case_ of diskConformance({ disk })) {
      await case_.run();
    }
  });
});

describe('the local driver', () => {
  test('a nested key creates its directories, and the metadata sidecar is invisible', async () => {
    const root = await temporaryRoot();
    const disk = createDisk({ name: 'local', driver: localDriver({ root }) });

    await disk.put('uploads/2026/report.pdf', utf8('pdf bytes'), {
      contentType: 'application/pdf',
      metadata: { owner: 'billing' },
    });

    const onDisk = await readdir(join(root, 'uploads', '2026'));
    expect(onDisk.sort()).toEqual(['report.pdf', 'report.pdf.tsir-meta']);

    const listing = await disk.list();
    expect(listing.objects.map((object) => object.key)).toEqual(['uploads/2026/report.pdf']);
    expect(listing.objects[0]?.contentType).toBe('application/pdf');
    expect(listing.objects[0]?.metadata).toEqual({ owner: 'billing' });
  });

  test('the etag changes with the bytes, and only with the bytes', async () => {
    const root = await temporaryRoot();
    const disk = createDisk({ name: 'local', driver: localDriver({ root }) });

    const first = await disk.put('a.txt', utf8('one'));
    const same = await disk.put('a.txt', utf8('one'));
    const changed = await disk.put('a.txt', utf8('two'));

    expect(same.etag).toBe(first.etag);
    expect(changed.etag).not.toBe(first.etag);
  });

  test('a file placed by hand is still readable, with the default type', async () => {
    const root = await temporaryRoot();
    const disk = createDisk({ name: 'local', driver: localDriver({ root }) });
    await disk.put('a.txt', utf8('hello'));
    await rm(join(root, 'a.txt.tsir-meta'));

    const head = await disk.head('a.txt');
    expect(head?.contentType).toBe('application/octet-stream');
    expect((await disk.get('a.txt'))?.body.length).toBe(5);
  });
});

describe('`storage.disks` in tsir.js', () => {
  test('no block at all is a memory default — what makes `tsir storage:probe` runnable', () => {
    const disks = disksFromConfig();
    expect(disks.names).toEqual(['default']);
    expect(disks.disk().driver).toBe('memory');
  });

  test('local and s3 are built from config, with credentials read from the environment', () => {
    const disks = disksFromConfig({
      env: { R2_KEY: 'key-id', R2_SECRET: 'secret' },
      storage: {
        default: 'assets',
        disks: {
          assets: {
            driver: 's3',
            bucket: 'tsir-assets',
            endpoint: 'https://account.r2.cloudflarestorage.com',
            publicBaseUrl: 'https://cdn.example.com',
            credentials: {
              accessKeyId: { fromEnv: 'R2_KEY' },
              secretAccessKey: { fromEnv: 'R2_SECRET' },
            },
          },
          scratch: { driver: 'local', root: '/tmp/tsir-scratch' },
        },
      },
    });

    expect(disks.names).toEqual(['assets', 'scratch']);
    const assets = disks.disk('assets');
    expect(assets.driver).toBe('s3');
    expect(assets.capabilities).toMatchObject({ publicUrls: true, signedUrls: true });
    expect(assets.url('a/b.png')).toBe('https://cdn.example.com/a/b.png');
    expect(disks.disk('scratch').capabilities.filesystem).toBe(true);
  });

  test('an unset environment variable fails at boot, naming the variable', () => {
    const build = (): unknown =>
      disksFromConfig({
        env: {},
        storage: {
          disks: {
            assets: {
              driver: 's3',
              bucket: 'b',
              credentials: {
                accessKeyId: { fromEnv: 'R2_KEY' },
                secretAccessKey: { fromEnv: 'R2_SECRET' },
              },
            },
          },
        },
      });

    expect(build).toThrow(/credentials.accessKeyId reads `R2_KEY`, which is not set/u);
    try {
      build();
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe('STO_CONFIG_INVALID');
    }
  });

  test('a driver this build does not ship lists the ones it does', () => {
    expect(() => disksFromConfig({ storage: { disks: { x: { driver: 'gcs' } } } })).toThrow(
      new RegExp(`unknown storage driver "gcs".*${STORAGE_DRIVERS.join(', ')}`, 'u'),
    );
  });

  test('s3 without a bucket, and local without a root, say which setting is missing', () => {
    expect(() =>
      disksFromConfig({
        env: { K: 'k', S: 's' },
        storage: {
          disks: {
            a: {
              driver: 's3',
              credentials: { accessKeyId: { fromEnv: 'K' }, secretAccessKey: { fromEnv: 'S' } },
            },
          },
        },
      }),
    ).toThrow(/the `s3` driver needs a `bucket`/u);

    expect(() => disksFromConfig({ storage: { disks: { l: { driver: 'local' } } } })).toThrow(
      /the `local` driver needs a `root`/u,
    );
  });

  test('production refuses the memory default from config, with the same code', () => {
    expect(() => disksFromConfig({ production: true })).toThrow(/does not survive the process/u);
  });
});

describe('range reads, on both drivers that claim them', () => {
  test('memory slices the requested bytes and leaves the object alone', async () => {
    const disk = createDisk({ name: 'assets', driver: memoryDriver() });
    await disk.put('a.txt', utf8('0123456789'));

    const head = await disk.get('a.txt', { range: { start: 0, end: 2 } });
    expect(head?.body).toEqual(utf8('012'));
    // An open-ended range is the common case: `start` only means "to the end".
    const tail = await disk.get('a.txt', { range: { start: 7 } });
    expect(tail?.body).toEqual(utf8('789'));
    // The slice is a copy, not a window onto the stored bytes.
    (tail?.body as Uint8Array).fill(0);
    expect(text((await disk.get('a.txt', {}))?.body ?? new Uint8Array())).toBe('0123456789');
  });

  test('local reads a subarray of the file, and `size` is the object, not the slice', async () => {
    const root = await temporaryRoot();
    const disk = createDisk({ name: 'assets', driver: localDriver({ root }) });
    await disk.put('a.txt', utf8('0123456789'));

    const sliced = await disk.get('a.txt', { range: { start: 3, end: 4 } });
    expect(sliced?.body).toEqual(utf8('34'));
    expect(sliced?.object.size).toBe(10);
  });
});

describe('a driver called directly', () => {
  // The wrapper refuses these first, so this is about what a caller gets when it *bypasses* the
  // wrapper: an error with a code, never a URL that looks real and works nowhere.
  test('memory refuses a URL instead of inventing a memory:// scheme', () => {
    const driver = memoryDriver();
    expect(() => driver.url('a.png')).toThrow(/does not support a public URL/u);
    expect(driver.temporaryUrl('a.png', 1_000)).rejects.toMatchObject({
      code: 'STO_UNSUPPORTED_OPERATION',
    });
  });

  test('local refuses a file:// path, which is not an address a browser can use', async () => {
    const root = await temporaryRoot();
    const driver = localDriver({ root, name: 'assets' });

    expect(() => driver.url('a.png')).toThrow(
      /disk "assets" \(driver "local"\) does not support a public URL/u,
    );
    expect(driver.temporaryUrl('a.png', 1_000)).rejects.toMatchObject({
      code: 'STO_UNSUPPORTED_OPERATION',
    });
  });

  test('an ifNoneMatch on a taken key names the disk the driver was told it is', async () => {
    const root = await temporaryRoot();
    const disk = createDisk({ name: 'uploads', driver: localDriver({ root, name: 'uploads' }) });
    await disk.put('a.txt', utf8('one'));

    expect(disk.put('a.txt', utf8('two'), { ifNoneMatch: true })).rejects.toMatchObject({
      code: 'STO_ALREADY_EXISTS',
      message: expect.stringContaining('disk "uploads"') as unknown as string,
    });
    expect(text((await disk.get('a.txt', {}))?.body ?? new Uint8Array())).toBe('one');
  });
});

describe('the local sidecar', () => {
  test('metadata written by hand is what `head` reports, and a bad sidecar is not fatal', async () => {
    const root = await temporaryRoot();
    const disk = createDisk({ name: 'assets', driver: localDriver({ root }) });
    await disk.put('a.txt', utf8('hello'), { metadata: { owner: 'maria' } });

    // The sidecar is a file next to the object, so a person can write one — and a person can also
    // corrupt one. Neither is a reason to lose the object.
    await writeFile(join(root, 'a.txt.tsir-meta'), '{"contentType":"text/plain"}', 'utf8');
    expect((await disk.head('a.txt'))?.contentType).toBe('text/plain');
    expect((await disk.head('a.txt'))?.metadata).toBeUndefined();

    await writeFile(join(root, 'a.txt.tsir-meta'), 'not json', 'utf8');
    expect((await disk.head('a.txt'))?.contentType).toBe('application/octet-stream');

    // The sidecar never appears as an object, whatever is in it.
    const listed = (await disk.list({})).objects.map((object) => object.key);
    expect(listed).toEqual(['a.txt']);
    // The broken sidecar is left untouched, not rewritten on read.
    expect(await readFile(join(root, 'a.txt.tsir-meta'), 'utf8')).toBe('not json');
  });
});

describe('assertDurable', () => {
  test('it refuses a disk that forgets, and passes one that does not', async () => {
    const root = await temporaryRoot();

    expect(() => assertDurable(createDisk({ name: 'cache', driver: memoryDriver() }))).toThrow(
      'disk "cache" uses the "memory" driver, which does not survive the process — refused in production',
    );
    expect(() =>
      assertDurable(createDisk({ name: 'assets', driver: localDriver({ root }) })),
    ).not.toThrow();
  });

  test('`createDisks` only checks the default and the required disks, not every disk', () => {
    // A development disk beside a durable one is the ordinary case; refusing it would make
    // `production: true` unusable on the projects that most need the check.
    expect(() =>
      createDisks({
        disks: {
          assets: defineDisk({ driver: localDriver({ root: '/tmp/tsir-assets' }) }),
          scratch: defineDisk({ driver: memoryDriver() }),
        },
        default: 'assets',
        production: true,
      }),
    ).not.toThrow();

    expect(() =>
      createDisks({
        disks: {
          assets: defineDisk({ driver: localDriver({ root: '/tmp/tsir-assets' }) }),
          scratch: defineDisk({ driver: memoryDriver(), required: true }),
        },
        default: 'assets',
        production: true,
      }),
    ).toThrow(/disk "scratch" uses the "memory" driver/u);
  });
});
