/**
 * `--set` (`CFG-110`): what it accepts, what it refuses, and that an invalid plan is never applied.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { UsageError } from '../output.ts';
import { parseSetOverrides, takeRepeated } from './bootstrap-set.ts';
import { bootstrap } from './bootstrap.ts';

function refusal(run: () => unknown): UsageError {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof UsageError) return error;
    throw error;
  }
  throw new Error('expected a UsageError');
}

/** The rejection a refused bootstrap throws, so the test can check its type. */
async function asyncRefusal(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected bootstrap to refuse');
}

describe('takeRepeated', () => {
  test('collects every --set, in both spellings, and leaves the rest of argv alone', () => {
    const out = takeRepeated(
      ['--yes', '--set', 'deploy.topology=single', '--set=modules+=@tsir/queue', '--json'],
      '--set',
    );
    expect(out.values).toEqual(['deploy.topology=single', 'modules+=@tsir/queue']);
    expect(out.rest).toEqual(['--yes', '--json']);
  });

  test('a --set with no value is a usage error', () => {
    expect(refusal(() => takeRepeated(['--set'], '--set')).message).toContain('expects key=value');
  });
});

describe('parseSetOverrides', () => {
  test('the three keys parse, and modules+= is repeatable without duplicates', () => {
    expect(
      parseSetOverrides([
        'deploy.topology=single',
        'deploy.targets=bun, cloudflare',
        'modules+=@tsir/queue',
        'modules+=@tsir/queue',
        'modules+=@tsir/events',
      ]),
    ).toEqual({
      topology: 'single',
      targets: ['bun', 'cloudflare'],
      includeModules: ['@tsir/queue', '@tsir/events'],
    });
  });

  test('a bad topology is refused', () => {
    expect(refusal(() => parseSetOverrides(['deploy.topology=many'])).message).toContain(
      '"separate" or "single"',
    );
  });

  test('a topology set twice to different values is refused', () => {
    expect(() => parseSetOverrides(['deploy.topology=single', 'deploy.topology=separate'])).toThrow(
      UsageError,
    );
  });

  test('a module name that could break out of the written string is refused', () => {
    expect(refusal(() => parseSetOverrides(["modules+=x'); evil("])).message).toContain(
      'package name',
    );
  });

  test('preset is refused, and the refusal says where presets live', () => {
    const error = refusal(() => parseSetOverrides(['preset=api']));
    expect(error.message).toContain('preset is refused');
    expect(error.hint).toContain('tsir.js');
  });

  test('an unknown key names the keys that are accepted', () => {
    const error = refusal(() => parseSetOverrides(['deploy.region=eu']));
    expect(error.message).toContain('unknown --set key "deploy.region"');
    expect(error.hint).toContain('deploy.topology');
  });

  test('a value without an equals sign is refused', () => {
    expect(refusal(() => parseSetOverrides(['modules'])).message).toContain('key=value');
  });
});

describe('bootstrap --set (CFG-110)', () => {
  let root: string;
  const source = "export default {\n  app: { name: 'set', entry: './src/app.ts' },\n};\n";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tsir-set-'));
    await writeFile(join(root, 'tsir.js'), source);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('an applied --set writes the module into the managed block', async () => {
    expect(await bootstrap(['--set', 'modules+=@tsir/queue', '--yes'], root)).toBe(0);
    const written = await readFile(join(root, 'tsir.js'), 'utf8');
    expect(written).toContain("includeModules: ['@tsir/queue']");
    expect(written).toContain('// ── managed:deploy:start');
  });

  test('an invalid --set is refused, and tsir.js is byte-identical afterwards', async () => {
    const before = await readFile(join(root, 'tsir.js'), 'utf8');
    expect(
      await asyncRefusal(bootstrap(['--set', 'deploy.topology=many', '--yes'], root)),
    ).toBeInstanceOf(UsageError);
    expect(await readFile(join(root, 'tsir.js'), 'utf8')).toBe(before);
  });

  test('--topology and --set deploy.topology that disagree are refused before any write', async () => {
    const before = await readFile(join(root, 'tsir.js'), 'utf8');
    expect(
      await asyncRefusal(
        bootstrap(['--topology', 'single', '--set', 'deploy.topology=separate', '--yes'], root),
      ),
    ).toBeInstanceOf(UsageError);
    expect(await readFile(join(root, 'tsir.js'), 'utf8')).toBe(before);
  });

  test('a plan run with --set prints the change and writes nothing', async () => {
    const before = await readFile(join(root, 'tsir.js'), 'utf8');
    expect(await bootstrap(['--set', 'modules+=@tsir/queue', '--plan'], root)).toBe(0);
    expect(await readFile(join(root, 'tsir.js'), 'utf8')).toBe(before);
  });
});
