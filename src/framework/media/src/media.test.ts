import { describe, expect, test } from 'bun:test';
import { createMediaManager, type MediaAdapter, type ProcessResult } from './index.ts';

function stubAdapter(name: string, kind: 'image' | 'video'): MediaAdapter {
  return {
    name,
    kind,
    async process(input) {
      return {
        data: input,
        contentType: kind === 'image' ? 'image/webp' : 'video/mp4',
        size: input.length,
      };
    },
  };
}

describe('media manager', () => {
  test('routes by kind', async () => {
    const m = createMediaManager([stubAdapter('img', 'image'), stubAdapter('vid', 'video')]);
    const out = await m.process('image', new Uint8Array([1, 2, 3]), {});
    expect(out.contentType).toBe('image/webp');
  });

  test('throws when no adapter for kind', async () => {
    const m = createMediaManager([stubAdapter('img', 'image')]);
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(m.process('video', new Uint8Array(), {})).rejects.toThrow(/video/);
  });

  test('adapter lookup by name', () => {
    const m = createMediaManager([stubAdapter('img', 'image')]);
    expect(m.adapter('img')).toBeDefined();
    expect(m.adapter('nope')).toBeUndefined();
  });

  test('uses first adapter per kind', async () => {
    const a = stubAdapter('a', 'image');
    const b = stubAdapter('b', 'image');
    const m = createMediaManager([a, b]);
    const out: ProcessResult = await m.process('image', new Uint8Array([1]), {});
    expect(out.contentType).toBe('image/webp');
  });
});
