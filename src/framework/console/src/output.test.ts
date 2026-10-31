import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { TsirError } from '@tsir/container';

import { CliError, EXIT, UsageError, fail } from './output.ts';

// ERR-006 (CLI boundary): every error family maps to one exit code, in both output modes.
// Captures stderr so the table asserts what a user and a script would actually see.

let captured = '';
const realWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  captured = '';
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
});

afterEach(() => {
  process.stderr.write = realWrite;
});

const tsir = (kind: 'config' | 'http', hint?: string): TsirError =>
  new TsirError('CFG_INVALID', 'port must be a number', {
    kind,
    ...(hint === undefined ? {} : { hint }),
  });

const cases: ReadonlyArray<{ name: string; error: unknown; exit: number }> = [
  { name: 'TsirError config → environment', error: tsir('config'), exit: EXIT.environment },
  { name: 'TsirError http → failure', error: tsir('http'), exit: EXIT.failure },
  { name: 'CliError default → failure', error: new CliError('boom'), exit: EXIT.failure },
  {
    name: 'CliError exitCode 3 → environment',
    error: new CliError('boom', EXIT.environment),
    exit: EXIT.environment,
  },
  { name: 'UsageError → usage', error: new UsageError('bad flag'), exit: EXIT.usage },
  { name: 'plain Error → failure', error: new Error('kaboom'), exit: EXIT.failure },
  { name: 'thrown string → failure', error: 'raw string', exit: EXIT.failure },
];

describe('fail(): exit code per error family', () => {
  test.each(cases)('$name (text)', ({ error, exit }) => {
    expect(fail(error, false)).toBe(exit);
    expect(captured.length).toBeGreaterThan(0);
  });

  test.each(cases)('$name (json)', ({ error, exit }) => {
    expect(fail(error, true)).toBe(exit);
    const parsed = JSON.parse(captured) as { ok: boolean };
    expect(parsed.ok).toBe(false);
  });
});

describe('fail(): text output', () => {
  test('TsirError prints message, hint and code', () => {
    fail(tsir('config', 'set PORT'), false);
    expect(captured).toContain('port must be a number');
    expect(captured).toContain('↳ set PORT');
    expect(captured).toContain('code: CFG_INVALID');
  });

  test('UsageError prints its hint and no code line', () => {
    fail(new UsageError('bad flag', 'try --help'), false);
    expect(captured).toContain('bad flag');
    expect(captured).toContain('↳ try --help');
    expect(captured).not.toContain('code:');
  });

  test('plain Error prints only its message', () => {
    fail(new Error('kaboom'), false);
    expect(captured).toBe('✗ kaboom\n');
  });
});

describe('fail(): json output', () => {
  test('every error document is versioned, and the version comes first', () => {
    fail(new Error('kaboom'), true);
    expect(captured.startsWith('{\n  "schemaVersion": 1,')).toBe(true);
  });

  test('TsirError carries code, kind and message', () => {
    fail(tsir('config', 'set PORT'), true);
    expect(JSON.parse(captured)).toEqual({
      schemaVersion: 1,
      ok: false,
      code: 'CFG_INVALID',
      kind: 'config',
      message: 'port must be a number',
      hint: 'set PORT',
    });
  });

  test('CliError carries only ok and message', () => {
    fail(new CliError('boom'), true);
    expect(JSON.parse(captured)).toEqual({ schemaVersion: 1, ok: false, message: 'boom' });
  });

  test('plain Error carries ok and message', () => {
    fail(new Error('kaboom'), true);
    expect(JSON.parse(captured)).toEqual({ schemaVersion: 1, ok: false, message: 'kaboom' });
  });
});
