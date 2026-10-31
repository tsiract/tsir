import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXIT } from './output.ts';
import { runCli } from './index.ts';

// CLI-001..004: the entry's contract. Runs `runCli` in a directory with no `tsir.js`, so the
// project-detection path is real, and captures what a user and a script would see.

let captured = '';
let outputs = '';
let originalCwd = '';
let scratch = '';
const realErr = process.stderr.write.bind(process.stderr);
const realOut = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  captured = '';
  outputs = '';
  originalCwd = process.cwd();
  scratch = mkdtempSync(join(tmpdir(), 'tsir-cli-'));
  process.chdir(scratch);
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    outputs += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
});

afterEach(() => {
  process.stderr.write = realErr;
  process.stdout.write = realOut;
  process.chdir(originalCwd);
  rmSync(scratch, { recursive: true, force: true });
});

describe('CLI-001: entry and help', () => {
  test('--help lists the command groups and exits 0', async () => {
    expect(await runCli(['--help'])).toBe(EXIT.ok);
    expect(outputs).toContain('available');
    expect(outputs).toContain('planned');
    expect(outputs).toContain('doctor');
  });

  test('no arguments prints help and exits 0', async () => {
    expect(await runCli([])).toBe(EXIT.ok);
    expect(outputs).toContain('usage: tsir');
  });
});

describe('CLI-003: exit code contract', () => {
  test.each([
    ['usage error: unknown command', ['nosuchcommand'], EXIT.usage],
    ['usage error: unknown command with leading --json', ['--json', 'nosuchcommand'], EXIT.usage],
    ['environment: command needs a project', ['dev'], EXIT.environment],
    ['environment: planned command', ['openapi:generate'], EXIT.environment],
  ])('%s → %p exits %i', async (_name, argv, exit) => {
    expect(await runCli(argv)).toBe(exit);
  });
});

describe('CLI-002: --json placement', () => {
  test('a leading --json is recognised as global, and the error is JSON', async () => {
    expect(await runCli(['--json', 'nosuchcommand'])).toBe(EXIT.usage);
    const parsed = JSON.parse(captured) as { ok: boolean; message: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('nosuchcommand');
  });

  test('--json alone is not a command name', async () => {
    expect(await runCli(['--json'])).toBe(EXIT.ok);
    expect(outputs).toContain('usage: tsir');
  });
});

describe('CLI-004: project detection', () => {
  test('no tsir.js → exit 3 and the hint names `tsir bootstrap`', async () => {
    expect(await runCli(['dev'])).toBe(EXIT.environment);
    expect(captured).toContain('no tsir.js found');
    expect(captured).toContain('tsir bootstrap');
  });

  test('--json form of the same failure is machine-readable', async () => {
    expect(await runCli(['--json', 'dev'])).toBe(EXIT.environment);
    const parsed = JSON.parse(captured) as { ok: boolean; message: string };
    expect(parsed).toMatchObject({ ok: false });
    expect(parsed.message).toContain('no tsir.js found');
  });
});

describe('CLI-002: doctor --json', () => {
  test('is versioned and reports the failure without a stack', async () => {
    expect(await runCli(['--json', 'doctor'])).toBe(EXIT.failure);
    const parsed = JSON.parse(outputs) as { schemaVersion: number; ok: boolean; checks: unknown[] };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});
