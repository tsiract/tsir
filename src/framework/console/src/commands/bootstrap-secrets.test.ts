/**
 * `tsir bootstrap` refuses a plan that would leave a secret literal in `tsir.js` (`CFG-114`).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { bootstrap } from './bootstrap.ts';

describe('bootstrap secret refusal (CFG-114)', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tsir-secret-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('a plan that keeps a literal password is refused, and the file is unchanged', async () => {
    const source = [
      'export default {',
      "  app: { name: 'leaky', entry: './src/app.ts' },",
      "  database: { url: 'postgres://app:hunter2@db.internal/app' },",
      '};',
      '',
    ].join('\n');
    await writeFile(join(root, 'tsir.js'), source);
    // The refusal is a configuration error (exit 3), and nothing is written.
    expect(await bootstrap(['--yes', '--target', 'bun'], root)).toBe(3);
    expect(await readFile(join(root, 'tsir.js'), 'utf8')).toBe(source);
  });
});
