import { describe, expect, test } from 'bun:test';
import { memoryEngine } from './index.ts';

describe('scout memory engine', () => {
  test('indexes and searches', async () => {
    const e = memoryEngine();
    await e.index({ id: '1', fields: { title: 'hello world' } });
    await e.index({ id: '2', fields: { title: 'goodbye world' } });
    const hits = await e.search('hello');
    expect(hits.map((h) => h.id)).toEqual(['1']);
  });

  test('returns empty for no match', async () => {
    const e = memoryEngine();
    await e.index({ id: '1', fields: { title: 'hello' } });
    expect(await e.search('xyz')).toEqual([]);
  });

  test('removes documents', async () => {
    const e = memoryEngine();
    await e.index({ id: '1', fields: { title: 'hello' } });
    await e.remove('1');
    expect(await e.search('hello')).toEqual([]);
  });

  test('ranks by match count', async () => {
    const e = memoryEngine();
    await e.index({ id: '1', fields: { title: 'hello hello world' } });
    await e.index({ id: '2', fields: { title: 'hello world' } });
    const hits = await e.search('hello world');
    expect(hits[0]?.id).toBe('1');
  });
});
