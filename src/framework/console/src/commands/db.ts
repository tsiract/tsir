/**
 * Database commands: `make:migration`, `migrate`, `migrate:status`,
 * `migrate:rollback`, `migrate:verify`, `db:seed` (`MIG-001`…`MIG-011`, `SED-010`).
 *
 * ## Where the database comes from
 *
 * The CLI does not build a client. ADR-0009 says the application supplies its
 * Postgres client — `@tsir/database` deliberately has no driver dependency — so
 * the composition root owns the one object that knows how to connect. The CLI
 * therefore expects the application entry to **export it**:
 *
 * ```ts
 * // src/app.ts
 * export const database = createDatabase({ driver: createPostgresDriver({ client }) });
 * export default defineApp({ name: 'acme', config: spec, modules: [dbModule] });
 * ```
 *
 * A missing export is an environment error with that snippet in the message, not
 * a guess. The alternative — teaching the CLI to open its own connection from a
 * URL — would give the toolchain a second, weaker connection path than the one
 * production uses.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Connections, Database } from '@tsir/database';
import {
  migrate,
  migrationFolder,
  migrationStatus,
  preflightGuidance,
  rollback,
} from '@tsir/migrate';
import { assertEnvironmentAllowed, runSeeders, type Seeder } from '@tsir/seed';
import { systemClock, systemRandom } from '@tsir/core';

import { boolFlag, parseArgs, stringFlag, type ParsedArgs } from '../args.ts';
import { loadProject, type LoadedProject } from '../project.ts';
import { CliError, EXIT, fail, info, ok, style, warn, jsonDocument } from '../output.ts';

const DEFAULT_MIGRATIONS = 'drizzle';

/** `--class=UsersSeeder,PostsSeeder` — repeated flags would need parser support for one use. */
function csvFlag(args: ParsedArgs, name: string): readonly string[] {
  const value = stringFlag(args, name);
  if (value === undefined) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  // coercion-ok: a CLI flag is the one place a string is *meant* to be a number;
  // `Number.isFinite` below rejects "", "abc" and "1e999" instead of accepting 0.
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliError(`${name} expects a number of milliseconds`, EXIT.usage);
  }
  return parsed;
}

interface DbContext {
  readonly project: LoadedProject;
  readonly folder: string;
  readonly database: Database;
  readonly env: string;
}

/** Duck-types the exported database; a wrong export gets a message, not a crash. */
function isDatabase(value: unknown): value is Database {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.query === 'function' &&
    typeof candidate.batch === 'function' &&
    typeof candidate.interactiveTx === 'function' &&
    typeof candidate.close === 'function' &&
    typeof candidate.capabilities === 'object' &&
    candidate.capabilities !== null
  );
}

/**
 * Loads the project and finds the exported `database`.
 *
 * `loadProject` already imports the entry to read its default export, so this is
 * the same module instance — the trick is that a second dynamic import would be
 * cached and identical, which is why the lookup is done on a fresh import.
 */
export async function resolveDatabase(project: LoadedProject): Promise<Database> {
  const module = (await import(pathToFileURL(project.entryPath).href)) as {
    readonly database?: unknown;
  };
  if (!isDatabase(module.database)) {
    throw new CliError(
      `no database found in ${project.entryPath}`,
      EXIT.environment,
      'export the Database your app already uses: `export const database = createDatabase({ driver })`',
    );
  }
  return module.database;
}

/**
 * The exported registry, when there is one (`MIG-015`).
 *
 * Duck-typed like `isDatabase`: a project that exports `databases` gets its named
 * connections, and one that exports a single `database` keeps working unchanged.
 */
async function resolveConnections(project: LoadedProject): Promise<Connections | undefined> {
  const module = (await import(pathToFileURL(project.entryPath).href)) as {
    readonly databases?: unknown;
  };
  const candidate = module.databases;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const registry = candidate as Partial<Connections>;
  if (
    typeof registry.connection !== 'function' ||
    typeof registry.default !== 'string' ||
    !Array.isArray(registry.names)
  ) {
    return undefined;
  }
  return registry as Connections;
}

export interface BoundDatabase {
  readonly database: Database;
  /** The name it answers to — the same string the seeder check compares. */
  readonly connection: string;
  readonly registry: Connections | undefined;
}

/**
 * Resolves the database a command should act on (`MIG-015`, `SED-011`).
 *
 * Shared by `context()` and `db:seed`: seeding needs the *bound connection* but not
 * a migrations folder, and the two paths must not disagree about which connection
 * `--connection` selects.
 */
