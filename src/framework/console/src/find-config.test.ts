import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliError } from './output.ts';
import { findConfigFile } from './project.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsir-find-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function caught(fn: () => unknown): CliError {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('expected a CliError');
}

describe('findConfigFile (CFG-012)', () => {
  test('finds the single configuration file in a parent directory', () => {
    mkdirSync(join(dir, 'app', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'tsir.js'), 'export default {};\n');
    expect(findConfigFile(join(dir, 'app', 'nested'))).toBe(join(dir, 'tsir.js'));
  });

  test('two candidates in one directory fail with CFG_AMBIGUOUS_CONFIG_FILE and name both', () => {
    writeFileSync(join(dir, 'tsir.js'), 'export default {};\n');
    writeFileSync(join(dir, 'tsir.mjs'), 'export default {};\n');
    const error = caught(() => findConfigFile(dir));
    expect(error.code).toBe('CFG_AMBIGUOUS_CONFIG_FILE');
    expect(error.exitCode).toBe(3);
    expect(error.message).toContain('tsir.js');
    expect(error.message).toContain('tsir.mjs');
  });
});
