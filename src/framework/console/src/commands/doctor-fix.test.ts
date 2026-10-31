/**
 * `tsir doctor --fix` (`CFG-119`): restores the managed `deploy` region from the bootstrap record,
 * writes nothing outside it, and refuses where bootstrap would refuse.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { EXIT } from '../output.ts';
import { bootstrap, repairDeployRegion } from './bootstrap.ts';

describe('doctor --fix (CFG-119)', () => {
  let root = '';
  const source = "export default {\n  app: { name: 'fixme', entry: './src/app.ts' },\n};\n";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tsir-fix-'));
    await writeFile(join(root, 'tsir.js'), source);
    expect(await bootstrap(['--yes', '--target', 'bun'], root)).toBe(EXIT.ok);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('a region that matches the record is left alone', async () => {
    const before = await readFile(join(root, 'tsir.js'), 'utf8');
    expect((await repairDeployRegion(root)).kind).toBe('unchanged');
    expect(await readFile(join(root, 'tsir.js'), 'utf8')).toBe(before);
  });

  test('drift inside the region is restored, and text outside it is untouched', async () => {
    const current = await readFile(join(root, 'tsir.js'), 'utf8');
    const drifted = current.replace("    topology: 'separate',", "    topology: 'single',");
    expect(drifted).not.toBe(current);
    await writeFile(join(root, 'tsir.js'), drifted);

    expect((await repairDeployRegion(root)).kind).toBe('repaired');
    const repaired = await readFile(join(root, 'tsir.js'), 'utf8');
    expect(repaired).toContain("topology: 'separate'");
    expect(repaired).toContain("app: { name: 'fixme', entry: './src/app.ts' },");
  });

  test('a deploy block outside the region is refused, and nothing is written', async () => {
    const current = await readFile(join(root, 'tsir.js'), 'utf8');
    const outside = current.replace('};\n', "  deploy: { topology: 'single' },\n};\n");
    await writeFile(join(root, 'tsir.js'), outside);
    const result = await repairDeployRegion(root);
    expect(result.kind).toBe('refused');
    expect(await readFile(join(root, 'tsir.js'), 'utf8')).toBe(outside);
  });

  test('without a record there is nothing to fix', async () => {
    await rm(join(root, '.tsir'), { recursive: true, force: true });
    expect((await repairDeployRegion(root)).kind).toBe('no-record');
  });
});
