import { describe, expect, test } from 'bun:test';

import { TsirError } from './errors.ts';

// Exact-string snapshots: the formatter's output is a contract for terminals and log pipelines,
// so any change to a byte of it should fail here and be reviewed deliberately.

function failure(overrides: { hint?: string; message?: string } = {}): TsirError {
  const error = new TsirError('CFG_INVALID', overrides.message ?? 'port must be a number', {
    kind: 'config',
    ...(overrides.hint === undefined ? {} : { hint: overrides.hint }),
    context: { secret: 'must-not-print' },
  });
  // Pin the stack so the snapshot does not depend on file paths or line numbers.
  error.stack =
    'TsirError: port must be a number\n    at load (config.ts:12:5)\n    at main (cli.ts:3:1)';
  return error;
}

describe('TsirError.formatFor — dev', () => {
  test('message, hint, code and kind, then stack frames indented', () => {
    expect(failure({ hint: 'set PORT to an integer' }).formatFor('dev')).toBe(
      [
        '✗ port must be a number',
        '  ↳ set PORT to an integer',
        '  code: CFG_INVALID · kind: config',
        '    at load (config.ts:12:5)',
        '    at main (cli.ts:3:1)',
      ].join('\n'),
    );
  });

  test('no hint line when there is no hint', () => {
    expect(failure().formatFor('dev')).toBe(
      [
        '✗ port must be a number',
        '  code: CFG_INVALID · kind: config',
        '    at load (config.ts:12:5)',
        '    at main (cli.ts:3:1)',
      ].join('\n'),
    );
  });

  test('colour wraps only the mark in red when requested', () => {
    const out = failure().formatFor('dev', { colour: true });
    expect(out.startsWith('\x1b[31m✗\x1b[0m port must be a number\n')).toBe(true);
    expect(failure().formatFor('dev').startsWith('✗ port')).toBe(true);
  });

  test('context is never printed', () => {
    expect(failure({ hint: 'h' }).formatFor('dev', { colour: true })).not.toContain(
      'must-not-print',
    );
  });
});

describe('TsirError.formatFor — prod', () => {
  test('exactly one line with code, kind, correlation id and message', () => {
    expect(failure().formatFor('prod', { correlationId: 'req-7f3a' })).toBe(
      'level=error code=CFG_INVALID kind=config correlation_id=req-7f3a message="port must be a number"',
    );
  });

  test('correlation id is "-" when none is supplied', () => {
    expect(failure().formatFor('prod')).toBe(
      'level=error code=CFG_INVALID kind=config correlation_id=- message="port must be a number"',
    );
  });

  test('no stack, no hint, no context in prod', () => {
    const out = failure({ hint: 'set PORT' }).formatFor('prod');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('at load');
    expect(out).not.toContain('set PORT');
    expect(out).not.toContain('must-not-print');
  });

  test('newlines in a message are collapsed so input cannot forge a second record', () => {
    const out = failure({ message: 'bad value\nlevel=info code=OK message="all good"' }).formatFor(
      'prod',
    );
    expect(out).not.toContain('\n');
    expect(out).toBe(
      'level=error code=CFG_INVALID kind=config correlation_id=- message="bad value level=info code=OK message=\\"all good\\""',
    );
  });
});
