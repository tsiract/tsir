/**
 * `tsir bootstrap --migrate-config` as a command (CFG-122): the three outputs a user can get.
 * The planner has its own tests; these cover the printing and the exit code, in-process.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { migrateConfig } from './migrate-config.ts';
import { EXIT } from '../output.ts';

let root = '';
const FLAT = `export default {
  app: { name: 'demo', entry: 'src/app.ts' },
  database: { driver: 'postgres', url: { fromEnv: 'DATABASE_URL' } },
};\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tsir-migrate-cmd-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Captures what `info()` prints. The command writes through process.stdout. */
async function capture(run: () => Promise<number>): Promise<{ code: number; text: string }> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const code = await run();
    return { code, text: chunks.join('') };
  } finally {
    process.stdout.write = write;
  }
}

describe('migrateConfig', () => {
  test('--json prints the plan and says nothing was written', async () => {
    writeFileSync(join(root, 'tsir.js'), FLAT);
    const { code, text } = await capture(() => migrateConfig(root, true));
    expect(code).toBe(EXIT.ok);
    const parsed = JSON.parse(text) as { ok: boolean; written: boolean; from: number; to: number };
    expect(parsed).toMatchObject({ ok: true, written: false, from: 1, to: 2 });
    expect(text).toContain('database: {');
  });

  test('the human output names the steps and the block to paste, and writes nothing', async () => {
    writeFileSync(join(root, 'tsir.js'), FLAT);
    const { code, text } = await capture(() => migrateConfig(root, false));
    expect(code).toBe(EXIT.ok);
    expect(text).toContain('format 1 → 2');
    expect(text).toContain('flat-database-to-registry');
    expect(text).toContain("default: 'primary'");
    expect(text).toContain('nothing written');
  });

  test('a file already at the current format says so, with no block', async () => {
    writeFileSync(
      join(root, 'tsir.js'),
      `export default {\n  app: { name: 'demo', entry: 'src/app.ts' },\n};\n`,
    );
    const { code, text } = await capture(() => migrateConfig(root, false));
    expect(code).toBe(EXIT.ok);
    expect(text).toContain('already at format 2');
  });
});
