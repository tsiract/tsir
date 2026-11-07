/**
 * The disk conformance kit (`CAP-005`, `§ 5`).
 *
 * Every driver must satisfy the same object-storage contract, and the contract is written once
 * here as **data**: named cases, each a function that throws on violation. No test framework is
 * imported, so a third-party driver author can run this under whatever runner they already have:
 *
 * ```ts
 * import { diskConformance } from '@tsir/storage/conformance';
 * for (const c of diskConformance({ disk: myDisk() })) test(c.name, () => c.run());
 * ```
 *
 * The seven properties, each of which is invisible until it is wrong:
 *
 *   · **bytes round-trip exactly** — a driver that decodes UTF-8 somewhere is a driver that
 *     corrupts every JPEG, and every text-based test passes anyway;
 *   · **a missing key is `undefined`**, not an exception and not an empty object;
 *   · **the metadata survives** — content type, size, etag, and user metadata;
 *   · **`delete` is honest** — `true` once, `false` the second time;
 *   · **`list` is prefix-scoped and paginates without losing a key**;
 *   · **`ifNoneMatch` refuses a rival write**;
 *   · **a false capability throws** rather than degrading to something that looks like it worked.
 *
 * What it cannot check is durability: every case runs against one instance, and a driver that
 * forgets an object at process exit passes all seven. That is the driver's declaration to make —
 * `persistent` in `capabilities` — and `assertDurable` is what a production boot reads it with.
 */

import type { Disk } from './port.ts';

