/**
 * Leftover keys in the managed `deploy` region (`CFG-112`): reported, never deleted.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { EXIT } from '../output.ts';
import { bootstrap, unusedDeployKeys } from './bootstrap.ts';

describe('unused deploy keys (CFG-112)', () => {
  let root = '';
  const source = "export default {\n  app: { name: 'unused', entry: './src/app.ts' },\n};\n";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tsir-unused-'));
    await writeFile(join(root, 'tsir.js'), source);
    // Create the managed region the normal way, then add a key bootstrap does not write.
    expect(await bootstrap(['--yes', '--target', 'bun'], root)).toBe(EXIT.ok);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function withLeftover(): Promise<string> {
    const current = await readFile(join(root, 'tsir.js'), 'utf8');
    const edited = current.replace(
      "    topology: 'separate',",
      "    topology: 'separate',\n    units: [{ name: 'api' }],",
    );
    expect(edited).not.toBe(current);
    await writeFile(join(root, 'tsir.js'), edited);
    return edited;
  }

  test('a region bootstrap wrote has no leftovers', async () => {
    expect(unusedDeployKeys(await readFile(join(root, 'tsir.js'), 'utf8'))).toEqual([]);
  });

  test('a key bootstrap does not write is reported', async () => {
    expect(unusedDeployKeys(await withLeftover())).toEqual(['units']);
  });

  test('an apply with leftovers refuses and deletes nothing', async () => {
    const edited = await withLeftover();
    expect(await bootstrap(['--yes', '--topology', 'single'], root)).toBe(EXIT.usage);
    expect(await readFile(join(root, 'tsir.js'), 'utf8')).toBe(edited);
  });

  test('a plan with leftovers reports them and writes nothing', async () => {
    const edited = await withLeftover();
    expect(await bootstrap(['--plan'], root)).toBe(EXIT.ok);
    expect(await readFile(join(root, 'tsir.js'), 'utf8')).toBe(edited);
  });
});
