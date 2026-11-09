/**
 * `tsir cache:*` (`CACHE-9`, `CACHE-10`).
 *
 * Three commands, each answering one question a person actually asks:
 *
 *   · `cache:table` — "what do I migrate to make the `database` driver work?" Prints the DDL
 *     the driver expects, for the engine you name. A cache table is two columns and an index;
 *     the value here is that it is *the same* two columns the driver queries.
 *   · `cache:probe` — "does this store actually work here?" Opens every store, round-trips one
 *     key, prints a line each, and exits non-zero if any failed. This is the health check a
 *     deploy pipeline runs, not a smoke test a person remembers to.
 *   · `cache:clear` — "empty *this* store." The store name is required. There is no `--all`:
 *     a cache with no name is one command away from a production incident, and the store that
 *     needs clearing is always known to the person running it.
 *
 * Where the registry comes from: the app entry's `caches` export when there is one (the same
 * contract as `database`/`databases`), otherwise `cache.stores` in `tsir.js` built with
 * `memory`/`null` — which is enough for a fresh project to probe.
 */

import { pathToFileURL } from 'node:url';

import {
  cachesFromConfig,
  cacheTableDdl,
  CACHE_DRIVERS,
  type Caches,
  type CacheDriverName,
} from '@tsir/cache';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { EXIT, fail, info, style, UsageError, jsonDocument, symbols } from '../output.ts';
import { loadProject, type LoadedProject } from '../project.ts';

/** Duck-types the exported registry, so a wrong export is a message and not a crash. */
function isCaches(value: unknown): value is Caches {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.store === 'function' &&
    typeof candidate.probe === 'function' &&
    typeof candidate.default === 'string' &&
    Array.isArray(candidate.names)
  );
}

async function resolveCaches(project: LoadedProject): Promise<{ caches: Caches; source: string }> {
  const module = (await import(pathToFileURL(project.entryPath).href)) as {
    readonly caches?: unknown;
  };
  if (isCaches(module.caches)) {
    return { caches: module.caches, source: `${project.entryPath} (caches)` };
  }

  const caches = cachesFromConfig({
    ...(project.config.cache === undefined ? {} : { cache: project.config.cache }),
    // `tsir.js` has no `env` key (the environment is `APP_ENV`, checked by `bootProject`);
    // the production guard belongs to boot, not to a probe that has to work in every env.
  });
  return { caches, source: `${project.configPath} (cache.stores)` };
}

// ─── cache:table ────────────────────────────────────────────────────────────

/**
 * The DDL, for the engine the project uses.
 *
 * `--engine` rather than reading the connection's capabilities: the point of this command is
 * to hand someone SQL for a migration, and a migration folder does not have a client to ask.
 */
export async function cacheTableCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--engine': { type: 'string', description: "'postgres' (default) or 'd1'" },
    '--table': { type: 'string', description: 'default cache_entries' },
    '--tag-table': { type: 'string', description: 'default cache_entry_tags' },
    '--json': { type: 'boolean', description: 'one JSON document' },
  });

  const engine = stringFlag(args, '--engine') ?? 'postgres';
  if (engine !== 'postgres' && engine !== 'd1') {
    return fail(
      new UsageError(`--engine must be "postgres" or "d1" (got "${engine}")`),
      boolFlag(args, '--json'),
    );
  }

  const table = stringFlag(args, '--table');
  const tagTable = stringFlag(args, '--tag-table');
  const statements = cacheTableDdl({
    engine,
    ...(table === undefined ? {} : { table }),
    ...(tagTable === undefined ? {} : { tagTable }),
  });

  if (boolFlag(args, '--json')) {
    info(jsonDocument({ engine, statements }));
    return EXIT.ok;
  }

  info(`  ${style.bold(`cache tables · ${engine}`)}`);
  info('');
  for (const statement of statements) {
    info(`${statement};`);
    info('');
  }
  info(`  ${style.dim('next: add these to a migration — `tsir make:migration`')}`);
  return EXIT.ok;
}

// ─── cache:probe ────────────────────────────────────────────────────────────

export async function cacheProbeCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--json': { type: 'boolean', description: 'machine-readable results' },
  });
  const json = boolFlag(args, '--json');

  let resolved: { caches: Caches; source: string };
  try {
    resolved = await resolveCaches(await loadProject(process.cwd()));
  } catch (error: unknown) {
    return fail(error, json);
  }

  const { caches, source } = resolved;
  const results = await caches.probe();
  const failed = results.filter((result) => !result.ok);

  if (json) {
    info(
      jsonDocument({
        ok: failed.length === 0,
        source,
        default: caches.default,
        stores: results.map((result) => ({
          name: String(result.store),
          driver: caches.store(result.store).driver,
          ok: result.ok,
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        })),
      }),
    );
    return failed.length === 0 ? EXIT.ok : EXIT.failure;
  }

  info(`  ${style.bold('cache probe')} ${style.dim(`· ${source}`)}`);
  for (const result of results) {
    const name = String(result.store);
    const driver = caches.store(result.store).driver;
    const mark = result.ok ? style.green(symbols.check) : style.red(symbols.cross);
    const note = name === caches.default ? style.dim(' (default)') : '';
    const detail = result.ok ? '' : ` ${style.dim(result.detail ?? 'failed')}`;
    info(`  ${mark} ${name.padEnd(16)} ${driver.padEnd(14)}${note}${detail}`);
  }

  if (failed.length > 0) {
    return fail(
      new Error(`${String(failed.length)} of ${String(results.length)} store(s) failed the probe`),
      false,
    );
  }

  info('');
  info(`  ${style.green(symbols.check)} ${String(results.length)} store(s) answered`);
  return EXIT.ok;
}

// ─── cache:clear ────────────────────────────────────────────────────────────

export async function cacheClearCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--store': { type: 'string', description: 'the store to empty (required)' },
    '--yes': { type: 'boolean', description: 'confirm; a clear without it only reports' },
    '--json': { type: 'boolean', description: 'machine-readable result' },
  });
  const json = boolFlag(args, '--json');
  const store = stringFlag(args, '--store') ?? args.positionals[0];

  if (store === undefined) {
    return fail(
      new UsageError(
        'cache:clear needs a store name',
        `--store <name> — declared: (run \`tsir cache:probe\` to see them). There is no --all: a cache emptied by accident is an outage`,
      ),
      json,
    );
  }

  let resolved: { caches: Caches; source: string };
  try {
    resolved = await resolveCaches(await loadProject(process.cwd()));
    const known = resolved.caches.names;
    if (!known.includes(store)) {
      throw new UsageError(`unknown cache store "${store}"`, `declared: ${known.join(', ')}`);
    }

    const cache = resolved.caches.store(store as never);
    if (!boolFlag(args, '--yes')) {
      info(
        `  ${style.dim('·')} store ${store} (driver ${cache.driver}) would be emptied — re-run with --yes`,
      );
      return EXIT.ok;
    }

    await cache.clear();

    if (json) {
      info(jsonDocument({ ok: true, store, driver: cache.driver }));
      return EXIT.ok;
    }
    info(`  ${style.green(symbols.check)} cleared ${store} (driver ${cache.driver})`);
    return EXIT.ok;
  } catch (error: unknown) {
    return fail(error, json);
  }
}

/** The driver names `tsir.js` may write, exposed so `doctor` can suggest them. */
export const DRIVER_NAMES: readonly CacheDriverName[] = CACHE_DRIVERS;
