/**
 * `@tsir/database/bun` — the entrypoint for anything that opens a local SQLite file.
 *
 * Import this from a CLI-capable app's `database.ts` and pass `openSqliteFiles` to
 * `createDatabaseBootstrap`. Do not import it from a Worker: it names `bun:sqlite`,
 * `node:fs` and `node:path`, none of which exist there, and the bundle will not load.
 *
 * ```ts
 * import { createDatabaseBootstrap } from '@tsir/database';
 * import { openSqliteFiles } from '@tsir/database/bun';
 *
 * export const { db, drizzle } = createDatabaseBootstrap(config, {
 *   migrationsDir: join(import.meta.dir, 'migrations'),
 *   sqlitePath: join(import.meta.dir, '..', '.tsir', 'app.db'),
 *   openSqlite: openSqliteFiles,
 * });
 * ```
 *
 * Omitting `openSqlite` is the Workers configuration: no file is ever opened, and a `sqlite`
 * connection that is actually queried answers `DB_SQLITE_NO_HANDLE` naming itself.
 */

export { openSqliteFiles } from './open-sqlite.ts';
export type { SqliteOpeningOptions } from './open-sqlite.ts';