export async function bindDatabase(
  project: LoadedProject,
  connectionName?: string,
): Promise<BoundDatabase> {
  const registry = await resolveConnections(project);

  if (connectionName !== undefined && registry === undefined) {
    throw new CliError(
      `--connection=${connectionName} needs a registry`,
      EXIT.usage,
      'export `databases = createConnections(...)` from the app entry, or drop the flag to use the single connection',
    );
  }

  if (registry !== undefined) {
    const name = connectionName ?? registry.default;
    return { database: registry.connection(name), connection: name, registry };
  }

  const database = await resolveDatabase(project);
  return { database, connection: database.name, registry };
}

async function context(cwd: string, connectionName?: string): Promise<DbContext> {
  const project = await loadProject(cwd);
  const base = project.config.paths?.migrations ?? DEFAULT_MIGRATIONS;
  const { database, connection, registry } = await bindDatabase(project, connectionName);

  const folder = migrationFolder(project.root, connection, {
    base,
    defaultConnection: registry?.default ?? connection,
  });

  if (!existsSync(folder)) {
    throw new CliError(
      `no migration folder at ${folder}`,
      EXIT.environment,
      registry === undefined || connection === registry.default
        ? 'run `tsir make:migration <name>` first, or set `paths.migrations` in tsir.js'
        : `create ${folder} for connection "${connection}" — each connection keeps its own journal (MIG-015)`,
    );
  }

  return { project, folder, database, env: process.env['APP_ENV'] ?? 'development' };
}

/**
 * One exit path for every failure in this file.
 *
 * Delegate to `fail()` rather than re-implementing it: `fail` already knows that a
 * `CliError` carries its own exit code (a usage mistake is 2, not 1) and that a
 * config-kind `TsirError` is 3. Duplicating that logic is how the JSON and human
 * paths drift apart — which is exactly what happened before this function did.
 */
function report(error: unknown, json: boolean): number {
  return fail(error, json);
}

// ─── make:migration (MIG-001) ────────────────────────────────────────────────

export interface GenerateResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface MakeMigrationOptions {
  readonly cwd: string;
  readonly name: string;
  /** Injected by tests; the real command shells out to drizzle-kit. */
  readonly run?: (command: readonly string[], cwd: string) => Promise<GenerateResult>;
  readonly json?: boolean;
}

/** `add_users_email` — the suffix drizzle-kit appends to the index. */
const MIGRATION_NAME = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

async function runDrizzleKit(command: readonly string[], cwd: string): Promise<GenerateResult> {
  const child = Bun.spawn(['bun', 'x', 'drizzle-kit', ...command], {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

/**
 * Lints a generated migration.
 *
 * Three rules, all of them cheap and all of them things a reviewer would send
 * back: a file that is empty is a schema diff that did not happen; a file that
 * does not end in a newline breaks every diff thereafter; and a transaction
 * header must appear at most once, because two headers is a merge conflict that
 * resolved itself the wrong way.
 */
export function lintMigration(sql: string, tag: string): readonly string[] {
  const problems: string[] = [];
  if (sql.trim() === '') problems.push(`${tag}: the generated file is empty`);
  if (sql !== '' && !sql.endsWith('\n')) problems.push(`${tag}: file does not end with a newline`);
  const headers = sql.match(/--\s*tsir:transaction=/g) ?? [];
  if (headers.length > 1) problems.push(`${tag}: more than one tsir:transaction header`);
  return problems;
}

export async function makeMigrationCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });
  const json = boolFlag(args, '--json');
  const name = args.positionals[0];

  if (name === undefined || !MIGRATION_NAME.test(name)) {
    throw new CliError(
      name === undefined
        ? 'make:migration needs a name'
        : `"${name}" is not a usable migration name`,
      EXIT.usage,
      'use lowercase words separated by underscores: `tsir make:migration add_users_email`',
    );
  }

  try {
    const project = await loadProject(process.cwd());
    const folder = join(project.root, project.config.paths?.migrations ?? DEFAULT_MIGRATIONS);
    // `--name` is the suffix drizzle-kit uses for the file; the index prefix and
    // the journal entry are its business, which is the point of delegating.
    const result = await runDrizzleKit(['generate', '--name', name], project.root);
    if (result.exitCode !== 0) {
      throw new CliError(
        `drizzle-kit generate failed: ${result.stderr.trim() || result.stdout.trim()}`,
        EXIT.failure,
        'check drizzle.config.ts and that the schema file it points at compiles',
      );
    }

    const { readMigrationFolder } = await import('@tsir/migrate');
    const { migrations } = await readMigrationFolder(folder);
    const created = migrations[migrations.length - 1];
    const problems = created === undefined ? [] : lintMigration(created.sql, created.tag);

    if (problems.length > 0) {
      for (const problem of problems) warn(problem);
      return EXIT.failure;
    }

    if (json) {
      info(jsonDocument({ ok: true, tag: created?.tag ?? null, folder }));
    } else {
      ok(`wrote ${created?.tag ?? '(nothing)'} in ${folder}`);
      info(style.dim('  review the SQL, then commit it with the schema change'));
    }
    return EXIT.ok;
  } catch (error: unknown) {
    return report(error, json);
  }
}

