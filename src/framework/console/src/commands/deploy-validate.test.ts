/**
 * `tsir deploy:validate` — the release gate (`DPL-019`, `DPL-012`, `DPL-020`).
 *
 * Every test here starts from a **real build in a subprocess**, then breaks one thing about
 * it and asserts the gate notices. That is the only shape of test that proves a gate: a
 * validator that passes when nothing is wrong is indistinguishable from `exit 0`.
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { EXIT } from '../output.ts';
import { BUILD_FILE, kibibytes } from './deploy-build.ts';
import { formatValidation, type ValidationReport } from './deploy-validate.ts';
import { type CliRun, runCliSubprocess } from '../../test-support/in-process.ts';

const HTTP_EXAMPLE = join(import.meta.dir, '..', '..', '..', '..', 'apps', 'examples', 'http');
const BUDGET_FIXTURE = join(import.meta.dir, 'fixtures', 'budget-app');
const CLI = join(import.meta.dir, '..', 'cli.ts');

/** A real credential shape we must never echo. Used to prove the scanner redacts. */
const SYNTHETIC_KEY = 'AKIAIOSFODNN7EXAMPLE';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runCli(args: readonly string[], cwd: string): Promise<CliRun> {
  return runCliSubprocess(args, cwd);
}

async function outDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tsir-validate-'));
  cleanup.push(dir);
  return dir;
}

/** Build the example app into a temp directory; returns the directory. */
async function builtExample(): Promise<string> {
  const out = await outDir();
  const build = await runCli(
    ['deploy:build', '--target', 'cloudflare,lambda', '--out', out],
    HTTP_EXAMPLE,
  );
  expect(build.code).toBe(EXIT.ok);
  return out;
}

describe('a clean build', () => {
  test('passes, and says what it looked at', async () => {
    const out = await builtExample();
    const result = await runCli(['deploy:validate', '--out', out], HTTP_EXAMPLE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('4 artifact(s)');
    expect(result.output).toContain('no secret values in');
    expect(result.output).toContain('graph valid for cloudflare, lambda');
  });

  test('the report counts files, not artifacts: configs and the graph are scanned too', async () => {
    const out = await builtExample();
    const result = await runCli(['deploy:validate', '--out', out, '--json'], HTTP_EXAMPLE);
    const report = JSON.parse(result.output.slice(result.output.indexOf('{'))) as ValidationReport;

    expect(report.ok).toBe(true);
    // 4 bundles + 2 wrangler configs + 2 SAM templates + 2 unit-graph.json + build.json
    expect(report.scanned).toBe(11);
    expect(report.artifacts.map((artifact) => artifact.file).sort()).toEqual([
      'cloudflare/http/index.js',
      'cloudflare/media/index.js',
      'lambda/http/index.mjs',
      'lambda/media/index.mjs',
    ]);
  });

  test('a missing build document is a report with the one command that fixes it', async () => {
    const out = await outDir();
    const result = await runCli(['deploy:validate', '--out', out], HTTP_EXAMPLE);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain(`${BUILD_FILE} in`);
    expect(result.output).toContain('tsir deploy:build');
  });
});

describe('a build with a secret in it (DPL-020)', () => {
  test('a synthetic key in a bundle fails the gate, and the key is never printed', async () => {
    const out = await builtExample();
    await appendFile(
      join(out, 'cloudflare', 'http', 'index.js'),
      `\nconst LEAK = "${SYNTHETIC_KEY}";\n`,
    );

    const result = await runCli(['deploy:validate', '--out', out], HTTP_EXAMPLE);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('DPL_SECRET_LEAK');
    expect(result.output).toContain('aws-access-key-id');
    expect(result.output).toContain('[redacted]');
    expect(result.output).not.toContain(SYNTHETIC_KEY);
  });

  test('a declared secret assigned a value is found by name', async () => {
    const out = await outDir();
    const build = await runCli(
      ['deploy:build', '--target', 'cloudflare', '--out', out, '--allow-size-regression'],
      BUDGET_FIXTURE,
    );
    expect(build.code).toBe(EXIT.ok);

    const config = join(out, 'cloudflare', 'http', 'wrangler.http.toml');
    expect(await readFile(config, 'utf8')).toContain('#   wrangler secret put APP_KEY');

    // This fixture is over its (deliberately tiny) budget, so the gate already fails — what
    // matters here is that a *clean* generated config produces no findings of its own.
    const cleanOutput = (await runCli(['deploy:validate', '--out', out, '--json'], BUDGET_FIXTURE))
      .output;
    const before = JSON.parse(cleanOutput.slice(cleanOutput.indexOf('{'))) as ValidationReport;
    expect(before.findings).toEqual([]);
    expect(before.secretNames).toEqual(['APP_KEY']);

    await appendFile(config, '\nAPP_KEY = "base64:notarealkeybutlongenough"\n');
    const result = await runCli(['deploy:validate', '--out', out], BUDGET_FIXTURE);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('APP_KEY (value assigned)');
    expect(result.output).not.toContain('notarealkeybutlongenough');
  });

  test('the JSON report carries findings without the value', async () => {
    const out = await builtExample();
    await appendFile(join(out, 'lambda', 'http', 'index.mjs'), `\n// ${SYNTHETIC_KEY}\n`);

    const result = await runCli(['deploy:validate', '--out', out, '--json'], HTTP_EXAMPLE);
    const report = JSON.parse(result.output.slice(result.output.indexOf('{'))) as ValidationReport;

    expect(result.code).toBe(EXIT.failure);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.pattern).toBe('aws-access-key-id');
    expect(JSON.stringify(report)).not.toContain(SYNTHETIC_KEY);
  });
});

