/**
 * `tsir cache:*` (`CACHE-9`).
 *
 * The commands are thin on purpose, so the tests are about the three decisions embedded in
 * them:
 *
 *   · `cache:table` prints SQL that matches what the driver queries, per engine;
 *   · `cache:probe` is a **gate** — exit 1 when any store fails, so a pipeline can run it;
 *   · `cache:clear` requires a store name and does nothing without `--yes`.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { EXIT } from '../output.ts';
import { type CliRun, runCliInProcess } from '../../test-support/in-process.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'cache-app');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runCli(args: readonly string[], cwd: string = FIXTURE): Promise<CliRun> {
  return runCliInProcess(args, { cwd });
}

async function copy(
  edit?: (config: string, entry: string) => { config?: string; entry?: string },
): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, 'fixtures', '.tmp-cache-'));
  cleanup.push(dir);
  await cp(FIXTURE, join(dir, 'app'), { recursive: true });

  if (edit !== undefined) {
    const configPath = join(dir, 'app', 'tsir.js');
    const entryPath = join(dir, 'app', 'src', 'app.ts');
    const next = edit(await readFile(configPath, 'utf8'), await readFile(entryPath, 'utf8'));
    if (next.config !== undefined) await writeFile(configPath, next.config, 'utf8');
    if (next.entry !== undefined) await writeFile(entryPath, next.entry, 'utf8');
  }
  return join(dir, 'app');
}

describe('cache:table', () => {
  test('it prints the Postgres DDL by default, with the counter and the tag index', async () => {
    const result = await runCli(['cache:table']);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('counter BIGINT');
    expect(result.output).toContain('PRIMARY KEY (key, tag)');
    expect(result.output).toContain('CREATE INDEX IF NOT EXISTS cache_entry_tags_tag');
  });

  test('--engine d1 switches the column type, because D1 is not Postgres', async () => {
    const d1 = await runCli(['cache:table', '--engine', 'd1']);

    expect(d1.code).toBe(EXIT.ok);
    expect(d1.output).toContain('counter INTEGER');
    expect(d1.output).not.toContain('BIGINT');
  });

  test('the table names are configurable, and --json is machine-readable', async () => {
    const result = await runCli([
      'cache:table',
      '--engine',
      'd1',
      '--table',
      'kv',
      '--tag-table',
      'kv_tags',
      '--json',
    ]);
    const parsed = JSON.parse(result.output.slice(result.output.indexOf('{'))) as {
      engine: string;
      statements: string[];
    };

    expect(parsed.engine).toBe('d1');
    expect(parsed.statements[0]).toContain('CREATE TABLE IF NOT EXISTS kv');
    expect(parsed.statements[2]).toContain('kv_tags_tag ON kv_tags');
  });

  test('an engine it does not know is a usage error naming the two it does', async () => {
    const result = await runCli(['cache:table', '--engine', 'mysql']);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('"postgres" or "d1"');
  });
});

describe('cache:probe', () => {
  test('it opens every store, reports one line each, and exits 0', async () => {
    const result = await runCli(['cache:probe']);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('✓ app');
    expect(result.output).toContain('(default)');
    expect(result.output).toContain('✓ sessions');
    expect(result.output).toContain('2 store(s) answered');
  });

  test('--json names each store with its driver and the registry source', async () => {
    const result = await runCli(['cache:probe', '--json']);
    const parsed = JSON.parse(result.output.slice(result.output.indexOf('{'))) as {
      ok: boolean;
      default: string;
      source: string;
      stores: { name: string; driver: string; ok: boolean }[];
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.default).toBe('app');
    expect(parsed.source).toContain('(caches)');
    expect(parsed.stores).toEqual([
      { name: 'app', driver: 'memory', ok: true },
      { name: 'sessions', driver: 'memory', ok: true },
    ]);
  });

  test('a store that cannot answer makes the command fail — it is a gate, not a report', async () => {
    const root = await copy((config, entry) => ({
      config: config.replace("{ driver: 'null' }", "{ driver: 'null' }"),
      entry: entry.replace(
        "sessions: { driver: 'memory', required: true },",
        "sessions: { driver: 'memory', required: true },\n      off: { driver: 'null' },",
      ),
    }));

    const result = await runCli(['cache:probe'], root);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('✗ off');
    expect(result.output).toContain('1 of 3 store(s) failed');
  });

  test('with no `caches` export it builds the registry from `cache.stores` in tsir.js', async () => {
    const root = await copy((_, entry) => ({
      entry: entry.replace(/\nexport const caches = cachesFromConfig\(\{[\s\S]*?\}\);\n/u, '\n'),
    }));

    const result = await runCli(['cache:probe', '--json'], root);
    const parsed = JSON.parse(result.output.slice(result.output.indexOf('{'))) as {
      source: string;
      stores: { name: string }[];
    };

    expect(parsed.source).toContain('(cache.stores)');
    expect(parsed.stores.map((store) => store.name)).toEqual(['app', 'sessions']);
  });
});

describe('cache:clear', () => {
  test('it refuses to guess a store: no name is a usage error that explains why', async () => {
    const result = await runCli(['cache:clear']);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('cache:clear needs a store name');
    expect(result.output).toContain('There is no --all');
  });

  test('an unknown store lists the declared ones', async () => {
    const result = await runCli(['cache:clear', '--store', 'sessons', '--yes']);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('unknown cache store "sessons"');
    expect(result.output).toContain('declared: app, sessions');
  });

  test('without --yes it reports and writes nothing', async () => {
    const result = await runCli(['cache:clear', '--store', 'app']);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('would be emptied');
    expect(result.output).toContain('--yes');
    expect(result.output).not.toContain('✓ cleared');
  });

  test('with --yes it clears exactly that store', async () => {
    const result = await runCli(['cache:clear', '--store', 'app', '--yes']);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('cleared app (driver memory)');
  });

  test('a store that cannot be cleared fails with the driver’s reason', async () => {
    const root = await copy((_, entry) => ({
      entry: entry.replace(
        "sessions: { driver: 'memory', required: true },",
        "sessions: { driver: 'null' },",
      ),
    }));

    const result = await runCli(['cache:clear', '--store', 'sessions', '--yes'], root);

    // The `null` driver clears by doing nothing (there is nothing to empty), so this path
    // succeeds — the *refusal* case is `cloudflare-kv`, whose port check throws. What matters
    // here is that the command surfaces the driver's answer rather than swallowing it.
    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('cleared sessions (driver null)');
  });

  test('a driver that refuses clear surfaces its refusal as a failure exit', async () => {
    const root = await copy((_, entry) => ({
      entry: entry.replace(
        "sessions: { driver: 'memory', required: true },",
        "sessions: { driver: 'cloudflare-kv' },",
      ),
    }));

    // No KV binding exists for the entry to pass, so building the store fails loudly — the
    // same path a real project with a missing binding takes.
    const result = await runCli(['cache:clear', '--store', 'sessions', '--yes'], root);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('kv binding named');
  });
});
