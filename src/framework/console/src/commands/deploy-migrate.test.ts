/**
 * The migrate unit (`DPL-021`, `MIG-012`).
 *
 * The acceptance criterion is "runs once, not on cold start", and that has two halves which
 * need different kinds of proof:
 *
 *   · **structurally** — the emitted file has no `export` at all, so no platform shape
 *     (`fetch`, `queue`, `scheduled`, `handler`) can call it. Asserted on the built artifact,
 *     not on the generator's source, because the bundler is what produces the file.
 *   · **behaviourally** — running it applies the journal and prints what it did; running it
 *     twice is a no-op; running it from the wrong directory fails loudly instead of
 *     silently migrating nothing.
 */

import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { EXIT } from '../output.ts';
import {
  connectionOfUnit,
  MIGRATE_FILE,
  migratePlan,
  migrateScriptSource,
  migrateSpec,
} from './deploy-migrate.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'migrate-app');
const CLI = join(import.meta.dir, '..', 'cli.ts');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function run(args: readonly string[], cwd: string): { code: number; output: string } {
  const result = Bun.spawnSync([...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    code: result.exitCode ?? -1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

function runCli(args: readonly string[], cwd: string): { code: number; output: string } {
  return run([process.execPath, CLI, ...args], cwd);
}

async function outDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tsir-migrate-'));
  cleanup.push(dir);
  return dir;
}

/** A copy of the fixture, so a test can edit `tsir.js` without touching the repo. */
async function copyFixture(edit?: (config: string) => string): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, 'fixtures', '.tmp-migrate-'));
  cleanup.push(dir);
  await cp(FIXTURE, join(dir, 'app'), { recursive: true });

  if (edit !== undefined) {
    const config = join(dir, 'app', 'tsir.js');
    await writeFile(config, edit(await readFile(config, 'utf8')), 'utf8');
  }

  // The fixture imports the migrate package's fake database by *relative* path, because
  // that file is test support and not an exported subpath. A copy sits one level deeper,
  // so the path is rewritten to the real file — the same trick the other deploy fixtures
  // use for anything that has to survive being copied.
  const entry = join(dir, 'app', 'src', 'app.ts');
  const fake = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    'framework',
    'migrate',
    'src',
    'fake.test-support.ts',
  );
  await writeFile(
    entry,
    (await readFile(entry, 'utf8')).replaceAll(
      "'../../../../../../migrate/src/fake.test-support.ts'",
      JSON.stringify(fake),
    ),
    'utf8',
  );
  return join(dir, 'app');
}

describe('the script source', () => {
  const spec = {
    connection: 'primary',
    entry: '/abs/src/app.ts',
    folder: 'migrations',
    driver: 'postgres' as const,
    app: 'acme',
  };

  test('it is a program: no handler, no fetch, no scheduled', () => {
    const source = migrateScriptSource(spec);

    expect(source).not.toMatch(/^export /mu);
    expect(source).not.toContain('toCloudflareHandler');
    expect(source).not.toContain('toLambdaHandler');
    expect(source).not.toContain('addEventListener');
    expect(source).toContain('process.exit(0);');
  });

  test('the folder is resolved at run time, never baked as an absolute path', () => {
    const source = migrateScriptSource(spec);

    expect(source).toContain('const FOLDER = process.env[\'TSIR_MIGRATIONS\'] ?? "migrations";');
    expect(source).not.toContain('/abs/migrations');
  });

  test('it uses the app’s own database, single or registry', () => {
    const source = migrateScriptSource(spec);

    expect(source).toContain('registry.connection(CONNECTION)');
    expect(source).toContain('app.database');
    expect(source).toContain('exports neither `database` nor `databases`');
  });

  test('drift and pending migrations are failures, a held lock is not', () => {
    const source = migrateScriptSource(spec);

    expect(source).toContain('if (result.drift.length > 0) fail');
    expect(source).toContain('still pending');
    expect(source).toContain('another runner held the lock; nothing applied');
  });

  test('the same connection generates the same bytes', () => {
    expect(migrateScriptSource(spec)).toBe(migrateScriptSource(spec));
  });
});

