/**
 * `tsir bootstrap` (`DPL-023`, `CFG-120`).
 *
 * The command edits the one file a framework must not own, so the tests are about the
 * boundaries rather than the happy path: it writes only inside its fence, it refuses when
 * someone else already owns `deploy`, and it is safe to run twice.
 *
 * Every test works on a copy: a test that mutates the fixture would make the *next* test's
 * starting point depend on the order it ran in.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { EXIT } from '../output.ts';
import { DEPLOY_REGION, deployBlockLines, detectTargets, unmanagedDeploy } from './bootstrap.ts';
import { type CliRun, runCliInProcess, runCliSubprocess } from '../../test-support/in-process.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'bootstrap-app');
const CLI = join(import.meta.dir, '..', 'cli.ts');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runCli(args: readonly string[], cwd: string): Promise<CliRun> {
  return runCliInProcess(args, { cwd });
}

/** A writable copy of the fixture inside the package, so `@tsir/*` still resolves. */
async function copy(
  options: { readonly extraFiles?: readonly string[]; readonly marker?: string } = {},
): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, 'fixtures', '.tmp-bootstrap-'));
  cleanup.push(dir);
  await cp(FIXTURE, join(dir, 'app'), { recursive: true });

  const root = join(dir, 'app');
  for (const file of options.extraFiles ?? []) await writeFile(join(root, file), '', 'utf8');
  if (options.marker !== undefined) await writeFile(join(root, options.marker), '', 'utf8');
  return root;
}

async function configOf(root: string): Promise<string> {
  return readFile(join(root, 'tsir.js'), 'utf8');
}

describe('detection', () => {
  test('a target is detected from the file that proves it, and the plan says which', async () => {
    const cloudflare = await copy({ extraFiles: ['wrangler.toml'] });
    const lambda = await copy({ extraFiles: ['template.yaml'] });
    const bun = await copy({ extraFiles: ['Dockerfile'] });

    expect(detectTargets(cloudflare)).toEqual([{ target: 'cloudflare', why: ['wrangler.toml'] }]);
    expect(detectTargets(lambda)).toEqual([{ target: 'lambda', why: ['template.yaml'] }]);
    expect(detectTargets(bun)).toEqual([{ target: 'bun', why: ['Dockerfile'] }]);
  });

  test('nothing detected means nothing invented: bun is the default, and it says so', async () => {
    const bare = await copy();

    expect(detectTargets(bare)).toEqual([]);
    const result = await runCli(['bootstrap', '--plan'], bare);
    expect(result.output).toContain('no target marker found');
    expect(result.output).toContain('bun: {}');
  });
});

