import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TsirError } from '@tsir/container';

import { loadProject } from './project.ts';

/** Writes a project with the given `tsir.js` body and returns its root. */
function writeProject(root: string, body: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export {};\n');
  writeFileSync(join(root, 'tsir.js'), body);
}

async function errorOf(root: string): Promise<unknown> {
  try {
    await loadProject(root);
    return undefined;
  } catch (error) {
    return error;
  }
}

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tsir-project-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadProject refuses an invalid project file (CFG-101, CFG-121)', () => {
  test('a valid registry passes the config rules and stops at the entry check', async () => {
    // The temp entry is not a defineApp, so the loader stops after the config rules.
    // Reaching the entry message proves the registry passed.
    writeProject(
      root,
      `export default {
  app: { name: 'demo', entry: 'src/app.ts' },
  database: { default: 'primary', connections: { primary: { driver: 'postgres', url: { fromEnv: 'DATABASE_URL' } } } },
};\n`,
    );
    const error = await errorOf(root);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TsirError);
    if (error instanceof Error) expect(error.message).toContain('defineApp');
  });

  test('a misspelled top-level key is refused with a suggestion', async () => {
    writeProject(
      root,
      `export default { app: { name: 'demo', entry: 'src/app.ts' }, databse: {} };\n`,
    );
    const error = await errorOf(root);
    expect(error).toBeInstanceOf(TsirError);
    if (error instanceof TsirError) {
      expect(error.code).toBe('CFG_UNKNOWN_KEY');
      expect(error.message).toContain('did you mean "database"');
    }
  });

  test('a registry without a default is refused', async () => {
    writeProject(
      root,
      `export default {
  app: { name: 'demo', entry: 'src/app.ts' },
  database: { connections: { primary: { driver: 'postgres' } } },
};\n`,
    );
    const error = await errorOf(root);
    expect(error).toBeInstanceOf(TsirError);
    if (error instanceof TsirError) expect(error.code).toBe('CFG_MISSING_DEFAULT');
  });

  test('the flat database form is refused and points at the migration', async () => {
    writeProject(
      root,
      `export default {
  app: { name: 'demo', entry: 'src/app.ts' },
  database: { driver: 'postgres', url: { fromEnv: 'DATABASE_URL' } },
};\n`,
    );
    const error = await errorOf(root);
    expect(error).toBeInstanceOf(TsirError);
    if (error instanceof TsirError) expect(error.code).toBe('CFG_CONFIG_VERSION_STALE');
  });
});