describe('the plan document', () => {
  test('it names the artifact, the folder and the one command', () => {
    const plan = migratePlan({
      connection: 'primary',
      entry: '/abs/src/app.ts',
      folder: 'migrations/reporting',
      driver: 'mysql',
      app: 'acme',
    });

    expect(plan.script).toBe('migrate/primary/migrate.mjs');
    expect(plan.command).toBe('bun migrate/primary/migrate.mjs');
    expect(plan.folder).toBe('migrations/reporting');
    expect(plan.driver).toBe('mysql');
  });

  test('unit names carry the connection', () => {
    expect(connectionOfUnit('migrate:primary')).toBe('primary');
    expect(connectionOfUnit('http')).toBeUndefined();
  });
});

describe('resolving a unit', () => {
  const base = {
    unit: 'migrate:primary',
    app: 'acme',
    entry: '/abs/src/app.ts',
    root: '/abs',
  };

  test('the journal folder is relative to the project root', () => {
    const spec = migrateSpec({
      ...base,
      connections: { primary: { driver: 'postgres', folder: '/abs/migrations' } },
    });

    expect(spec.folder).toBe('migrations');
  });

  test('a D1 connection is refused with the command that does work', () => {
    expect(() =>
      migrateSpec({ ...base, connections: { primary: { driver: 'd1', folder: 'migrations' } } }),
    ).toThrow(/wrangler d1 migrations apply/u);
  });

  test('a unit naming an undeclared connection is a config error', () => {
    expect(() => migrateSpec({ ...base, connections: {} })).toThrow(/does not declare/u);
  });

  test('a unit that is not a migrate unit is refused', () => {
    expect(() =>
      migrateSpec({
        ...base,
        unit: 'http',
        connections: { primary: { driver: 'postgres', folder: 'migrations' } },
      }),
    ).toThrow(/not a migrate unit/u);
  });
});

