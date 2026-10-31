/**
 * Field-level coverage for `@tsir/config` (Gate P1: ≥ 90 % lines).
 *
 * The rule under test is narrowness: Tsir converts nothing implicitly, so every
 * rejected string below is rejected for a stated reason, not by accident.
 */

import { describe, expect, test } from 'bun:test';
import { TsirError } from '@tsir/container';
import { z } from 'zod';

import * as mini from '@tsir/validate/mini';

import { defineConfig, env, isFieldSpec } from './define.ts';
import { loadConfig, requireConfigValue, fingerprint } from './load.ts';
import { isRedacted, redact } from './redacted.ts';
import { configError, configInvalid, formatConfigReport, type ConfigIssue } from './errors.ts';

function expectError(fn: () => unknown, code: string): TsirError {
  try {
    fn();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(TsirError);
    const tsirError = error as TsirError;
    expect(tsirError.code).toBe(code);
    return tsirError;
  }
  throw new Error(`expected ${code}, nothing thrown`);
}

describe('config · field builders', () => {
  test('string constraints are enforced by the schema', () => {
    const spec = defineConfig({
      SLUG: env.string({ minLength: 3, maxLength: 8, pattern: /^[a-z-]+$/ }),
    });

    expect(loadConfig(spec, { env: { SLUG: 'abc' } }).values.SLUG).toBe('abc');
    expect(
      expectError(() => loadConfig(spec, { env: { SLUG: 'ab' } }), 'CFG_INVALID').message,
    ).toContain('SLUG');
    expect(
      expectError(() => loadConfig(spec, { env: { SLUG: 'ABC' } }), 'CFG_INVALID').message,
    ).toContain('SLUG');
  });

  test('required() has no default and rejects the empty string', () => {
    const spec = defineConfig({ QUEUE: env.required() });

    expect(spec.QUEUE.hasDefault).toBe(false);
    expect(loadConfig(spec, { env: { QUEUE: 'jobs' } }).values.QUEUE).toBe('jobs');
    expectError(() => loadConfig(spec, { env: {} }), 'CFG_INVALID');
    expectError(() => loadConfig(spec, { env: { QUEUE: '' } }), 'CFG_INVALID');
  });

  test('int() floors and ceilings are inclusive', () => {
    const spec = defineConfig({ N: env.int({ min: 1, max: 3 }) });

    expect(loadConfig(spec, { env: { N: '1' } }).values.N).toBe(1);
    expect(loadConfig(spec, { env: { N: '3' } }).values.N).toBe(3);
    expectError(() => loadConfig(spec, { env: { N: '0' } }), 'CFG_INVALID');
    expectError(() => loadConfig(spec, { env: { N: '4' } }), 'CFG_INVALID');
  });

  test('int() accepts negative decimal integers and nothing that merely looks numeric', () => {
    const spec = defineConfig({ N: env.int() });

    expect(loadConfig(spec, { env: { N: '-42' } }).values.N).toBe(-42);
    for (const rejected of ['1e3', ' 3', '3 ', '0x10', '1,000', '', '3.5', '٣']) {
      expectError(() => loadConfig(spec, { env: { N: rejected } }), 'CFG_INVALID');
    }
  });

  test('bool() refuses everything except the two literals', () => {
    const spec = defineConfig({ B: env.bool() });

    expect(loadConfig(spec, { env: { B: 'true' } }).values.B).toBe(true);
    expect(loadConfig(spec, { env: { B: 'false' } }).values.B).toBe(false);
    for (const rejected of ['TRUE', '1', '0', 'yes', 'on', '']) {
      expectError(() => loadConfig(spec, { env: { B: rejected } }), 'CFG_INVALID');
    }
  });

  test('enum() rejects values outside the declared list', () => {
    const spec = defineConfig({ MODE: env.enum(['a', 'b']) });

    expect(loadConfig(spec, { env: { MODE: 'b' } }).values.MODE).toBe('b');
    expectError(() => loadConfig(spec, { env: { MODE: 'c' } }), 'CFG_INVALID');
    expectError(() => loadConfig(spec, { env: { MODE: 'A' } }), 'CFG_INVALID');
  });

  test('custom() runs the supplied schema and honours the secret flag', () => {
    const spec = defineConfig({
      ENDPOINTS: env.custom(
        z.string().transform((raw) => raw.split(',')),
        { secret: false },
      ),
      TOKEN: env.custom(z.string().uuid(), { secret: true }),
    });

    const loaded = loadConfig(spec, {
      env: {
        ENDPOINTS: 'https://a.test,https://b.test',
        TOKEN: '2b1c1f9e-0000-4000-8000-000000000000',
      },
    });

    expect(loaded.values.ENDPOINTS).toEqual(['https://a.test', 'https://b.test']);
    expect(isRedacted(loaded.values.TOKEN)).toBe(true);
    expect(loaded.masked.TOKEN).toBe('[redacted]');
  });

  test('defaults are only used when the environment is silent', () => {
    const spec = defineConfig({
      LEVEL: env.int({ default: 3 }),
      LABEL: env.string({ default: 'x' }),
      FLAG: env.bool({ default: true }),
    });

    const loaded = loadConfig(spec, { env: {}, appName: 'defaults' });
    expect(loaded.values).toEqual({ LEVEL: 3, LABEL: 'x', FLAG: true });
    expect(loaded.warnings).toEqual([]);

    // An empty string is a value, not an absence: `env.string()` accepts it and
    // the default does NOT apply. Only `env.required()` treats empty as invalid.
    expect(loadConfig(spec, { env: { LABEL: '' } }).values.LABEL).toBe('');
  });

  test('a default that violates its own schema fails at declaration time', () => {
    // Zod's `.default()` does not validate the value it returns; Tsir closes that
    // hole so a schema bug cannot reach a production boot.
    expectError(() => env.string({ minLength: 3, default: 'ab' }), 'CFG_INVALID_DEFAULT');
    expectError(() => env.int({ min: 1, max: 5, default: 9 }), 'CFG_INVALID_DEFAULT');

    // The valid case is unaffected.
    expect(env.string({ minLength: 3, default: 'abc' }).hasDefault).toBe(true);
  });

  test('a field with no default is required, not silently empty', () => {
    const spec = defineConfig({ N: env.int(), B: env.bool(), S: env.string() });
    const error = expectError(() => loadConfig(spec, { env: {} }), 'CFG_INVALID');

    expect(error.message).toContain('N');
    expect(error.message).toContain('B');
    expect(error.message).toContain('S');
    expect(error.message).toContain('required');
  });

  test('defaults are validated once, at declaration, and re-parsed at boot', () => {
    // Booleans and integers are declared with a value but validated as env strings;
    // the round trip must produce the same value as an environment variable would.
    const spec = defineConfig({
      PORT: env.int({ default: 3000 }),
      DEBUG: env.bool({ default: true }),
    });
    expect(loadConfig(spec, { env: {} }).values).toEqual({ PORT: 3000, DEBUG: true });
    expect(loadConfig(spec, { env: { PORT: '8080' } }).values.PORT).toBe(8080);
    expect(loadConfig(spec, { env: { DEBUG: 'false' } }).values.DEBUG).toBe(false);
  });

  test('env.custom accepts a schema from any Standard Schema validator', () => {
    // Zod mini is a different type from full Zod; both must work, because the
    // field stores the Standard Schema interface, not a validator class.
    const spec = defineConfig({
      FROM_MINI: env.custom(mini.string().check(mini.minLength(3))),
      FROM_ZOD: env.custom(z.string().uuid()),
    });

    const loaded = loadConfig(spec, {
      env: { FROM_MINI: 'abc', FROM_ZOD: '2b1c1f9e-0000-4000-8000-000000000000' },
    });
    expect(loaded.values.FROM_MINI).toBe('abc');
    expectError(
      () => loadConfig(spec, { env: { FROM_MINI: 'ab', FROM_ZOD: 'nope' } }),
      'CFG_INVALID',
    );
  });

  test('a custom schema with its own default satisfies hasDefault', () => {
    const spec = defineConfig({ REGION: env.custom(z.string().default('eu-west-1')) });
    expect(loadConfig(spec, { env: {} }).values.REGION).toBe('eu-west-1');
  });

  test('a custom schema that validates asynchronously cannot be used at boot', () => {
    const Async = z.string().refine(async () => true);
    const spec = defineConfig({ X: env.custom(Async) });

    // The async path only runs once the base type passes, which is exactly when a
    // silent half-validated value would otherwise slip through.
    expectError(() => loadConfig(spec, { env: { X: 'value' } }), 'VLD_ASYNC_SCHEMA');
  });

  test('isFieldSpec distinguishes descriptors from arbitrary objects', () => {
    expect(isFieldSpec(env.string())).toBe(true);
    expect(isFieldSpec({ schema: z.string() })).toBe(false);
    expect(isFieldSpec(null)).toBe(false);
    expect(isFieldSpec('APP_ENV')).toBe(false);
  });
});

