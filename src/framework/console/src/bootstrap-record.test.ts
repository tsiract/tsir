/**
 * The bootstrap record (`CFG-105`): deterministic bytes, what reading it can report, what start
 * warns about, and that only an applied bootstrap writes it.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { PROJECT_FORMAT_VERSION } from '@tsir/config';

import {
  BOOTSTRAP_RECORD,
  bootstrapWarnings,
  readBootstrapRecord,
  renderBootstrapRecord,
} from './bootstrap-record.ts';
import { bootstrap } from './commands/bootstrap.ts';

const PRESET = { name: 'standard', version: '0.0.0', source: 'builtin' } as const;

function render(overrides: Partial<Parameters<typeof renderBootstrapRecord>[0]> = {}): string {
  return renderBootstrapRecord({
    region: 'deploy',
    deployLines: ['topology: separate'],
    topology: 'separate',
    targets: ['bun'],
    presets: [PRESET],
    ...overrides,
  });
}

describe('renderBootstrapRecord (CFG-105)', () => {
  test('the same inputs give the same bytes, with no timestamp in them', () => {
    expect(render()).toBe(render());
    expect(render()).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('it records the config format this tsir writes', () => {
    expect(JSON.parse(render()).configVersion).toBe(PROJECT_FORMAT_VERSION);
  });

  test('the deploy block is recorded as a hash, so a change shows without storing the block', () => {
    const same = JSON.parse(render()).deploy.sha256;
    const changed = JSON.parse(render({ deployLines: ['topology: single'] })).deploy.sha256;
    expect(same).toMatch(/^[0-9a-f]{64}$/);
    expect(changed).not.toBe(same);
    expect(render()).not.toContain('topology: separate');
  });

  test('presets are recorded with name, version and source only', () => {
    const record = JSON.parse(render({ presets: [{ ...PRESET, extra: 'x' } as typeof PRESET] }));
    expect(record.presets).toEqual([PRESET]);
  });
});

describe('readBootstrapRecord', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tsir-record-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('no file is missing, not an error', async () => {
    expect(await readBootstrapRecord(root)).toEqual({ kind: 'missing' });
  });

  test('a file that is not JSON is invalid, and reported as such', async () => {
    await mkdir(join(root, '.tsir'), { recursive: true });
    await writeFile(join(root, BOOTSTRAP_RECORD), '{ not json');
    expect(await readBootstrapRecord(root)).toEqual({ kind: 'invalid' });
  });

  test('a valid file is returned as the record', async () => {
    await mkdir(join(root, '.tsir'), { recursive: true });
    await writeFile(join(root, BOOTSTRAP_RECORD), render());
    const read = await readBootstrapRecord(root);
    expect(read.kind).toBe('ok');
  });
});

describe('bootstrapWarnings (what start says)', () => {
  const record = JSON.parse(render());

  test('nothing to say when there is no record', () => {
    expect(bootstrapWarnings({ kind: 'missing' }, [PRESET])).toEqual([]);
  });

  test('nothing to say when the presets are the ones bootstrap saw', () => {
    expect(bootstrapWarnings({ kind: 'ok', record }, [PRESET])).toEqual([]);
  });

  test('a changed preset list is reported, and points at the review command', () => {
    const warnings = bootstrapWarnings({ kind: 'ok', record }, []);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bootstrap --plan');
  });

  test('a record from a newer tsir is reported', () => {
    const newer = { ...record, configVersion: PROJECT_FORMAT_VERSION + 1 };
    const warnings = bootstrapWarnings({ kind: 'ok', record: newer }, [PRESET]);
    expect(warnings.join('\n')).toContain('newer tsir');
  });

  test('a corrupt record is reported with the way to rewrite it', () => {
    const [warning] = bootstrapWarnings({ kind: 'invalid' }, [PRESET]);
    expect(warning).toContain('not valid JSON');
  });
});

describe('bootstrap writes the record only when it applies (CFG-105)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tsir-bootstrap-record-'));
    await writeFile(
      join(root, 'tsir.js'),
      "export default {\n  app: { name: 'rec', entry: './src/app.ts' },\n};\n",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('a plan run writes nothing', async () => {
    expect(await bootstrap(['--plan'], root)).toBe(0);
    expect(await readBootstrapRecord(root)).toEqual({ kind: 'missing' });
  });

  test('an applied run writes the record, and a second run leaves the same bytes', async () => {
    expect(await bootstrap(['--yes'], root)).toBe(0);
    const first = await readFile(join(root, BOOTSTRAP_RECORD), 'utf8');
    expect(JSON.parse(first).deploy.topology).toBe('separate');
    expect(JSON.parse(first).deploy.targets).toEqual(['bun']);

    expect(await bootstrap(['--yes'], root)).toBe(0);
    expect(await readFile(join(root, BOOTSTRAP_RECORD), 'utf8')).toBe(first);
  });
});