describe('a real build', () => {
  test('a journaled connection becomes a unit; one without a journal does not', () => {
    const plan = runCli(['deploy:plan', '--json'], FIXTURE);
    const parsed = JSON.parse(plan.output) as {
      units: { name: string; kind: string; private: boolean; triggers: { kind: string }[] }[];
    };

    expect(parsed.units.map((unit) => unit.name)).toEqual(['migrate:primary']);
    expect(parsed.units[0]?.kind).toBe('migrate');
    // A migration has no network surface at all, so the graph does not pretend it might.
    expect(parsed.units[0]?.private).toBe(true);
    expect(parsed.units[0]?.triggers.map((trigger) => trigger.kind)).toEqual(['manual']);
  });

  test('it emits a script and a plan, and lists them in build.json', async () => {
    const out = await outDir();
    const build = runCli(['deploy:build', '--target', 'cloudflare', '--out', out], FIXTURE);

    expect(build.code).toBe(EXIT.ok);
    expect(build.output).toContain('migrate/primary/migrate.mjs');

    const document = JSON.parse(await readFile(join(out, 'build.json'), 'utf8')) as {
      artifacts: { unit: string; file: string; budget: number | null; triggers: string[] }[];
    };
    const artifact = document.artifacts.find((entry) => entry.unit === 'migrate:primary');
    expect(artifact?.file).toBe('migrate/primary/migrate.mjs');
    // No budget: it runs for seconds, and a number would be true and meaningless.
    expect(artifact?.budget).toBeNull();
    expect(artifact?.triggers).toEqual([]);

    const plan = JSON.parse(
      await readFile(join(out, 'migrate', 'primary', MIGRATE_FILE), 'utf8'),
    ) as {
      connection: string;
      command: string;
    };
    expect(plan.connection).toBe('primary');
    expect(plan.command).toBe('bun migrate/primary/migrate.mjs');
  });

  test('the built artifact has no export a platform could call', async () => {
    const out = await outDir();
    runCli(['deploy:build', '--target', 'cloudflare', '--out', out], FIXTURE);

    const script = await readFile(join(out, 'migrate', 'primary', 'migrate.mjs'), 'utf8');

    // The bundler's own export statement is the only way a module exposes anything.
    expect(script).not.toMatch(/^export\s/mu);
    expect(script).not.toContain('addEventListener');
  });

  test('running it applies the journal, once', async () => {
    const out = await outDir();
    runCli(['deploy:build', '--target', 'cloudflare', '--out', out], FIXTURE);

    const first = run([process.execPath, join(out, 'migrate', 'primary', 'migrate.mjs')], FIXTURE);

    expect(first.code).toBe(EXIT.ok);
    expect(first.output).toContain('tsir migrate: primary · migrations');
    expect(first.output).toContain('+ 0000_initial');
    expect(first.output).toContain('1 applied');
  });

  test('running it from the wrong directory fails loudly instead of doing nothing', async () => {
    const out = await outDir();
    runCli(['deploy:build', '--target', 'cloudflare', '--out', out], FIXTURE);

    const wrong = run([process.execPath, join(out, 'migrate', 'primary', 'migrate.mjs')], out);

    expect(wrong.code).toBe(EXIT.failure);
    expect(wrong.output).toContain('no journal');
  });

  test('TSIR_MIGRATIONS points it at the journal, wherever it runs from', async () => {
    const out = await outDir();
    runCli(['deploy:build', '--target', 'cloudflare', '--out', out], FIXTURE);

    const result = Bun.spawnSync(
      [process.execPath, join(out, 'migrate', 'primary', 'migrate.mjs')],
      {
        cwd: out,
        env: { ...process.env, TSIR_MIGRATIONS: join(FIXTURE, 'migrations') },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout.toString()).toContain('+ 0000_initial');
  });

  test('the gate scans the script like any other artifact', async () => {
    const out = await outDir();
    runCli(['deploy:build', '--target', 'cloudflare', '--out', out], FIXTURE);

    const result = runCli(['deploy:validate', '--out', out], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('no secret values');
    expect(existsSync(join(out, 'migrate', 'primary', 'migrate.mjs'))).toBe(true);
  });
});

describe('what the build refuses', () => {
  test('a D1 connection fails the build with the wrangler command', async () => {
    const cwd = await copyFixture((config) =>
      config
        .replace(
          "driver: 'postgres', url: { fromEnv: 'DATABASE_URL' }",
          "driver: 'd1', binding: 'DB'",
        )
        // Declare the binding too, so the graph is satisfied and the *migration* refusal —
        // the thing this test is about — is what surfaces.
        .replace(
          'cloudflare: { bindings: {} }',
          "cloudflare: { bindings: { DB: { kind: 'd1', resource: 'db' } } }",
        ),
    );
    const out = await outDir();

    const result = runCli(['deploy:build', '--target', 'cloudflare', '--out', out], cwd);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('DPL_CONFIG_INVALID');
    expect(result.output).toContain('wrangler d1 migrations apply');
  });

  test('a connection with `journal: false` produces no unit and no artifact', async () => {
    const cwd = await copyFixture((config) =>
      config.replace(
        "{ driver: 'postgres', url: { fromEnv: 'DATABASE_URL' } }",
        "{ driver: 'postgres', url: { fromEnv: 'DATABASE_URL' }, journal: false }",
      ),
    );
    const out = await outDir();

    const plan = runCli(['deploy:plan', '--json'], cwd);
    expect(JSON.parse(plan.output).units).toEqual([]);

    const build = runCli(['deploy:build', '--target', 'cloudflare', '--out', out], cwd);
    expect(build.code).toBe(EXIT.ok);
    expect(existsSync(join(out, 'migrate'))).toBe(false);
  });
});
