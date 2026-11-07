/**
 * @tsir/nightwatch — end-to-end testing harness (Nightwatch/Playwright equivalent).
 *
 * Wraps a browser automation backend (Playwright or a built-in Bun-based
 * driver) behind a uniform API: `page.goto()`, `page.click()`, `page.fill()`,
 * `page.expect()`.
 *
 * The `playwrightBackend` requires `playwright` to be installed; the
 * `inMemoryBackend` is a stub for testing the harness itself.
 */

/** Minimal surface of Playwright we use. Declared here so the package does not
 *  force `playwright` into the dependency tree. */
interface PlaywrightPage {
  goto(url: string): Promise<unknown>;
  click(selector: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<unknown>;
  textContent(selector: string): Promise<string | null>;
  $(selector: string): Promise<unknown>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<unknown>;
}

interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<unknown>;
}

interface PlaywrightModule {
  readonly chromium: { launch(): Promise<PlaywrightBrowser> };
}

export interface Page {
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  text(selector: string): Promise<string>;
  exists(selector: string): Promise<boolean>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface BrowserBackend {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

/**
 * An in-memory backend that records calls and returns canned responses.
 * Useful for testing the harness and as a fallback when no real browser is
 * available.
 */
export function inMemoryBackend(): BrowserBackend {
  const pages: Page[] = [];

  function makePage(): Page {
    const state = { url: '', text: '' };
    return {
      async goto(url) {
        state.url = url;
      },
      async click(selector) {
        void selector;
      },
      async fill(selector, value) {
        void selector;
        void value;
      },
      async text() {
        return state.text;
      },
      async exists() {
        return true;
      },
      async screenshot() {
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      },
      async close() {},
    };
  }

  return {
    async newPage() {
      const p = makePage();
      pages.push(p);
      return p;
    },
    async close() {},
  };
}

/**
 * A Playwright-backed browser. Lazy-imports `playwright` so the package is
 * optional.
 */
export async function playwrightBackend(): Promise<BrowserBackend> {
  const { chromium } = (await import('playwright')) as PlaywrightModule;
  const browser = await chromium.launch();

  return {
    async newPage() {
      const pwPage = await browser.newPage();
      return {
        async goto(url) {
          await pwPage.goto(url);
        },
        async click(selector) {
          await pwPage.click(selector);
        },
        async fill(selector, value) {
          await pwPage.fill(selector, value);
        },
        async text(selector) {
          return (await pwPage.textContent(selector)) ?? '';
        },
        async exists(selector) {
          return (await pwPage.$(selector)) !== null;
        },
        async screenshot() {
          return new Uint8Array(await pwPage.screenshot());
        },
        async close() {
          await pwPage.close();
        },
      };
    },
    async close() {
      await browser.close();
    },
  };
}