export interface ConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface DiskConformanceOptions {
  readonly disk: Disk;
  /** Prefix for the keys a case writes. Randomised per run so parallel suites do not collide. */
  readonly prefix?: string | undefined;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const NON_ASCII = new Uint8Array([0x00, 0x41, 0xff, 0xfe, 0x42, 0x80]);

export function diskConformance(options: DiskConformanceOptions): readonly ConformanceCase[] {
  const { disk } = options;
  const prefix = options.prefix ?? `conformance-${crypto.randomUUID()}`;
  let cases = 0;
  const keyFor = (label: string): string => `${prefix}/${String((cases += 1))}-${label}`;

  const put = async (key: string, body: string | Uint8Array, contentType?: string) => {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    return disk.put(key, bytes, contentType === undefined ? {} : { contentType });
  };

  return [
    {
      name: 'bytes round-trip exactly, including every non-ASCII byte',
      async run() {
        const key = keyFor('bytes');
        await put(key, NON_ASCII, 'application/octet-stream');
        const stored = await disk.get(key);
        assert(stored !== undefined, 'get() returned undefined for a key that was just written');
        assert(
          stored.body.length === NON_ASCII.length &&
            stored.body.every((byte, index) => byte === NON_ASCII[index]),
          `bytes changed in transit: wrote ${[...NON_ASCII].join(',')} and read ${[...stored.body].join(',')}`,
        );
        await disk.delete(key);
      },
    },

    {
      name: 'a missing key is undefined, not an exception and not an empty object',
      async run() {
        const key = keyFor('missing');
        assert(
          (await disk.get(key)) === undefined,
          'get() answered for a key that was never written',
        );
        assert(
          (await disk.head(key)) === undefined,
          'head() answered for a key that was never written',
        );
        assert(
          (await disk.exists(key)) === false,
          'exists() said yes to a key that was never written',
        );
      },
    },

    {
      name: 'head reports the size, the content type and the etag',
      async run() {
        const key = keyFor('head');
        const body = 'hello, conformance';
        const written = await put(key, body, 'text/plain; charset=utf-8');
        const head = await disk.head(key);
        assert(head !== undefined, 'head() returned undefined for a key that was just written');
        assert(
          head.size === new TextEncoder().encode(body).length,
          `size was ${String(head.size)}`,
        );
        assert(head.contentType.startsWith('text/plain'), `contentType was "${head.contentType}"`);
        assert(head.etag !== '', 'etag was empty');
        assert(
          head.etag === written.etag,
          `head etag "${head.etag}" != put etag "${written.etag}"`,
        );
        await disk.delete(key);
      },
    },

    {
      name: 'delete is true once and false afterwards',
      async run() {
        const key = keyFor('delete');
        await put(key, 'x');
        assert((await disk.delete(key)) === true, 'delete() said false for a key that existed');
        assert((await disk.delete(key)) === false, 'delete() said true for a key already gone');
      },
    },

    {
      name: 'put replaces by default and refuses with ifNoneMatch',
      async run() {
        const key = keyFor('ifnone');
        await put(key, 'first');
        await put(key, 'second');
        const replaced = await disk.get(key);
        assert(replaced !== undefined, 'get() lost the key after a replace');
        assert(
          new TextDecoder().decode(replaced.body) === 'second',
          'a second put did not replace the first',
        );

        let refused = false;
        try {
          await disk.put(key, new TextEncoder().encode('third'), { ifNoneMatch: true });
        } catch (error: unknown) {
          refused = (error as { code?: string }).code === 'STO_ALREADY_EXISTS';
        }
        assert(refused, 'put({ ifNoneMatch: true }) did not raise STO_ALREADY_EXISTS');
        await disk.delete(key);
      },
    },

    {
      name: 'list is prefix-scoped and pages without losing a key',
      async run() {
        const scope = keyFor('list');
        const keys = ['a', 'b', 'c', 'd'].map((suffix) => `${scope}/${suffix}.txt`);
        for (const key of keys) await put(key, key);
        await put(`${scope}-other/outside.txt`, 'x');

        const seen: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 10; page += 1) {
          const result = await disk.list({
            prefix: `${scope}/`,
            limit: 2,
            ...(cursor === undefined ? {} : { cursor }),
          });
          seen.push(...result.objects.map((object) => object.key));
          cursor = result.cursor;
          if (cursor === undefined) break;
        }

        assert(
          seen.length === keys.length,
          `paged listing returned ${String(seen.length)} of ${String(keys.length)} keys`,
        );
        assert(
          keys.every((key) => seen.includes(key)),
          `paged listing lost a key: saw ${seen.join(', ')}`,
        );
        assert(!seen.some((key) => key.endsWith('outside.txt')), 'a listing escaped its prefix');
        for (const key of keys) await disk.delete(key);
        await disk.delete(`${scope}-other/outside.txt`);
      },
    },

    {
      name: 'a capability declared false throws instead of degrading',
      async run() {
        if (!disk.capabilities.publicUrls) {
          let threw = false;
          try {
            disk.url(keyFor('url'));
          } catch (error: unknown) {
            threw = (error as { code?: string }).code === 'STO_UNSUPPORTED_OPERATION';
          }
          assert(threw, 'url() answered on a disk that declared publicUrls: false');
        }
        if (!disk.capabilities.signedUrls) {
          let threw = false;
          try {
            await disk.temporaryUrl(keyFor('signed'));
          } catch (error: unknown) {
            threw = (error as { code?: string }).code === 'STO_UNSUPPORTED_OPERATION';
          }
          assert(threw, 'temporaryUrl() answered on a disk that declared signedUrls: false');
        }
      },
    },

    {
      name: 'copy duplicates an object under a new key and leaves the source intact',
      async run() {
        const source = keyFor('copy-source');
        const dest = keyFor('copy-dest');
        await put(source, 'copy me', 'text/plain');
        const copied = await disk.copy(source, dest);
        assert(copied.key === dest, `copy() returned key "${copied.key}" not "${dest}"`);
        const sourceBody = await disk.get(source);
        assert(sourceBody !== undefined, 'copy() deleted the source');
        const destBody = await disk.get(dest);
        assert(destBody !== undefined, 'copy() did not create the destination');
        assert(
          new TextDecoder().decode(destBody.body) === 'copy me',
          'the copied bytes differ from the source',
        );
        await disk.delete(source);
        await disk.delete(dest);
      },
    },

    {
      name: 'move relocates an object: the destination has the bytes and the source is gone',
      async run() {
        const source = keyFor('move-source');
        const dest = keyFor('move-dest');
        await put(source, 'move me', 'text/plain');
        const moved = await disk.move(source, dest);
        assert(moved.key === dest, `move() returned key "${moved.key}" not "${dest}"`);
        const destBody = await disk.get(dest);
        assert(destBody !== undefined, 'move() did not create the destination');
        assert(
          new TextDecoder().decode(destBody.body) === 'move me',
          'the moved bytes differ from the source',
        );
        assert((await disk.get(source)) === undefined, 'move() left the source in place');
        await disk.delete(dest);
      },
    },

    {
      name: 'setVisibility changes the ACL in place and reports it back',
      async run() {
        const key = keyFor('visibility');
        await put(key, 'visible', 'text/plain');
        const published = await disk.setVisibility(key, 'public');
        assert(
          published.visibility === 'public',
          `setVisibility(public) reported "${String(published.visibility)}"`,
        );
        const privated = await disk.setVisibility(key, 'private');
        assert(
          privated.visibility === 'private',
          `setVisibility(private) reported "${String(privated.visibility)}"`,
        );
        await disk.delete(key);
      },
    },

    {
      name: 'directories lists immediate subdirectories under a prefix',
      async run() {
        const scope = keyFor('dirs');
        await put(`${scope}/a/one.txt`, '1');
        await put(`${scope}/a/two.txt`, '2');
        await put(`${scope}/b/three.txt`, '3');
        await put(`${scope}/a/nested/deep.txt`, '4');
        const dirs = await disk.directories(`${scope}/`);
        assert(
          dirs.includes(`${scope}/a/`) && dirs.includes(`${scope}/b/`),
          `directories() did not list a/ and b/: got ${dirs.join(', ')}`,
        );
        assert(
          !dirs.some((dir) => dir.endsWith('nested/')),
          'directories() listed a nested directory, not just immediate children',
        );
        await disk.delete(`${scope}/a/one.txt`);
        await disk.delete(`${scope}/a/two.txt`);
        await disk.delete(`${scope}/b/three.txt`);
        await disk.delete(`${scope}/a/nested/deep.txt`);
      },
    },

    {
      name: 'stream yields the same bytes as get',
      async run() {
        const key = keyFor('stream');
        const body = 'stream these bytes';
        await put(key, body, 'text/plain');
        const stream = await disk.stream(key);
        assert(stream !== undefined, 'stream() returned undefined for a key that exists');
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          chunks.push(result.value);
          total += result.value.length;
        }
        const reassembled = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          reassembled.set(chunk, offset);
          offset += chunk.length;
        }
        assert(
          new TextDecoder().decode(reassembled) === body,
          'streamed bytes do not match what was written',
        );
        await disk.delete(key);
      },
    },
  ];
}
