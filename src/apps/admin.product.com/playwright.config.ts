import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the admin application.
 *
 * The `webServer` boots `serve.ts` (a standalone Bun server that runs the admin
 * handler with a local SQLite-backed D1 binding) on port 4173 before the
 * tests start, then tears it down. No Cloudflare account or `wrangler` needed.
 *
 * `serve.ts --reset-db` wipes the local SQLite file on boot so every test run
 * starts from a clean schema (migrations run immediately after). This is done
 * inside the server process — not a separate `globalSetup` — because Playwright
 * starts `webServer` before `globalSetup`, and deleting the DB file while the
 * server holds it open causes `SQLITE_IOERR_VNODE`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun serve.ts --port 4173 --reset-db',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