describe('config · override policy', () => {
  test('a non-overridable field refuses an explicit override', () => {
    const spec = defineConfig({ PINNED: env.string({ overridable: false }) });

    expect(loadConfig(spec, { env: { PINNED: 'env' } }).values.PINNED).toBe('env');
    const error = expectError(
      () => loadConfig(spec, { env: { PINNED: 'env' }, overrides: { PINNED: 'forced' } }),
      'CFG_INVALID',
    );
    expect(error.message).toContain('not overridable');
    expect(error.context?.issues).toBe(1);
  });

  test('an override satisfies a required field even with an empty environment', () => {
    const spec = defineConfig({ SECRET_KEY: env.secret() });
    const loaded = loadConfig(spec, {
      env: {},
      overrides: { SECRET_KEY: 'test-key-value' },
    });

    expect(isRedacted(loaded.values.SECRET_KEY)).toBe(true);
    expect(loaded.values.SECRET_KEY.reveal()).toBe('test-key-value');
  });

  test('overrides win over the environment for every field kind', () => {
    const spec = defineConfig({
      PORT: env.int({ default: 3000 }),
      DEBUG: env.bool({ default: false }),
    });
    const loaded = loadConfig(spec, {
      env: { PORT: '4000', DEBUG: 'true' },
      overrides: { PORT: '5000', DEBUG: 'false' },
    });

    expect(loaded.values).toEqual({ PORT: 5000, DEBUG: false });
  });
});

