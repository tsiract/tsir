/**
 * `tsir deploy:plan`, `deploy:diff` and `deploy:invoke` (`DPL-004`, `DPL-005`, `DPL-007`).
 *
 * Every test that needs a project runs **the real CLI in a subprocess**, and that is a
 * deliberate constraint rather than laziness. Route discovery works by importing the
 * application entry, which registers controllers process-wide — that is the same mechanism
 * `tsir route:list` relies on — so two projects (or one project twice) in a single process
 * is not a supported shape. A test that faked it would be testing a process the CLI never
 * has. Spawning also exercises the exit codes, which is half of what a CLI is.
 *
 * The one in-process test is the regression that matters: importing the *same* entry twice
 * must not register its routes twice.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { GRAPH_FILE } from '@tsir/deploy';

import { EXIT } from '../output.ts';
import { matchesRoutePath } from './deploy.ts';
import { type CliRun, runCliSubprocess } from '../../test-support/in-process.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'deploy-app');
const EVENTS_FIXTURE = join(import.meta.dir, 'fixtures', 'events-app');
const HTTP_EXAMPLE = join(import.meta.dir, '..', '..', '..', '..', 'apps', 'examples', 'http');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runCli(args: readonly string[], cwd: string): Promise<CliRun> {
  return runCliSubprocess(args, cwd);
}

/**
 * A throwaway copy of the fixture, **inside** the package.
 *
 * Not `/tmp`: the copy resolves `@tsir/core` the way a real project does by walking up to
 * `src/framework/console/node_modules`, and a copy outside the tree would be a project that
 * cannot import the framework it deploys. The dot-prefix keeps the copies out of `tsc`,
 * `eslint` and `prettier` while they exist.
 */
/** A throwaway copy of any fixture, inside the package (see `copyFixture`). */
async function copyFixtureOf(source: string): Promise<string> {
  const parent = join(import.meta.dir, 'fixtures');
  const dir = await mkdtemp(join(parent, '.tmp-deploy-'));
  cleanup.push(dir);
  await cp(source, join(dir, 'app'), { recursive: true });
  return join(dir, 'app');
}

async function copyFixture(): Promise<string> {
  const parent = join(import.meta.dir, 'fixtures');
  const dir = await mkdtemp(join(parent, '.tmp-deploy-'));
  cleanup.push(dir);
  await cp(FIXTURE, join(dir, 'app'), { recursive: true });
  return join(dir, 'app');
}

describe('route matching (DPL-007)', () => {
  test('` :param ` matches one segment; everything else is literal', async () => {
    expect(matchesRoutePath('/api/users/:id', '/api/users/7')).toBe(true);
    expect(matchesRoutePath('/api/users/:id', '/api/users')).toBe(false);
    expect(matchesRoutePath('/api/users/:id', '/api/users/7/profile')).toBe(false);
    expect(matchesRoutePath('/api/users', '/api/users/')).toBe(true);
    expect(matchesRoutePath('/a/:b/c', '/a/x/d')).toBe(false);
  });
});