describe('the block it writes', () => {
  test('the lines are relative, so the block renders at any indent', async () => {
    const lines = deployBlockLines({ topology: 'single', targets: ['cloudflare'], explicit: true });

    expect(lines).toEqual([
      'deploy: {',
      "  topology: 'single',",
      '  targets: {',
      '    cloudflare: { bindings: {} },',
      '  },',
      '},',
    ]);
  });

  test('`--plan` prints the diff and writes nothing', async () => {
    const root = await copy({ extraFiles: ['wrangler.toml'] });
    const before = await configOf(root);

    const result = runCliSubprocess(['bootstrap', '--plan'], root);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('cloudflare: wrangler.toml');
    expect(result.output).toContain('managed:deploy:start');
    expect(result.output).toContain('nothing written');
    expect(await configOf(root)).toBe(before);
  });

  test('without `--yes` it plans; with it, it applies — inside the fence only', async () => {
    const root = await copy({ extraFiles: ['wrangler.toml'] });
    const result = runCliSubprocess(['bootstrap', '--yes'], root);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain(`updated tsir.js (managed:${DEPLOY_REGION}, created)`);

    const after = await configOf(root);
    // The comments and `app` are untouched; the deploy block is inside its fences.
    expect(after).toContain('// The bootstrap fixture');
    expect(after).toContain("    name: 'bootstrap-app',");
    expect(after).toContain('  // ── managed:deploy:start ─');
    expect(after.indexOf('managed:deploy:start')).toBeLessThan(after.indexOf('deploy: {'));
    expect(after.indexOf('managed:deploy:end')).toBeGreaterThan(
      after.indexOf("topology: 'separate'"),
    );
    expect(after.indexOf('managed:deploy:end')).toBeLessThan(after.lastIndexOf('};'));
  });

  test('a second run is a no-op', async () => {
    const root = await copy({ extraFiles: ['wrangler.toml'] });
    runCliSubprocess(['bootstrap', '--yes'], root);
    const once = await configOf(root);

    const second = runCliSubprocess(['bootstrap', '--yes'], root);

    expect(second.output).toContain('already declares this deploy block');
    expect(await configOf(root)).toBe(once);
  });

  test('`--topology single` rewrites the region and nothing else', async () => {
    const root = await copy({ extraFiles: ['wrangler.toml'] });
    runCliSubprocess(['bootstrap', '--yes'], root);
    const before = await configOf(root);

    const plan = runCliSubprocess(['bootstrap', '--plan', '--topology', 'single'], root);
    expect(plan.output).toContain("-     topology: 'separate',");
    expect(plan.output).toContain("+     topology: 'single',");

    runCliSubprocess(['bootstrap', '--yes', '--topology', 'single'], root);
    const after = await configOf(root);

    expect(after).toContain("topology: 'single'");
    expect(after.replace("'single'", "'separate'")).toBe(before);
  });

  test('`--target` overrides detection, because a plan was asked for', async () => {
    const root = await copy({ extraFiles: ['wrangler.toml'] });
    const result = runCliSubprocess(['bootstrap', '--yes', '--target', 'cloudflare,lambda'], root);

    expect(result.code).toBe(EXIT.ok);
    const after = await configOf(root);
    expect(after).toContain('cloudflare: { bindings: {} },');
    expect(after).toContain('lambda: {},');
  });

  test('the written file is the config `deploy:plan` then reads', async () => {
    const root = await copy({ extraFiles: ['wrangler.toml', 'template.yaml'] });
    runCliSubprocess(['bootstrap', '--yes'], root);

    const plan = runCliSubprocess(['deploy:plan', '--json'], root);
    const parsed = JSON.parse(plan.output) as { targets: string[]; topology: string };

    expect(plan.code).toBe(EXIT.ok);
    expect(parsed.targets).toEqual(['cloudflare', 'lambda']);
    expect(parsed.topology).toBe('separate');
  });
});

