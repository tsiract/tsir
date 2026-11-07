/**
 * `tsir deploy:build` (`DPL-009`, `DPL-014`, `DPL-018`).
 *
 * The tests are in two layers on purpose:
 *
 *   · **Pure functions** — the generated entry text, trigger→export mapping, budgets. These
 *     are what a reader has to be convinced of, and they need no bundler.
 *   · **A real build, then a real request.** Every artifact assertion is followed by
 *     importing the emitted file and calling it: a Cloudflare bundle with a `fetch` export
 *     must answer `GET /api/users`, a Lambda bundle must return an API Gateway v2 response.
 *     A test that only checked for a non-empty file would pass for a bundle that throws on
 *     the first line.
 *
 * Builds run in a subprocess for the same reason the other deploy commands do: route
 * discovery imports the entry and registers controllers process-wide.
 */

import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { EXIT } from '../output.ts';
import {
  adapterTriggers,
  budgetFor,
  BUILD_FILE,
  buildJson,
  DEFAULT_BUDGETS,
  formatBuild,
  kibibytes,
  requiredExports,
  unitEntrySource,
  type Artifact,
} from './deploy-build.ts';
import type { Unit } from '@tsir/deploy';
import { type CliRun, runCliSubprocess } from '../../test-support/in-process.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'deploy-app');
const BUDGET_FIXTURE = join(import.meta.dir, 'fixtures', 'budget-app');
const HTTP_EXAMPLE = join(import.meta.dir, 'fixtures', 'http-app');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runCli(args: readonly string[], cwd: string): Promise<CliRun> {
  return runCliSubprocess(args, cwd);
}

/** A build directory outside the checkout, so a failing test cannot pollute `dist/`. */
async function outDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tsir-build-'));
  cleanup.push(dir);
  return dir;
}

function unit(overrides: Partial<Unit> & Pick<Unit, 'name' | 'kind'>): Unit {
  return {
    modules: [],
    reasons: [],
    triggers: [],
    requires: [],
    bindings: [],
    private: false,
    ...overrides,
  };
}

describe('what a unit needs from the entry', () => {
  test('http and websocket are both `fetch`; queue and cron get their own trigger', async () => {
    expect(
      adapterTriggers(
        unit({ name: 'a', kind: 'http', triggers: [{ kind: 'http', detail: ['GET /x'] }] }),
      ),
    ).toEqual(['fetch']);
    expect(
      adapterTriggers(
        unit({ name: 'ws', kind: 'ws', triggers: [{ kind: 'websocket', detail: ['/ws'] }] }),
      ),
    ).toEqual(['fetch']);
    expect(
      adapterTriggers(
        unit({
          name: 'q',
          kind: 'queue',
          triggers: [
            { kind: 'queue', detail: ['jobs'] },
            { kind: 'cron', detail: ['*/5 * * * *'] },
          ],
        }),
      ),
    ).toEqual(['queue', 'scheduled']);
  });

  test('a console-only unit has nothing to deploy', async () => {
    expect(
      adapterTriggers(
        unit({ name: 'c', kind: 'admin', triggers: [{ kind: 'manual', detail: ['x'] }] }),
      ),
    ).toEqual([]);
  });

  test('the export names are the contract: handler, queue, scheduled', async () => {
    expect(requiredExports(['fetch', 'queue', 'scheduled'])).toEqual([
      'handler',
      'queue',
      'scheduled',
    ]);
  });
});