// ─── migrate (MIG-002 … MIG-007, MIG-011) ────────────────────────────────────

export async function migrateCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--dry-run': { type: 'boolean', description: 'plan without applying' },
    '--connection': { type: 'string', description: 'named connection (MIG-015)' },
    '--wait': { type: 'string', description: 'milliseconds to wait for the lock' },
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });
  const json = boolFlag(args, '--json');
  const dryRun = boolFlag(args, '--dry-run');
  const waitMs = numberFlag(args, '--wait');

  try {
    const db = await context(process.cwd(), stringFlag(args, 'connection'));

    if (!json) {
      const guidance = preflightGuidance({
        engine: db.database.capabilities.engine,
        environment: db.env,
        pending: 0,
      });
      for (const line of guidance) info(style.yellow(line));
    }

    const result = await migrate({
      database: db.database,
      folder: db.folder,
      name: db.project.config.app.name,
      ...(waitMs === undefined ? {} : { waitMs }),
      dryRun,
      log: (message) => {
        if (!json) info(style.dim(`  ${message}`));
      },
    });

    if (json) {
      info(jsonDocument({ ok: true, ...result }));
    } else if (result.locked) {
      ok('another migration is in progress — nothing to do');
    } else if (result.pending.length > 0) {
      info(`\n  ${String(result.pending.length)} pending: ${result.pending.join(', ')}\n`);
    } else if (result.applied.length === 0) {
      ok('no pending migrations');
    } else {
      ok(
        `applied ${String(result.applied.length)} migration(s) in ${String(result.durationMs)} ms`,
      );
    }

    if (result.orphaned.length > 0 && !json) {
      warn(`${String(result.orphaned.length)} applied migration(s) have no file on disk`);
    }
    // A session-scoped lock is only a lock when the DDL runs on the same session.
    // Saying nothing here would leave a user believing two concurrent deploys were
    // excluded when they were not (`DB-018`).
    if (!result.lockVerified && !json) {
      warn(
        'the advisory lock was not pinned to one connection, so concurrent runners were not excluded — ' +
          'pass a Postgres client that supports reserve() (postgres.js, Bun SQL)',
      );
    }
    return EXIT.ok;
  } catch (error: unknown) {
    return report(error, json);
  }
}

// ─── migrate:status (MIG-005) ────────────────────────────────────────────────

export async function migrateStatusCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--connection': { type: 'string', description: 'named connection (MIG-015)' },
    '--json': { type: 'boolean', description: 'machine-readable' },
  });
  const json = boolFlag(args, '--json');

  try {
    const db = await context(process.cwd(), stringFlag(args, 'connection'));
    const status = await migrationStatus(db.database, { folder: db.folder });

    if (json) {
      info(
        jsonDocument({
          ok: status.tags.drifted.length === 0,
          connection: status.connection,
          folder: db.folder,
          fresh: status.fresh,
          applied: status.tags.applied,
          pending: status.tags.pending,
          drifted: status.tags.drifted,
        }),
      );
    } else {
      info(style.dim(`  ${status.connection} · ${db.folder}`));
      for (const tag of status.tags.applied) info(`  ${style.green('applied')}  ${tag}`);
      for (const tag of status.tags.pending) info(`  ${style.yellow('pending')}  ${tag}`);
      for (const tag of status.tags.drifted) info(`  ${style.red('drifted')}  ${tag}`);
      info('');
    }

    // Drift is the one state that must fail a pipeline: the database and the
    // repository disagree, and no command in this file can fix that.
    return status.tags.drifted.length > 0 ? EXIT.failure : EXIT.ok;
  } catch (error: unknown) {
    return report(error, json);
  }
}

// ─── migrate:rollback (MIG-009) ──────────────────────────────────────────────