describe('what it refuses', () => {
  test('a hand-written deploy block is not overwritten', async () => {
    const root = await copy();
    await writeFile(
      join(root, 'tsir.js'),
      [
        'export default {',
        "  app: { name: 'x', entry: './src/app.ts' },",
        "  deploy: { topology: 'single' },",
        '};',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await runCli(['bootstrap', '--yes'], root);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('already declares `deploy` outside the managed region');
    expect(await configOf(root)).toContain("deploy: { topology: 'single' },");
  });

  test('a malformed region is a config error, not a repair', async () => {
    const root = await copy();
    await writeFile(
      join(root, 'tsir.js'),
      ['export default {', '  // ── managed:deploy:start ──', '  app: {},', '};', ''].join('\n'),
      'utf8',
    );

    const result = await runCli(['bootstrap', '--yes'], root);

    expect(result.code).toBe(EXIT.environment);
    expect(result.output).toContain('CFG_MANAGED_REGION_INVALID');
    expect(result.output).toContain('never closed');
  });

  test('a bad --topology and an unknown --target are usage errors', async () => {
    const root = await copy({ extraFiles: ['wrangler.toml'] });

    const topology = await runCli(['bootstrap', '--plan', '--topology', 'cluster'], root);
    expect(topology.code).toBe(EXIT.usage);
    expect(topology.output).toContain('separate');

    const target = await runCli(['bootstrap', '--plan', '--target', 'heroku'], root);
    expect(target.code).toBe(EXIT.usage);
    expect(target.output).toContain('heroku');
  });
});

describe('the helper the CLI uses', () => {
  test('`unmanagedDeploy` sees a deploy key outside every region', async () => {
    expect(unmanagedDeploy('export default {\n  deploy: {},\n};')).toBe(true);
    expect(
      unmanagedDeploy(
        [
          'export default {',
          '  // ── managed:deploy:start ──',
          '  deploy: {},',
          '  // ── managed:deploy:end ──',
          '};',
        ].join('\n'),
      ),
    ).toBe(false);
    expect(unmanagedDeploy('export default {\n  app: {},\n};')).toBe(false);
  });
});

describe('the command surface', () => {
  test('it is listed as available', async () => {
    const help = Bun.spawnSync([process.execPath, CLI, 'help'], { stdout: 'pipe', stderr: 'pipe' });
    const text = help.stdout.toString();

    expect(text).toContain('bootstrap');
    expect(text.slice(text.indexOf('planned'))).not.toContain('bootstrap');
  });

  test('--json carries the diff, the targets and the detection', async () => {
    const root = await copy({ extraFiles: ['wrangler.toml'] });
    const result = await runCli(['bootstrap', '--plan', '--json'], root);
    const parsed = JSON.parse(result.output.slice(result.output.indexOf('{'))) as {
      ok: boolean;
      region: string;
      created: boolean;
      applied: boolean;
      targets: string[];
      detections: { target: string; why: string[] }[];
      diff: string;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.region).toBe('deploy');
    expect(parsed.created).toBe(true);
    expect(parsed.applied).toBe(false);
    expect(parsed.targets).toEqual(['cloudflare']);
    expect(parsed.detections).toEqual([{ target: 'cloudflare', why: ['wrangler.toml'] }]);
    expect(parsed.diff).toContain('managed:deploy:start');
  });
});

describe('detection signals beyond marker files (CFG-109)', () => {
  test('a wrangler dependency means Cloudflare, and the plan names the package', async () => {
    const root = await copy();
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'app', devDependencies: { wrangler: '4.0.0' } }),
      'utf8',
    );

    expect(detectTargets(root)).toEqual([
      { target: 'cloudflare', why: ['package.json (wrangler)'] },
    ]);
  });

  test('an aws-cdk-lib dependency means Lambda, from dependencies or devDependencies', async () => {
    const dependency = await copy();
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { 'aws-cdk-lib': '2.0.0' } }),
      'utf8',
    );
    const devDependency = await copy();
    await writeFile(
      join(devDependency, 'package.json'),
      JSON.stringify({ name: 'app', devDependencies: { 'aws-cdk': '2.0.0' } }),
      'utf8',
    );

    expect(detectTargets(dependency)).toEqual([
      { target: 'lambda', why: ['package.json (aws-cdk-lib)'] },
    ]);
    expect(detectTargets(devDependency)).toEqual([
      { target: 'lambda', why: ['package.json (aws-cdk)'] },
    ]);
  });

  test('a malformed package.json declares nothing and does not stop the plan', async () => {
    const root = await copy();
    await writeFile(join(root, 'package.json'), '{ not json', 'utf8');

    expect(detectTargets(root)).toEqual([]);
  });

  test('a Cloudflare account variable in .env.example means Cloudflare, comments ignored', async () => {
    const root = await copy();
    await writeFile(
      join(root, '.env.example'),
      '# CLOUDFLARE_ACCOUNT_ID=commented-out\nexport CLOUDFLARE_ACCOUNT_ID=\nAPP_NAME=\n',
      'utf8',
    );

    expect(detectTargets(root)).toEqual([
      { target: 'cloudflare', why: ['.env.example (CLOUDFLARE_ACCOUNT_ID)'] },
    ]);
  });

  test('AWS variables in .env.example do not imply Lambda: S3 storage reads them too', async () => {
    const root = await copy();
    await writeFile(
      join(root, '.env.example'),
      'AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\nAWS_REGION=\n',
      'utf8',
    );

    expect(detectTargets(root)).toEqual([]);
  });

  test('marker files and dependency signals for one target are listed together', async () => {
    const root = await copy({ extraFiles: ['wrangler.toml'] });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'app', devDependencies: { wrangler: '4.0.0' } }),
      'utf8',
    );

    expect(detectTargets(root)).toEqual([
      { target: 'cloudflare', why: ['wrangler.toml', 'package.json (wrangler)'] },
    ]);
  });
});