describe('the generated entry', () => {
  const spec = {
    target: 'cloudflare' as const,
    unit: 'http',
    triggers: ['fetch'] as const,
    adapter: '/abs/cloudflare.ts',
    entry: '/abs/src/app.ts',
  };

  test('a fetch unit exports only `fetch` — no queue, no scheduled', async () => {
    const source = unitEntrySource({ ...spec, triggers: ['fetch'] });

    expect(source).toContain('import { toCloudflareHandler } from "/abs/cloudflare.ts";');
    expect(source).toContain('import { handler as __fetch } from "/abs/src/app.ts";');
    expect(source).toContain('export const { fetch } = toCloudflareHandler({');
    expect(source).toContain('unit: "http"');
    expect(source).not.toContain('queue');
    expect(source).not.toContain('scheduled');
  });

  test('every trigger a unit declares is wired, and no others', async () => {
    const source = unitEntrySource({ ...spec, triggers: ['fetch', 'queue', 'scheduled'] });

    expect(source).toContain('handler as __fetch, queue as __queue, scheduled as __scheduled');
    expect(source).toContain('export const { fetch, queue, scheduled } =');
  });

  test('Lambda exports one `handler`, not three', async () => {
    const source = unitEntrySource({ ...spec, target: 'lambda', adapter: '/abs/lambda.ts' });

    expect(source).toContain('import { toLambdaHandler } from "/abs/lambda.ts";');
    expect(source).toContain('export const handler = toLambdaHandler({');
  });

  test('the same unit generates the same bytes', async () => {
    expect(unitEntrySource(spec)).toBe(unitEntrySource(spec));
  });
});

describe('budgets', () => {
  test('a declared budget wins over the platform default', async () => {
    expect(budgetFor('cloudflare', [{ target: 'cloudflare', sizeBudget: 2048 }])).toBe(2048);
    expect(budgetFor('cloudflare', [])).toBe(DEFAULT_BUDGETS.cloudflare);
  });

  test('bun has no budget: it is a machine the operator owns', async () => {
    expect(budgetFor('bun', [])).toBe(Number.POSITIVE_INFINITY);
  });

  test('the human report says when an artifact is over', async () => {
    const artifact: Artifact = {
      target: 'cloudflare',
      unit: 'http',
      file: 'cloudflare/http/index.js',
      bytes: 4_194_304,
      gzipBytes: 2_097_152,
      budget: 1_048_576,
      triggers: ['fetch'],
    };
    const text = formatBuild({
      app: 'x',
      topology: 'separate',
      outDirName: 'dist',
      targets: ['cloudflare'],
      artifacts: [artifact],
      warnings: [],
    });

    expect(text).toContain('cloudflare/http/index.js');
    expect(text).toContain('— over');
    expect(text).toContain('2048.0 KiB');
  });

  test('an unbounded budget is `null` in the build document, not Infinity', async () => {
    const document = buildJson(
      {
        root: '/x',
        outDir: '/x/dist',
        outDirName: 'dist',
        app: 'app',
        topology: 'separate',
        graph: {
          schemaVersion: 1,
          app: 'app',
          topology: 'separate',
          merged: [],
          targets: [],
          units: [],
        },
        problems: [],
        targets: ['bun'],
        configured: [],
        entryPath: '/x/src/app.ts',
        provided: new Set(['handler']),
        connections: {},
        cloudflare: undefined,
        lambda: undefined,
        minify: false,
        allowSizeRegression: false,
      },
      [
        {
          target: 'bun',
          unit: 'server',
          file: 'bun/server.mjs',
          bytes: 10,
          gzipBytes: 8,
          budget: Number.POSITIVE_INFINITY,
          triggers: ['fetch'],
        },
      ],
      [],
    ) as { artifacts: { budget: number | null }[] };

    expect(document.artifacts[0]?.budget).toBeNull();
  });

  test('kibibytes are kibibytes', async () => {
    expect(kibibytes(1024)).toBe('1.0 KiB');
  });
});

