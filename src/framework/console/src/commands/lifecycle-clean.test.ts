/**
 * `tsir clean` — the build output, and nothing else.
 *
 * The acceptance criterion is a negative one, which is why this test is mostly about what is still
 * there afterwards: a `clean` that removes `migrations/` or `config/` is a `clean` that loses work.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXIT } from '../output.ts';
import { cleanCommand } from './lifecycle.ts';

const APP = join(import.meta.dir, 'fixtures', 'http-app');
const TSIR_DIR = join(APP, '.tsir');
const ROUTES = join(APP, 'routes.gen.ts');
/** Files `clean` must never touch: the project's own entrypoint, sources and migrations. */
const KEEP = [join(APP, 'tsir.js'), join(APP, 'migrations'), join(APP, 'src')] as const;

let originalCwd = '';
let captured = '';
const realOut = process.stdout.write.bind(process.stdout);

beforeAll(() => {
  originalCwd = process.cwd();
  process.chdir(APP);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
});

afterAll(() => {
  process.stdout.write = realOut;
  process.chdir(originalCwd);
  rmSync(TSIR_DIR, { recursive: true, force: true });
  rmSync(ROUTES, { force: true });
});

beforeEach(() => {
  captured = '';
  mkdirSync(TSIR_DIR, { recursive: true });
  writeFileSync(join(TSIR_DIR, 'manifest.json'), '{}\n');
  writeFileSync(ROUTES, 'export {};\n');
  mkdirSync(join(APP, 'migrations'), { recursive: true });
});

describe('tsir clean', () => {
  test('removes the build output and keeps the project source', async () => {
    for (const path of KEEP) expect(existsSync(path)).toBe(true);

    expect(await cleanCommand([])).toBe(EXIT.ok);

    expect(existsSync(TSIR_DIR)).toBe(false);
    expect(existsSync(ROUTES)).toBe(false);
    for (const path of KEEP) expect(existsSync(path)).toBe(true);
  });

  test('--dry-run reports what it would remove and removes nothing', async () => {
    expect(await cleanCommand(['--dry-run'])).toBe(EXIT.ok);

    expect(captured).toContain('would remove .tsir');
    expect(existsSync(join(TSIR_DIR, 'manifest.json'))).toBe(true);
    expect(existsSync(ROUTES)).toBe(true);
  });

  test('a project with no build output succeeds and says so', async () => {
    rmSync(TSIR_DIR, { recursive: true, force: true });
    rmSync(ROUTES, { force: true });

    expect(await cleanCommand([])).toBe(EXIT.ok);
    expect(captured).toContain('nothing to clean');
  });

  test('the --json form names the removed paths, not the machine', async () => {
    expect(await cleanCommand(['--json'])).toBe(EXIT.ok);

    const document = JSON.parse(captured.trim()) as {
      readonly schemaVersion?: number;
      readonly removed?: readonly string[];
    };
    expect(document.schemaVersion).toBe(1);
    expect(document.removed).toContain('.tsir');
    expect(document.removed).toContain('routes.gen.ts');
    expect(captured).not.toContain(APP);
  });
});