describe('deploy:plan (DPL-005)', () => {
  test('--json prints the graph the declarations describe', async () => {
    const result = await runCli(['deploy:plan', '--json'], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    const parsed = JSON.parse(result.output) as {
      app: string;
      topology: string;
      targets: string[];
      units: { name: string; kind: string; requires: string[] }[];
      problems: unknown[];
    };
    expect(parsed.app).toBe('deploy-fixture');
    expect(parsed.topology).toBe('separate');
    expect(parsed.targets).toEqual(['cloudflare', 'lambda']);
    expect(parsed.units.map((unit) => [unit.name, unit.kind])).toEqual([
      ['drain', 'schedule'],
      ['ws', 'ws'],
    ]);
    expect(parsed.units[0]?.requires).toEqual(['background-tasks']);
    expect(parsed.problems).toEqual([]);
  });

  test('the human plan prints one row per unit and the topology', async () => {
    const result = await runCli(['deploy:plan'], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('drain');
    expect(result.output).toContain('2 unit(s) · topology separate');
    expect(result.output).toContain('targets cloudflare, lambda');
  });

  test('--explain names the declaration behind each unit', async () => {
    const result = await runCli(['deploy:plan', '--explain'], FIXTURE);

    expect(result.output).toContain('override: deploy.units.drain');
    expect(result.output).toContain('requires: background-tasks');
  });

  test('--topology single merges the units and reports what it merged', async () => {
    const result = await runCli(['deploy:plan', '--json', '--topology', 'single'], FIXTURE);
    const parsed = JSON.parse(result.output) as { topology: string; merged: string[] };

    expect(parsed.topology).toBe('single');
    expect(parsed.merged).toEqual(['drain', 'ws']);
  });

  test('a bad --topology is a usage error', async () => {
    const result = await runCli(['deploy:plan', '--topology', 'cluster'], FIXTURE);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('separate');
  });

  test("the example application's own graph is its two route modules", async () => {
    const result = await runCli(['deploy:plan', '--json'], HTTP_EXAMPLE);
    const parsed = JSON.parse(result.output) as { units: { name: string; modules: string[] }[] };

    expect(parsed.units.map((unit) => unit.name)).toEqual(['http', 'media']);
    // The unit follows the declaration, not the folder: `media` declared `unit: 'media'`.
    expect(parsed.units[1]?.modules).toEqual(['media']);
  });

  test('a second --check against a written snapshot passes', async () => {
    const root = join(FIXTURE, '..', 'deploy-app');
    const first = await runCli(['deploy:plan', '--check', '--json'], root);

    // The fixture has no committed snapshot; `--check` must fail, and not crash.
    expect(first.code).toBe(EXIT.failure);
    expect(first.output).toContain('is missing');
  });
});

describe('the outbox’s writer (`§ 4.5`)', () => {
  test('a project that exports `events` passes the broker rule', async () => {
    const result = await runCli(['deploy:plan', '--json'], EVENTS_FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    const parsed = JSON.parse(result.output) as { units: { name: string }[] };
    expect(parsed.units.map((unit) => unit.name)).toContain('queue:default');
  });

  test('the same project without the export is refused, naming the writer', async () => {
    const root = await copyFixtureOf(EVENTS_FIXTURE);
    const entry = join(root, 'src', 'app.ts');
    const text = await readFile(entry, 'utf8');
    // The registry still exists; it is no longer *exported*, which is exactly the mistake this
    // rule catches — an outbox nobody outside the module can write.
    expect(text).toContain('export const events = createEvents(');
    await writeFile(entry, text.replace('export const events =', 'const events ='), 'utf8');

    const result = await runCli(['deploy:plan'], root);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('DPL_EVENTS_OUTBOX_MISSING');
    expect(result.output).toContain('no events registry');
  });
});

describe('the snapshot (DPL-004)', () => {
  test('--write creates the committed graph and --check accepts it', async () => {
    const root = await copyFixture();
    const path = join(root, GRAPH_FILE);

    const written = runCliSubprocess(['deploy:plan', '--write'], root);
    expect(written.code).toBe(EXIT.ok);
    expect(written.output).toContain(`wrote ${GRAPH_FILE}`);

    const snapshot = JSON.parse(await readFile(path, 'utf8')) as { units: { name: string }[] };
    expect(snapshot.units.map((unit) => unit.name)).toEqual(['drain', 'ws']);

    const checked = runCliSubprocess(['deploy:plan', '--check'], root);
    expect(checked.code).toBe(EXIT.ok);
    expect(checked.output).toContain('matches the resolved graph');
  });

  test('a declaration change is drift, and it names the unit and the field', async () => {
    const root = await copyFixture();
    runCliSubprocess(['deploy:plan', '--write'], root);

    const config = join(root, 'tsir.js');
    const text = await readFile(config, 'utf8');
    const marker = "        requires: ['background-tasks'],";
    expect(text).toContain(marker);
    await writeFile(config, text.replace(marker, `${marker}\n        private: true,`), 'utf8');

    const checked = runCliSubprocess(['deploy:plan', '--check'], root);
    expect(checked.code).toBe(EXIT.failure);
    expect(checked.output).toContain('is stale');
    expect(checked.output).toContain('drain.visibility');
  });
});

describe('deploy:diff (DPL-004)', () => {
  test('no drift reports success', async () => {
    const root = await copyFixture();
    runCliSubprocess(['deploy:plan', '--write'], root);

    const diff = runCliSubprocess(['deploy:diff'], root);
    expect(diff.code).toBe(EXIT.ok);
    expect(diff.output).toContain('matches the resolved graph');
  });

  test('a missing snapshot is a failure with the fix in the message', async () => {
    const root = await copyFixture();
    const result = runCliSubprocess(['deploy:diff', '--json'], root);

    expect(result.code).toBe(EXIT.failure);
    const parsed = JSON.parse(result.output) as { ok: boolean; message: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('deploy:plan --write');
  });

  test('removing a unit from the config is reported as a removal', async () => {
    const root = await copyFixture();
    runCliSubprocess(['deploy:plan', '--write'], root);

    const config = join(root, 'tsir.js');
    const text = await readFile(config, 'utf8');
    const from = text.indexOf("{\n        name: 'ws',");
    const to = text.indexOf('\n      },', from) + '\n      },'.length;
    expect(from).toBeGreaterThan(0);
    await writeFile(config, `${text.slice(0, from)}${text.slice(to + 1)}`, 'utf8');

    const result = runCliSubprocess(['deploy:diff', '--json'], root);
    expect(result.code).toBe(EXIT.failure);
    const parsed = JSON.parse(result.output) as { ok: boolean; removed: string[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.removed).toEqual(['ws']);
  });
});

describe('deploy:invoke (DPL-007)', () => {
  test('a real request reaches the entry handler and comes back with status and body', async () => {
    const result = await runCli(
      ['deploy:invoke', '--unit', 'http', '--path', '/api/users', '--json'],
      HTTP_EXAMPLE,
    );

    expect(result.code).toBe(EXIT.ok);
    const parsed = JSON.parse(result.output) as {
      unit: string;
      status: number;
      body: string;
      route: string;
      routeUnit: string;
    };
    expect(parsed.unit).toBe('http');
    expect(parsed.status).toBe(200);
    expect(JSON.parse(parsed.body)).toEqual({ page: 1, perPage: 20, data: [] });
    expect(parsed.route).toBe('GET /api/users');
    expect(parsed.routeUnit).toBe('http');
  });

  test('the invocation reports the unit that owns the route, not the one that was asked for', async () => {
    const result = await runCli(
      ['deploy:invoke', '--unit', 'media', '--path', '/api/users', '--explain'],
      HTTP_EXAMPLE,
    );

    // The handler serves everything; attribution is what tells the truth about it.
    expect(result.output).toContain('route GET /api/users belongs to unit "http"');
    expect(result.output).toContain('asked for unit "media"');
  });

  test('a 422 from the pipeline is a real response, not a CLI failure', async () => {
    const result = await runCli(
      ['deploy:invoke', '--unit', 'media', '--method', 'POST', '--path', '/api/uploads', '--json'],
      HTTP_EXAMPLE,
    );

    expect(result.code).toBe(EXIT.ok);
    const parsed = JSON.parse(result.output) as { status: number; body: string };
    expect(parsed.status).toBe(422);
    expect(parsed.body).toContain('HTP_VALIDATION_FAILED');
  });

  test('an unknown unit lists the ones that exist', async () => {
    const result = await runCli(['deploy:invoke', '--unit', 'ghost'], HTTP_EXAMPLE);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('unknown unit "ghost"');
    expect(result.output).toContain('http');
  });

  test('--unit is required', async () => {
    const result = await runCli(['deploy:invoke'], HTTP_EXAMPLE);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('--unit');
  });
});

describe('the entry is imported once per process', () => {
  test('loading the same project twice does not register its routes twice', async () => {
    // The regression: `loadProject` used to import the entry with a cache-buster, so a
    // second load re-ran every decorator and `compileRoutes` reported `RTR_DUPLICATE`.
    //
    // This runs in a fresh process on purpose. Route registrations are global, so in the
    // shared `bun test` process any other suite's fixture that declares the same method and
    // path would collide with the example app before the test even started — a failure of
    // the harness, not of the code under test.
    const script = join(
      import.meta.dir,
      'fixtures',
      `.tmp-once-${String(process.pid)}-${Date.now()}.ts`,
    );
    cleanup.push(script);
    await writeFile(
      script,
      [
        `import { loadDeployInput } from ${JSON.stringify(join(import.meta.dir, 'deploy.ts'))};`,
        `const first = await loadDeployInput(${JSON.stringify(HTTP_EXAMPLE)});`,
        `const second = await loadDeployInput(${JSON.stringify(HTTP_EXAMPLE)});`,
        `const a = first.input.routes?.length ?? 0;`,
        `const b = second.input.routes?.length ?? 0;`,
        `console.log(JSON.stringify({ a, b }));`,
        `if (a === 0 || a !== b) process.exit(1);`,
      ].join('\n'),
      'utf8',
    );

    const result = Bun.spawnSync([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    const output = result.stdout.toString().trim();

    expect(result.exitCode).toBe(0);
    const counts = JSON.parse(output.split('\n').at(-1) ?? '{}') as { a: number; b: number };
    expect(counts.a).toBeGreaterThan(0);
    expect(counts.b).toBe(counts.a);
  });
});