describe('a build that no longer describes itself', () => {
  test('an artifact edited after the build is stale', async () => {
    const out = await builtExample();
    await appendFile(join(out, 'cloudflare', 'media', 'index.js'), '\n// edited\n');

    const result = await runCli(['deploy:validate', '--out', out], HTTP_EXAMPLE);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('changed since the build');
  });

  test('an artifact deleted after the build is missing', async () => {
    const out = await builtExample();
    await unlink(join(out, 'lambda', 'media', 'index.mjs'));

    const result = await runCli(['deploy:validate', '--out', out], HTTP_EXAMPLE);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('but missing from disk');
  });

  test('a budget that the build exceeded fails the gate (DPL-011)', async () => {
    const out = await outDir();
    expect(
      (
        await runCli(
          ['deploy:build', '--target', 'cloudflare', '--out', out, '--allow-size-regression'],
          BUDGET_FIXTURE,
        )
      ).code,
    ).toBe(EXIT.ok);

    const result = await runCli(['deploy:validate', '--out', out], BUDGET_FIXTURE);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('DPL_SIZE_BUDGET');
    expect(result.output).toContain('budget 1.0 KiB');
  });

  test('a build document that is not JSON is a usage error, not a crash', async () => {
    const out = await outDir();
    await writeFile(join(out, BUILD_FILE), '{ not json', 'utf8');

    const result = await runCli(['deploy:validate', '--out', out], HTTP_EXAMPLE);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('deploy:build');
  });
});

describe('the report format', () => {
  test('a clean report has no failures in it', async () => {
    const report: ValidationReport = {
      ok: true,
      outDir: 'dist',
      targets: ['cloudflare'],
      artifacts: [
        {
          target: 'cloudflare',
          unit: 'http',
          file: 'cloudflare/http/index.js',
          bytes: 4096,
          gzipBytes: 2048,
          budget: 1_048_576,
          overBudget: false,
          stale: false,
          missing: false,
        },
      ],
      findings: [],
      problems: [],
      warnings: [],
      missingBuild: false,
      secretNames: [],
      scanned: 1,
    };

    const text = formatValidation(report);
    expect(text).toContain('1 artifact(s)');
    expect(text).toContain(kibibytes(2048));
    expect(text).not.toContain('✗');
  });

  test('a missing build prints one instruction', async () => {
    const text = formatValidation({
      ok: false,
      outDir: 'dist',
      targets: [],
      artifacts: [],
      findings: [],
      problems: [],
      warnings: [],
      missingBuild: true,
      secretNames: [],
      scanned: 0,
    });

    expect(text).toContain('run `tsir deploy:build` first');
  });
});

describe('the command surface', () => {
  test('it is listed as available, not planned', async () => {
    const help = Bun.spawnSync([process.execPath, CLI, 'help'], { stdout: 'pipe', stderr: 'pipe' });
    const text = help.stdout.toString();

    expect(text).toContain('deploy:validate');
    const planned = text.slice(text.indexOf('planned'));
    expect(planned).not.toContain('deploy:validate');
  });

  test('an unknown build directory is reported, not thrown', async () => {
    const missing = await outDir();
    const result = await runCli(['deploy:validate', '--out', join(missing, 'nope')], HTTP_EXAMPLE);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('tsir deploy:build');
    expect(existsSync(join(missing, 'nope'))).toBe(false);
  });
});
