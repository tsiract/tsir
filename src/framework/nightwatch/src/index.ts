/**
 * @tsir/nightwatch — end-to-end testing.
 *
 * ```ts
 * import { createNightwatchBootstrap, inMemoryBackend } from '@tsir/nightwatch';
 *
 * const { backend } = createNightwatchBootstrap({ backend: inMemoryBackend() });
 * const page = await backend.newPage();
 * await page.goto('https://example.com');
 * await page.click('button');
 * ```
 */

export {
  inMemoryBackend,
  playwrightBackend,
  type BrowserBackend,
  type Page,
} from './nightwatch.ts';

export { createNightwatchBootstrap } from './bootstrap.ts';
export type { NightwatchBootstrap, NightwatchBootstrapOptions } from './bootstrap.ts';