describe('a real build (DPL-018)', () => {
  test('cloudflare: one bundle and one wrangler config per unit, plus the graph', async () => {
    const out = await outDir();
    const result = await runCli(
      ['deploy:build', '--target', 'cloudflare', '--out', out],
      HTTP_EXAMPLE,
    );

    expect(result.code).toBe(EXIT.ok);
    const [http, media] = await Promise.all([
      readFile(join(out, 'cloudflare', 'http', 'index.js'), 'utf8'),
      readFile(join(out, 'cloudflare', 'media', 'index.js'), 'utf8'),
    ]);
    expect(http.length).toBeGreaterThan(0);
    expect(media.length).toBeGreaterThan(0);

    const wrangler = await readFile(join(out, 'cloudflare', 'http', 'wrangler.http.toml'), 'utf8');
    expect(wrangler).toContain('name = "http-example-http"');
    expect(wrangler).toContain('main = "index.js"');
    expect(wrangler).toContain('compatibility_date = "2026-09-01"');

    const graph = JSON.parse(
      await readFile(join(out, 'cloudflare', 'unit-graph.json'), 'utf8'),
    ) as {
      app: string;
    };
    expect(graph.app).toBe('http-example');

    const build = JSON.parse(await readFile(join(out, BUILD_FILE), 'utf8')) as {
      artifacts: { target: string; unit: string; file: string; budget: number | null }[];
    };
    expect(build.artifacts.map((artifact) => artifact.file).sort()).toEqual([
      'cloudflare/http/index.js',
      'cloudflare/media/index.js',
    ]);
    expect(build.artifacts[0]?.budget).toBe(DEFAULT_BUDGETS.cloudflare);
  });

  test('the emitted Worker answers a request', async () => {
    const out = await outDir();
    expect(
      (await runCli(['deploy:build', '--target', 'cloudflare', '--out', out], HTTP_EXAMPLE)).code,
    ).toBe(EXIT.ok);

    const worker = (await import(join(out, 'cloudflare', 'http', 'index.js'))) as {
      fetch: (
        request: Request,
        env: unknown,
        execution: { waitUntil(p: Promise<unknown>): void },
      ) => Promise<Response>;
      queue?: unknown;
      scheduled?: unknown;
    };

    expect(worker.queue).toBeUndefined();
    expect(worker.scheduled).toBeUndefined();

    const response = await worker.fetch(
      new Request('http://localhost/api/users'),
      {},
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual({ page: 1, perPage: 20, data: [] });
  });

  test('lambda: a SAM template per unit, next to the bundle it describes (DPL-016)', async () => {
    const out = await outDir();
    expect(
      (await runCli(['deploy:build', '--target', 'lambda', '--out', out], HTTP_EXAMPLE)).code,
    ).toBe(EXIT.ok);

    const template = await readFile(join(out, 'lambda', 'http', 'template.http.yaml'), 'utf8');
    expect(template).toContain('Type: AWS::Serverless::HttpApi');
    expect(template).toContain('CodeUri: .');
    expect(template).toContain('Handler: index.handler');
    expect(template).toContain('`sam deploy` is yours to run');

    const build = JSON.parse(await readFile(join(out, BUILD_FILE), 'utf8')) as {
      templates: { unit: string; file: string }[];
    };
    expect(build.templates).toEqual([
      { unit: 'http', file: 'lambda/http/template.http.yaml' },
      { unit: 'media', file: 'lambda/media/template.media.yaml' },
    ]);
  });

  test('the emitted Lambda handler answers an API Gateway v2 event', async () => {
    const out = await outDir();
    expect(
      (await runCli(['deploy:build', '--target', 'lambda', '--out', out], HTTP_EXAMPLE)).code,
    ).toBe(EXIT.ok);

    const lambda = (await import(join(out, 'lambda', 'http', 'index.mjs'))) as {
      handler: (
        event: unknown,
        context: { getRemainingTimeInMillis(): number },
      ) => Promise<{ statusCode: number; body: string; headers: Record<string, string> }>;
    };

    const result = await lambda.handler(
      {
        version: '2.0',
        rawPath: '/api/users',
        rawQueryString: '',
        headers: {},
        requestContext: { http: { method: 'GET', path: '/api/users' }, domainName: 'example.com' },
      },
      { getRemainingTimeInMillis: () => 30_000 },
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ page: 1, perPage: 20, data: [] });
  });

  test('the bun target writes one server that boots', async () => {
    const out = await outDir();
    expect(
      (await runCli(['deploy:build', '--target', 'bun', '--out', out], HTTP_EXAMPLE)).code,
    ).toBe(EXIT.ok);

    const child = Bun.spawn([process.execPath, join(out, 'bun', 'server.mjs')], {
      env: { ...process.env, PORT: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Read one line, then stop it: the server is a long-running process by definition, so
    // waiting for the stream to end would wait for the timeout.
    const reader = child.stdout.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
    ]);
    child.kill();

    const text = first === undefined ? '' : new TextDecoder().decode(first.value);
    expect(text).toContain('tsir: listening on http://localhost:');
  });

  test('--json reports the same artifacts as the file', async () => {
    const out = await outDir();
    const result = await runCli(
      ['deploy:build', '--target', 'cloudflare', '--out', out, '--json'],
      HTTP_EXAMPLE,
    );

    expect(result.code).toBe(EXIT.ok);
    const parsed = JSON.parse(result.output.slice(result.output.indexOf('{'))) as {
      ok: boolean;
      artifacts: { file: string; gzipBytes: number }[];
    };
    expect(parsed.ok).toBe(true);
    // Real bytes, measured: a zero here would mean the size was never taken.
    expect(parsed.artifacts.every((artifact) => artifact.gzipBytes > 0)).toBe(true);
  });

  test('an unknown --target is a usage error, before anything is read', async () => {
    const result = await runCli(['deploy:build', '--target', 'lamda'], HTTP_EXAMPLE);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('unknown target "lamda"');
    expect(result.output).toContain('bun, cloudflare, lambda');
  });

  test('a unit whose entry cannot back it stops the build (DPL_UNIT_EMPTY)', async () => {
    const result = await runCli(
      ['deploy:build', '--target', 'cloudflare', '--out', '/tmp/tsir-never'],
      FIXTURE,
    );

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('DPL_UNIT_EMPTY');
    expect(result.output).toContain('handler');
  });

  test('an over-budget artifact fails the build (DPL-011)', async () => {
    const out = await outDir();
    const result = await runCli(
      ['deploy:build', '--target', 'cloudflare', '--out', out],
      BUDGET_FIXTURE,
    );

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('DPL_SIZE_BUDGET');
    expect(result.output).toContain('budget 1.0 KiB');
    // Written anyway: a build that hides the artifact it rejected cannot be inspected.
    expect(existsSync(join(out, 'cloudflare', 'http', 'index.js'))).toBe(true);
  });

  test('--allow-size-regression is the only way past the budget', async () => {
    const out = await outDir();
    const result = await runCli(
      ['deploy:build', '--target', 'cloudflare', '--out', out, '--allow-size-regression'],
      BUDGET_FIXTURE,
    );

    expect(result.code).toBe(EXIT.ok);
  });

  test('--minify shrinks the artifact', async () => {
    const plain = await outDir();
    const minified = await outDir();
    const args = ['deploy:build', '--target', 'cloudflare', '--allow-size-regression'];

    await runCli([...args, '--out', plain], BUDGET_FIXTURE);
    await runCli([...args, '--out', minified, '--minify'], BUDGET_FIXTURE);

    const sizeOf = async (dir: string): Promise<number> => {
      const document = JSON.parse(await readFile(join(dir, BUILD_FILE), 'utf8')) as {
        artifacts: { gzipBytes: number }[];
      };
      return document.artifacts[0]?.gzipBytes ?? 0;
    };

    expect(await sizeOf(minified)).toBeLessThan(await sizeOf(plain));
  });

  test('with no configured targets, the default is the bun server', async () => {
    // The example app declares no `deploy.targets`, so this is the "just give me something
    // runnable" path: one server, no per-unit functions.
    const out = await outDir();
    const result = await runCli(['deploy:build', '--out', out], HTTP_EXAMPLE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('bun → ');
    expect(existsSync(join(out, 'bun', 'server.mjs'))).toBe(true);
    expect(existsSync(join(out, 'cloudflare'))).toBe(false);
  });
});

describe('a schedule unit (§ 4.6)', () => {
  const SCHEDULE_FIXTURE = join(import.meta.dir, 'fixtures', 'schedule-app');

  /** The fixture with a `deploy` block, and optionally a `scheduled` export of the app's own. */
  async function scheduleApp(edit?: (entry: string, dir: string) => string): Promise<string> {
    const dir = await mkdtemp(join(import.meta.dir, 'fixtures', '.tmp-build-schedule-'));
    cleanup.push(dir);
    await cp(SCHEDULE_FIXTURE, dir, { recursive: true });
    await rm(join(dir, '.locks.json'), { force: true });
    await rm(join(dir, '.ran.log'), { force: true });

    const configPath = join(dir, 'tsir.js');
    await writeFile(
      configPath,
      (await readFile(configPath, 'utf8')).replace(
        'export default {',
        'export default {\n  deploy: { targets: { cloudflare: {} } },',
      ),
      'utf8',
    );

    if (edit !== undefined) {
      const entryPath = join(dir, 'src', 'app.ts');
      await writeFile(entryPath, edit(await readFile(entryPath, 'utf8'), dir), 'utf8');
    }
    return dir;
  }

  test('a project with tasks but no `scheduled` export is told the shape to write', async () => {
    const cwd = await scheduleApp();
    const out = await outDir();

    const result = runCliSubprocess(['deploy:build', '--out', out], cwd);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('DPL_UNIT_EMPTY');
    // The one export an app cannot guess: the hint is the line, not a pointer at a doc.
    expect(result.output).toContain('scheduler.scheduled({ at: controller.scheduledTime })');
    expect(result.output).toContain('createScheduler({ tasks, lock })');
  });

  test('the emitted Worker runs the tasks that are due, and reports every outcome', async () => {
    const cwd = await scheduleApp(
      (entry) =>
        entry
          // A deployed Worker takes a per-process lock in this smoke test; `--production` is what
          // refuses that, and it is the app's call to make (`SCHED_LOCK_NOT_SHARED`).
          .replace(
            "import { fileLock } from './file-lock.ts';",
            "import { createScheduler, memoryLock } from '@tsir/schedule';",
          )
          .replace('export const lock = fileLock();', 'export const lock = memoryLock();') +
        [
          '',
          'const scheduler = createScheduler({ tasks, lock });',
          '',
          '// No filesystem in a Worker: the fixture writes `.ran.log` for the CLI tests, and this',
          '// copy records nothing — the outcomes below are the evidence.',
          'sink.record = () => undefined;',
          '',
          '/**',
          ' * The one line a deployed schedule writes (§ 4.6).',
          ' *',
          " * The outcomes go back through `env` because the platform ignores a handler's return value",
          ' * — the adapter swallows it, exactly as `waitUntil` would — and a test that read the return',
          ' * value would be testing an interface no Worker has.',
          ' */',
          'export const scheduled = async (',
          '  controller: { scheduledTime: number },',
          '  env: { outcomes?: unknown },',
          ') => {',
          '  env.outcomes = await scheduler.scheduled({ at: controller.scheduledTime });',
          '};',
          '',
        ].join('\n'),
    );
    const out = await outDir();

    const built = runCliSubprocess(['deploy:build', '--out', out], cwd);
    expect(built.code).toBe(EXIT.ok);

    const worker = (await import(join(out, 'cloudflare', 'schedule', 'index.js'))) as {
      scheduled: (controller: { scheduledTime: number }, env: unknown) => Promise<void>;
    };

    // 01:00 UTC on a Sunday: `hourly` and `broken` are due, `nightly` and `manila-report` are
    // not. The adapter hands over the fire time, and the scheduler decides — not the adapter.
    const env: { outcomes?: unknown } = {};
    await worker.scheduled({ scheduledTime: Date.parse('2026-11-01T01:00:00Z') }, env);

    const outcomes = env.outcomes as { task: string; status: string; trigger: string }[];
    expect(outcomes.map((outcome) => `${outcome.task}:${outcome.status}`)).toEqual([
      'hourly:ran',
      'broken:failed',
    ]);
    // `cron`, not `manual`: this is the platform's tick, and it is the first thing anyone asks
    // about when a task ran at an odd hour.
    expect(outcomes.every((outcome) => outcome.trigger === 'cron')).toBe(true);
  });
});