export async function migrateRollbackCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--connection': { type: 'string', description: 'named connection (MIG-015)' },
    '--to': { type: 'string', description: 'tag to keep, or "empty"' },
    '--allow-destructive': { type: 'boolean', description: 'acknowledge data loss' },
    '--confirm': { type: 'string', description: 'type the newest migration being undone' },
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });
  const json = boolFlag(args, '--json');
  const to = stringFlag(args, '--to');

  if (to === undefined) {
    throw new CliError(
      'migrate:rollback needs --to <tag|empty>',
      EXIT.usage,
      'rollback is never "the last one": name the migration that should remain applied',
    );
  }

  try {
    const db = await context(process.cwd(), stringFlag(args, 'connection'));
    const confirm = stringFlag(args, '--confirm');
    const result = await rollback({
      database: db.database,
      folder: db.folder,
      name: db.project.config.app.name,
      to,
      allowDestructive: boolFlag(args, '--allow-destructive'),
      ...(confirm === undefined ? {} : { confirm }),
      log: (message) => {
        if (!json) info(style.dim(`  ${message}`));
      },
    });

    if (json) info(jsonDocument({ ok: true, ...result }));
    else if (result.undone.length === 0) ok('nothing to roll back');
    else ok(`rolled back ${result.undone.join(', ')}`);

    return EXIT.ok;
  } catch (error: unknown) {
    return report(error, json);
  }
}

// ─── migrate:verify (MIG-010) ────────────────────────────────────────────────

export async function migrateVerifyCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--connection': { type: 'string', description: 'named connection (MIG-015)' },
    '--json': { type: 'boolean', description: 'machine-readable' },
  });
  const json = boolFlag(args, '--json');

  try {
    const db = await context(process.cwd(), stringFlag(args, 'connection'));
    const status = await migrationStatus(db.database, { folder: db.folder });

    // `verify` answers one question: does the journal apply cleanly from nothing?
    // It is a CI command pointed at a throwaway database, so a database that is
    // already half-migrated is a misconfiguration, not a job to do.
    if (!status.fresh) {
      throw new CliError(
        'migrate:verify expects an empty database',
        EXIT.environment,
        'point DATABASE_URL at a throwaway database; verify proves "empty → current" applies cleanly',
      );
    }

    const result = await migrate({
      database: db.database,
      folder: db.folder,
      name: db.project.config.app.name,
    });

    if (json) info(jsonDocument({ ok: true, applied: result.applied.map((r) => r.tag) }));
    else ok(`verified ${String(result.applied.length)} migration(s) from an empty database`);

    return EXIT.ok;
  } catch (error: unknown) {
    return report(error, json);
  }
}

// ─── db:seed (SED-007, SED-010) ──────────────────────────────────────────────

export async function dbSeedCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--connection': { type: 'string', description: 'named connection (MIG-015)' },
    '--class': { type: 'string', description: 'comma-separated seeder names to run' },
    '--all': { type: 'boolean', description: 'run every seeder for this environment' },
    '--reference-data': { type: 'boolean', description: 'allow production reference data' },
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });
  const json = boolFlag(args, '--json');
  const classes = csvFlag(args, '--class');
  const all = boolFlag(args, '--all');
  const referenceData = boolFlag(args, '--reference-data');

  if (classes.length > 0 && all) {
    throw new CliError('--class and --all are mutually exclusive', EXIT.usage);
  }

  try {
    const project = await loadProject(process.cwd());
    const module = (await import(pathToFileURL(project.entryPath).href)) as {
      readonly seeders?: readonly Seeder[];
    };
    const seeders = module.seeders;
    if (seeders === undefined || seeders.length === 0) {
      throw new CliError(
        `no seeders exported from ${project.entryPath}`,
        EXIT.environment,
        'export a `seeders` array of `defineSeeder({...})` values',
      );
    }

    const env = (process.env['APP_ENV'] ?? 'development') as
      'development' | 'test' | 'staging' | 'production';

    assertEnvironmentAllowed({ env, seeders, ...(referenceData ? { referenceData } : {}) });

    const bound = await bindDatabase(project, stringFlag(args, 'connection'));

    const result = await runSeeders({
      database: bound.database,
      seeders,
      env,
      clock: systemClock(),
      random: systemRandom(),
      ...(classes.length === 0 ? {} : { only: classes }),
      ...(referenceData ? { referenceData } : {}),
      log: (message) => {
        if (!json) info(style.dim(`  ${message}`));
      },
    });

    if (json) {
      info(jsonDocument({ ok: true, connection: bound.connection, ...result }));
    } else {
      for (const skipped of result.skipped) {
        info(style.dim(`  skipped ${skipped.name} (${skipped.reason})`));
      }
      ok(`seeded ${String(result.seeded.length)} seeder(s) on ${bound.connection}`);
    }
    return EXIT.ok;
  } catch (error: unknown) {
    return report(error, json);
  }
}
