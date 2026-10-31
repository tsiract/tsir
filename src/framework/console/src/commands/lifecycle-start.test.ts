import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXIT } from '../output.ts';
import { buildCommand, startCommand } from './lifecycle.ts';

// CLI-007: `tsir build` writes the artifact; `tsir start` boots it in production mode. The example
// app is used in place, because its `@tsir/*` imports resolve only from inside the repository.

const APP = join(import.meta.dir, '..', '..', '..', '..', 'apps', 'examples', 'minimal');
const TSIR_DIR = join(APP, '.tsir');
const MANIFEST = join(TSIR_DIR, 'manifest.json');

let originalCwd = '';
let captured = '';
const realErr = process.stderr.write.bind(process.stderr);

beforeAll(() => {
  originalCwd = process.cwd();
  process.chdir(APP);
  rmSync(TSIR_DIR, { recursive: true, force: true });
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
});

afterAll(() => {
  process.stderr.write = realErr;
  process.chdir(originalCwd);
  rmSync(TSIR_DIR, { recursive: true, force: true });
});

describe('tsir start', () => {
  test('refuses to start without a built manifest and says to run tsir build', async () => {
    captured = '';
    rmSync(TSIR_DIR, { recursive: true, force: true });
    expect(await startCommand([])).toBe(EXIT.failure);
    expect(captured).toContain('APP_MANIFEST_MISSING');
    expect(captured).toContain('tsir build');
  });

  test('refuses a manifest that no longer matches the modules, with the same hint', async () => {
    expect(await buildCommand([])).toBe(EXIT.ok);
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>;
    writeFileSync(MANIFEST, JSON.stringify({ ...manifest, sourceHash: 'tampered' }));
    captured = '';
    expect(await startCommand([])).toBe(EXIT.failure);
    expect(captured).toContain('APP_MANIFEST_STALE');
    expect(captured).toContain('tsir build');
  });

  test('boots the built artifact and shuts down cleanly on a signal', async () => {
    rmSync(TSIR_DIR, { recursive: true, force: true });
    expect(await buildCommand([])).toBe(EXIT.ok);
    expect(existsSync(MANIFEST)).toBe(true);

    const running = startCommand([]);
    // Give the boot a moment to register its signal handlers, then stop it the way ctrl-c would.
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.emit('SIGTERM', 'SIGTERM');
    expect(await running).toBe(EXIT.ok);
  });
});