describe('config · unknown keys', () => {
  test('only the TSIR_ prefix participates in the unknown-key check', () => {
    const spec = defineConfig({ KNOWN: env.string({ default: 'k' }) });

    const ignored = loadConfig(spec, { env: { SOME_OTHER_VAR: 'x', KNOWN: 'y' } });
    expect(ignored.warnings).toEqual([]);

    const warned = loadConfig(spec, { env: { TSIR_MYSTERY: '1' } });
    expect(warned.warnings).toHaveLength(1);
    expect(warned.warnings[0]).toContain('TSIR_MYSTERY');
  });

  test('warnings are delivered through the callback when loading fails', () => {
    const seen: string[] = [];
    const spec = defineConfig({ NEEDED: env.required() });

    expectError(
      () =>
        loadConfig(spec, {
          env: { TSIR_UNUSED: '1' },
          onWarning: (message) => {
            seen.push(message);
          },
        }),
      'CFG_INVALID',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('TSIR_UNUSED');
  });

  test('strict mode turns the same key into a failure with source env', () => {
    const spec = defineConfig({ KNOWN: env.string({ default: 'k' }) });
    const error = expectError(
      () => loadConfig(spec, { env: { TSIR_NOPE: '1' }, strictEnv: true }),
      'CFG_INVALID',
    );
    expect(error.message).toContain('TSIR_NOPE');
    expect(error.message).toContain('env');
  });
});

describe('config · result shape', () => {
  test('values are frozen and copied, not aliased to the source', () => {
    const env_ = { A: '1' };
    const spec = defineConfig({ A: env.string() });
    const loaded = loadConfig(spec, { env: env_ });

    expect(Object.isFrozen(loaded.values)).toBe(true);
    expect(Object.isFrozen(loaded.masked)).toBe(true);
    env_.A = 'mutated';
    expect(loaded.values.A).toBe('1');
    expect(() => {
      (loaded.values as Record<string, unknown>)['A'] = 'changed';
    }).toThrow();
  });

  test('the app name defaults and is carried through', () => {
    const spec = defineConfig({ A: env.string({ default: 'a' }) });
    expect(loadConfig(spec, { env: {} }).appName).toBe('tsir-app');
    expect(loadConfig(spec, { env: {}, appName: 'billing' }).appName).toBe('billing');
  });

  test('requireConfigValue reads a present key and names a missing one', () => {
    const loaded = loadConfig(defineConfig({ A: env.string({ default: 'a' }) }), { env: {} });

    expect(requireConfigValue(loaded as never, 'A')).toBe('a');
    const error = expectError(
      () => requireConfigValue(loaded as never, 'MISSING'),
      'CFG_MISSING_KEY',
    );
    expect(error.message).toContain('MISSING');
    expect(error.kind).toBe('config');
  });
});

describe('config · redaction primitives', () => {
  test('toJSON, inspection, and coercion all mask', () => {
    const secret = redact('hunter2', 'DB_PASSWORD');

    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(String(secret)).toBe('[redacted]');
    expect(secret.toString()).toBe('[redacted]');
    expect(secret.label).toBe('DB_PASSWORD');

    const inspect = (secret as unknown as Record<symbol, () => string>)[
      Symbol.for('nodejs.util.inspect.custom')
    ];
    expect(inspect?.call(secret)).toBe('[redacted]<DB_PASSWORD>');
  });

  test('reveal() is the only path to the value and it is observable', () => {
    const labels: string[] = [];
    const secret = redact('value', 'API_KEY', {
      onReveal: (label) => {
        labels.push(label);
      },
    });

    expect(secret.reveal()).toBe('value');
    expect(labels).toEqual(['API_KEY']);
  });

  test('redacted instances are frozen', () => {
    const secret = redact('value', 'X');
    expect(Object.isFrozen(secret)).toBe(true);
    expect(isRedacted(secret)).toBe(true);
    expect(isRedacted('value')).toBe(false);
  });

  test('fingerprints are stable, short, and distinct per value', async () => {
    const a = await fingerprint('alpha');
    const b = await fingerprint('alpha');
    const c = await fingerprint('beta');

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(12);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).not.toContain('alpha');
  });
});

