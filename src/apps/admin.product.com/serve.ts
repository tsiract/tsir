/**
 * Standalone dev server for the admin application.
 *
 * Runs the admin app's `handler` with a local SQLite-backed D1 binding so
 * `playwright` (and manual testing) don't need Cloudflare or the full monorepo
 * dev server. The schema is applied with `@tsir/migrate` on boot — never raw
 * SQL, so the dev path exercises the same migration runner production uses.
 *
 * The handler already serves static files from `public/` and falls back to
 * `index.html` for the SPA, so this server is a thin shim that only supplies
 * the binding and runs migrations.
 *
 * Usage:
 *   bun serve.ts [--port 4173]
 */
// serve.ts is the dev server entry point: console is its reporting surface
// (startup banner, migration progress, runtime errors). The framework logger is
// for application code; this boundary deliberately talks directly to the terminal.
/* eslint-disable no-console */
import { Database as Sqlite } from 'bun:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createSqliteBinding } from '@tsir/database';
import { migrate } from '@tsir/migrate';

// Local dev doesn't have Cloudflare Turnstile; skip captcha verification so the
// login form (and its e2e tests) work without a secret. This must be set before
// the app modules are loaded (they read it at import time).
process.env.CAPTCHA_DISABLED = 'true';

// Use dynamic import so the env var above is in effect when app modules load.
const { handler, runtimeBindings, databases, MIGRATIONS_DIR } = await import('./app.ts');

const DEFAULT_PORT = 4173;
const APP_DIR = import.meta.dir;

// ── Argument parsing ───────────────────────────────────────────────────────────

function parsePort(argv: string[]): number {
  const portFlag = argv.indexOf('--port');
  if (portFlag !== -1) {
    const raw = argv[portFlag + 1];
    if (raw !== undefined) {
      // coercion-ok: a CLI flag is the one place a string is *meant* to be a number;
      // the radix and range check below reject anything that is not a real port.
      const n = parseInt(raw, 10);
      if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    }
  }
  return DEFAULT_PORT;
}

// ── Boot ───────────────────────────────────────────────────────────────────────

const port = parsePort(process.argv.slice(2));

// Open (or create) the local SQLite store.
const dbDir = join(APP_DIR, '..', '..', '..', '.tsir');
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, 'admin.db');
// The e2e suite passes `--reset-db` so every run starts from a clean schema.
// Migration then recreates the tables. (serve.ts is a dev-only shim; production
// relies on `tsir migrate` and never resets data.)
if (process.argv.includes('--reset-db') && existsSync(dbPath)) {
  rmSync(dbPath, { force: true });
}
const sqlite = new Sqlite(dbPath);
const binding = createSqliteBinding(sqlite);

// Make the binding available to the deferred D1 driver before migration runs,
// so `@tsir/migrate` uses the same connection the handler will use.
runtimeBindings.DB = binding;

// Apply migrations through the framework's runner — never raw SQL. This is the
// same code path `tsir migrate` uses; the dev server just runs it in-process.
const result = await migrate({
  database: databases.defaultDatabase,
  folder: MIGRATIONS_DIR,
  name: 'admin.product.com',
  log: (message) => console.log(`  migrate: ${message}`),
});
if (result.applied.length > 0) {
  console.log(
    `applied ${String(result.applied.length)} migration(s): ${result.applied.map((a) => a.tag).join(', ')}`,
  );
} else {
  console.log('migrations up to date');
}

Bun.serve({
  port,
  async fetch(request: Request): Promise<Response> {
    try {
      return await handler(request, { DB: binding });
    } catch (error) {
      console.error('handler error:', error);
      throw error;
    }
  },
});

console.log(`admin app running at http://localhost:${port}`);
