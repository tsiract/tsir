/**
 * The Bun-only half of the database bootstrap: opening a local SQLite file.
 *
 * This module exists as a separate entrypoint (`@tsir/database/bun`) because of what it
 * imports. `bun:sqlite`, `node:fs` and `node:path` do not exist in a Worker, and a bundle
 * that contains any of them fails to load — not when the fallback runs, but when the module
 * graph is evaluated. Keeping the opener in the root entrypoint meant every Workers app
 * carried it and only worked because the `import()` was never reached, which is a property of
 * the program, not of the package.
 *
 * ADR-0022 is the rule that permits this: a dependency (here a runtime, not a package) may be
 * scoped to one subpath entrypoint, and the bundle proof in `deploy-bundle-targets.test.ts` is
 * what makes the scope true rather than intended.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createSqliteBinding } from './sqlite-binding.ts';
import type { RuntimeBindings } from './from-config.ts';

/** What `openSqliteFiles` needs from the parsed config. */
export interface SqliteOpeningOptions {
  /** The parsed `database` config — only `connections[].driver === 'sqlite'` entries matter. */
  readonly connections: Readonly<
    Record<string, { readonly driver: string; readonly url?: string | undefined }>
  >;
  /** Path to a local SQLite file used as the `DB` binding for CLI/dev. */
  readonly sqlitePath?: string | undefined;
}

/**
 * Open every `sqlite` connection named in the config, plus `sqlitePath` as `DB`.
 *
 * Returns what it managed to open. A runtime without `bun:sqlite` gets an empty record, and
 * the driver answers `DB_SQLITE_NO_HANDLE` naming the connection on first use — the same
 * failure as a missing D1 binding, which is what an app should see.
 */
export async function openSqliteFiles(options: SqliteOpeningOptions): Promise<RuntimeBindings> {
  const opened: RuntimeBindings = {};

  for (const [name, entry] of Object.entries(options.connections)) {
    if (entry.driver !== 'sqlite' || entry.url === undefined) continue;
    try {
      const file = entry.url.replace(/^file:/u, '');
      if (file !== ':memory:') {
        const dir = dirname(file);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      }
      const { Database: Sqlite } = await import('bun:sqlite');
      opened[name] = new Sqlite(file);
    } catch {
      // A runtime without `bun:sqlite` leaves this connection unresolved on purpose.
    }
  }

  if (options.sqlitePath !== undefined) {
    try {
      const dbDir = dirname(options.sqlitePath);
      if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
      const { Database: Sqlite } = await import('bun:sqlite');
      opened['DB'] = createSqliteBinding(new Sqlite(options.sqlitePath));
    } catch {
      // Same: the binding stays absent and the driver names it.
    }
  }

  return opened;
}