describe('config · error construction', () => {
  test('configInvalid sorts issues and counts them', () => {
    const error = configInvalid([
      { key: 'Z_KEY', message: 'required', source: 'env', code: 'missing' },
      { key: 'A_KEY', message: 'invalid', source: 'default', code: 'invalid' },
    ]);

    expect(error.code).toBe('CFG_INVALID');
    expect(error.kind).toBe('config');
    expect(error.context?.issues).toBe(2);
    expect(error.message.indexOf('A_KEY')).toBeLessThan(error.message.indexOf('Z_KEY'));
    expect(error.hint).toContain('never boots');
  });

  test('configError omits absent hint and context rather than storing undefined', () => {
    const bare = configError('CFG_MISSING_KEY', 'missing');
    expect(bare.hint).toBeUndefined();
    expect(bare.context).toBeUndefined();

    const full = configError('CFG_MISSING_KEY', 'missing', 'set it', { key: 'A' });
    expect(full.hint).toBe('set it');
    expect(full.context).toEqual({ key: 'A' });
  });

  test('the boot report is aligned and carries no values', () => {
    const issues: ConfigIssue[] = [
      { key: 'A_SHORT', message: 'required', source: 'env', code: 'missing' },
      { key: 'LONGER_KEY', message: 'invalid', source: 'default', code: 'invalid' },
    ];
    const lines = formatConfigReport(issues, 'billing').split('\n');

    expect(lines[0]).toContain('billing');
    expect(lines[0]).toContain('CFG_INVALID');
    expect(lines[1]).toContain('A_SHORT');
    // Alignment: message columns start at the same offset.
    expect(lines[1]?.indexOf('required')).toBe(lines[2]?.indexOf('invalid'));
    expect(lines.at(-1)).toContain('no partial boot');
  });
});

describe('config · default environment resolution', () => {
  test('without an explicit env record the loader reads the live environment', () => {
    const previous = process.env['TSIR_TEST_LIVE_KEY'];
    process.env['TSIR_TEST_LIVE_KEY'] = 'from-process';
    try {
      const spec = defineConfig({ TSIR_TEST_LIVE_KEY: env.string() });
      expect(loadConfig(spec).values.TSIR_TEST_LIVE_KEY).toBe('from-process');
    } finally {
      if (previous === undefined) delete process.env['TSIR_TEST_LIVE_KEY'];
      else process.env['TSIR_TEST_LIVE_KEY'] = previous;
    }
  });
});
