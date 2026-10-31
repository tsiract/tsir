/**
 * `resolveProjectPresets` (`CFG-102`): presets are applied before the project is parsed, and a
 * preset whose modules are not installed is refused before anything boots.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { preset } from '@tsir/config';

import { CliError } from './output.ts';
import { resolveProjectPresets } from './project.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tsir-presets-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A stub package that resolves like an installed one: a package.json and an entry file. */
async function install(name: string): Promise<void> {
  const dir = join(root, 'node_modules', ...name.split('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
  await writeFile(join(dir, 'index.js'), 'export {};\n');
}

function refused(run: () => unknown): CliError {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('expected a CliError');
}

describe('resolveProjectPresets (CFG-102)', () => {
  test('a preset whose module is not installed is refused with the exact bun add line', () => {
    const error = refused(() => resolveProjectPresets(root, { presets: [preset.minimal()] }));
    expect(error.code).toBe('CFG_PRESET_MODULE_MISSING');
    expect(error.exitCode).toBe(3);
    expect(error.hint).toBe('bun add @tsir/core');
  });

  test('every missing module is named in one error, not just the first', async () => {
    await install('@tsir/core');
    const error = refused(() => resolveProjectPresets(root, { presets: [preset.worker()] }));
    expect(error.hint).toBe(
      'bun add @tsir/http @tsir/queue @tsir/events @tsir/schedule @tsir/pulse',
    );
  });

  test('installed modules pass, and the effective configuration carries the preset modules', async () => {
    await install('@tsir/core');
    const effective = resolveProjectPresets(root, {
      presets: [preset.minimal()],
      app: { name: 'demo', entry: 'src/app.ts' },
    });
    expect(effective['modules']).toEqual(['@tsir/core']);
    expect(effective['app']).toEqual({ name: 'demo', entry: 'src/app.ts' });
    expect(effective).not.toHaveProperty('presets');
  });

  test('a malformed presets value is a configuration error, not a crash', () => {
    const error = refused(() => resolveProjectPresets(root, { presets: 'standard' }));
    expect(error.code).toBe('CFG_INVALID');
    expect(error.exitCode).toBe(3);
  });
});
