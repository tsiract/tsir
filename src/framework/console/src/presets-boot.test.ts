/**
 * Fixture app boots per preset (`CFG-102`).
 *
 * Each built-in preset gets its own project, with the framework packages linked into its
 * `node_modules` the way `bun install` links workspace packages. The project is loaded through
 * the same path `tsir dev` uses and must reach `ready`. A preset that names a module the
 * project cannot resolve fails here, not at the first request.
 */

import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { bootProject, loadProject } from './project.ts';

/** `src/framework`, the directory holding every workspace package. */
const FRAMEWORK = resolve(import.meta.dir, '..', '..');

const PRESETS = ['minimal', 'standard', 'api', 'worker', 'edge', 'serverless', 'full'] as const;

let root: string;

async function linkFramework(): Promise<void> {
  const scope = join(root, 'node_modules', '@tsir');
  await mkdir(scope, { recursive: true });
  for (const entry of await readdir(FRAMEWORK)) {
    const dir = join(FRAMEWORK, entry);
    if (!(await stat(dir)).isDirectory()) continue;
    try {
      await stat(join(dir, 'package.json'));
    } catch {
      continue;
    }
    await symlink(dir, join(scope, entry));
  }
}

/**
 * The project's own database block. A database preset names `primary` as the default
 * connection (CFG-122), so the project has to declare it, and the driver is the project's choice.
 */
const PRIMARY_CONNECTION =
  "  database: { default: 'primary', connections: { primary: { driver: 'd1', binding: 'DB' } } },";

/** The presets that name a database connection. The others boot with no database block. */
const DATABASE_PRESETS = new Set<string>(['standard', 'api', 'full']);

async function writeProject(
  name: string,
  presetCall: string,
  database: string | null = PRIMARY_CONNECTION,
): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
    join(dir, 'tsir.js'),
    [
      "import { preset } from '@tsir/config';",
      'export default {',
      `  app: { name: '${name}', entry: './src/app.ts' },`,
      `  presets: [${presetCall}],`,
      ...(database === null ? [] : [database]),
      '};',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(dir, 'src', 'app.ts'),
    [
      "import { defineApp, defineModule } from '@tsir/core';",
      "import { defineConfig } from '@tsir/config';",
      'const spec = defineConfig({});',
      "const RootModule = defineModule({ name: 'root' });",
      `export default defineApp({ name: '${name}', config: spec, modules: [RootModule] });`,
      '',
    ].join('\n'),
  );
  return dir;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tsir-preset-boot-'));
  await linkFramework();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a fixture app boots per preset (CFG-102)', () => {
  for (const name of PRESETS) {
    test(`preset.${name}() boots to ready`, async () => {
      const dir = await writeProject(
        `app-${name}`,
        `preset.${name}()`,
        DATABASE_PRESETS.has(name) ? PRIMARY_CONNECTION : null,
      );
      const project = await loadProject(dir);
      const { app } = await bootProject(project, {
        mode: 'development',
        onDiagnostic: () => undefined,
      });
      expect(app.state.kind).toBe('ready');
      await app.shutdown('signal');
      expect(app.state.kind).toBe('stopped');
    });
  }

  test('a database preset with no declared connection is refused, naming the default', async () => {
    // `null`, not `undefined`: an undefined argument would take the default and hide the case.
    const dir = await writeProject('app-no-connection', 'preset.standard()', null);
    const failure = await loadProject(dir).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'CFG_UNKNOWN_DEFAULT' });
  });

  test('presets compose: standard then worker boots with both module sets resolvable', async () => {
    const dir = await writeProject('app-composed', 'preset.standard(), preset.worker()');
    const project = await loadProject(dir);
    const { app } = await bootProject(project, {
      mode: 'development',
      onDiagnostic: () => undefined,
    });
    expect(app.state.kind).toBe('ready');
    await app.shutdown('signal');
  });
});
