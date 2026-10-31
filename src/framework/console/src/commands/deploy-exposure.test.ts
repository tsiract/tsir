/**
 * `DPL-022` — a private unit stays private in the artifacts, and the gate notices when it
 * does not.
 *
 * The graph has marked `admin` units private since `DPL-001`, which on its own is a table
 * column. What this file proves is the part that reaches a cloud: the generated
 * `wrangler.*.toml` disables `workers.dev` and the generated SAM template has no HTTP API,
 * unless the project **explicitly** makes the unit public.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { EXIT } from '../output.ts';
import { type CliRun, runCliSubprocess } from '../../test-support/in-process.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'admin-app');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runCli(args: readonly string[], cwd: string): Promise<CliRun> {
  return runCliSubprocess(args, cwd);
}

async function outDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tsir-exposure-'));
  cleanup.push(dir);
  return dir;
}

/** Build both targets; returns the output directory. */
async function built(cwd: string = FIXTURE): Promise<string> {
  const out = await outDir();
  const result = await runCli(['deploy:build', '--target', 'cloudflare,lambda', '--out', out], cwd);
  expect(result.code).toBe(EXIT.ok);
  return out;
}

/** A copy of the fixture whose `admin` unit is explicitly public. */
async function publicAdminCopy(): Promise<string> {
  const parent = join(import.meta.dir, 'fixtures');
  const dir = await mkdtemp(join(parent, '.tmp-expose-'));
  cleanup.push(dir);
  await cp(FIXTURE, join(dir, 'app'), { recursive: true });

  const config = join(dir, 'app', 'tsir.js');
  const text = await readFile(config, 'utf8');
  const marker = "        triggers: [{ kind: 'http', detail: ['GET /health'] }],";
  expect(text).toContain(marker);
  await writeFile(config, text.replace(marker, `${marker}\n        private: false,`), 'utf8');
  return join(dir, 'app');
}

describe('cloudflare: no public URL for a private unit', () => {
  test('the admin config disables workers.dev and says why', async () => {
    const out = await built();
    const toml = await readFile(join(out, 'cloudflare', 'admin', 'wrangler.admin.toml'), 'utf8');

    expect(toml).toContain('workers_dev = false');
    expect(toml).toContain('private unit: no workers.dev URL and no routes');
  });

  test('the public unit keeps the default', async () => {
    const out = await built();
    const toml = await readFile(join(out, 'cloudflare', 'http', 'wrangler.http.toml'), 'utf8');

    expect(toml).not.toContain('workers_dev');
  });

  test('`private: false` is the opt-in, and it is loud in review', async () => {
    const cwd = await publicAdminCopy();
    const out = await built(cwd);
    const toml = await readFile(join(out, 'cloudflare', 'admin', 'wrangler.admin.toml'), 'utf8');

    expect(toml).not.toContain('workers_dev = false');
  });
});

describe('lambda: no endpoint for a private unit', () => {
  test('the admin template has no HTTP API and no URL output', async () => {
    const out = await built();
    const template = await readFile(join(out, 'lambda', 'admin', 'template.admin.yaml'), 'utf8');

    expect(template).toContain('private unit (DPL-022)');
    expect(template).not.toContain('AWS::Serverless::HttpApi');
    expect(template).not.toContain('Type: HttpApi');
    expect(template).not.toContain('Outputs:');
  });

  test('the public unit still serves through one', async () => {
    const out = await built();
    const template = await readFile(join(out, 'lambda', 'http', 'template.http.yaml'), 'utf8');

    expect(template).toContain('Type: HttpApi');
    expect(template).toContain('HttpApiUrl:');
    // Target vars reach the function environment, sorted.
    expect(template).toContain('APP_ENV: "production"');
  });
});

describe('deploy:validate notices an exposed private unit (DPL_PRIVATE_EXPOSED)', () => {
  test('a clean build passes', async () => {
    const out = await built();
    const result = await runCli(['deploy:validate', '--out', out], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).not.toContain('DPL_PRIVATE_EXPOSED');
  });

  test('a worker config that lost `workers_dev = false` fails the gate', async () => {
    const out = await built();
    const path = join(out, 'cloudflare', 'admin', 'wrangler.admin.toml');
    const toml = await readFile(path, 'utf8');
    await writeFile(path, toml.replace('workers_dev = false\n', ''), 'utf8');

    const result = await runCli(['deploy:validate', '--out', out], FIXTURE);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('DPL_PRIVATE_EXPOSED');
    expect(result.output).toContain('unit "admin" is private');
    expect(result.output).toContain('private: false');
  });

  test('a SAM template that grew an HTTP API fails too', async () => {
    const out = await built();
    const path = join(out, 'lambda', 'admin', 'template.admin.yaml');
    const template = await readFile(path, 'utf8');
    await writeFile(
      path,
      template.replace(
        '      CodeUri: .',
        '      CodeUri: .\n      Events:\n        HttpApi:\n          Type: HttpApi',
      ),
      'utf8',
    );

    const result = await runCli(['deploy:validate', '--out', out], FIXTURE);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('DPL_PRIVATE_EXPOSED');
    expect(result.output).toContain('API Gateway HTTP API');
  });

  test('the reverse direction is a warning, not a failure: nothing can leak', async () => {
    const out = await built();
    const path = join(out, 'cloudflare', 'http', 'wrangler.http.toml');
    const toml = await readFile(path, 'utf8');
    await writeFile(path, `${toml}workers_dev = false\n`, 'utf8');

    const result = await runCli(['deploy:validate', '--out', out], FIXTURE);

    expect(result.output).toContain('disables workers.dev but the unit is public');
    expect(result.output).not.toContain('DPL_PRIVATE_EXPOSED');
  });
});

describe('the graph already knows', () => {
  test('deploy:plan marks the admin unit private and the http unit public', async () => {
    const result = await runCli(['deploy:plan', '--json'], FIXTURE);
    const parsed = JSON.parse(result.output) as {
      units: { name: string; private: boolean }[];
    };

    expect(parsed.units.map((unit) => [unit.name, unit.private])).toEqual([
      ['admin', true],
      ['http', false],
    ]);
  });
});
