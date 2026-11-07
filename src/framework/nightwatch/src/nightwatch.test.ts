import { describe, expect, test } from 'bun:test';
import { inMemoryBackend } from './index.ts';

describe('nightwatch in-memory backend', () => {
  test('creates and closes pages', async () => {
    const b = inMemoryBackend();
    const page = await b.newPage();
    await page.goto('https://example.com');
    expect(await page.exists('body')).toBe(true);
    await page.close();
  });

  test('screenshot returns a buffer', async () => {
    const b = inMemoryBackend();
    const page = await b.newPage();
    const shot = await page.screenshot();
    expect(shot.length).toBeGreaterThan(0);
  });

  test('click and fill do not throw', async () => {
    const b = inMemoryBackend();
    const page = await b.newPage();
    await page.click('button');
    await page.fill('input', 'hello');
    expect(await page.text('body')).toBe('');
  });
});
