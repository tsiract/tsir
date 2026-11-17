import { describe, expect, test } from 'bun:test';
import { TsirError } from '@tsir/container';

import { defineConfig, env } from './define.ts';
import { loadConfig } from './load.ts';
import { Redacted, isRedacted, redact } from './redacted.ts';
import { formatConfigReport, type ConfigIssue } from './errors.ts';

const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
  DATABASE_URL: env.secret(),
  DATABASE_POOL_MAX: env.int({ min: 1, max: 50, default: 10 }),
  HTTP_PORT: env.int({ min: 1, max: 65_535, default: 3000 }),
  FEATURE_BILLING: env.bool({ default: false }),
  APP_NAME: env.string({ default: 'tsir-app', maxLength: 40 }),
});

function expectConfigError(fn: () => unknown, code: string): TsirError {
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

describe('config · loading', () => {
  test('valid environment produces typed values', () => {
    const config = loadConfig(spec, {
      env: {
        DATABASE_URL: 'postgres://localhost/app',
        DATABASE_POOL_MAX: '20',
        FEATURE_BILLING: 'true',
      },
    });

    expect(config.values.DATABASE_POOL_MAX).toBe(20);
    expect(config.values.HTTP_PORT).toBe(3000);
    expect(config.values.APP_ENV).toBe('development');
    expect(config.values.FEATURE_BILLING).toBe(true);
  });

  test('secrets become Redacted values', () => {
    const config = loadConfig(spec, { env: { DATABASE_URL: 'postgres://secret' } });
    expect(isRedacted(config.values.DATABASE_URL)).toBe(true);
    expect(config.values.DATABASE_URL.reveal()).toBe('postgres://secret');
  });

  test('omitting a required secret fails, not defaults', () => {
    const error = expectConfigError(() => loadConfig(spec, { env: {} }), 'CFG_INVALID');
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).toContain('required');
  });

  test('every invalid value is reported at once', () => {
    const error = expectConfigError(
      () =>
        loadConfig(spec, {
          env: {
            DATABASE_URL: 'x',
            HTTP_PORT: 'eighty',
            DATABASE_POOL_MAX: '0',
            FEATURE_BILLING: 'yes',
          },
        }),
      'CFG_INVALID',
    );
    expect(error.message).toContain('HTTP_PORT');
    expect(error.message).toContain('DATABASE_POOL_MAX');
    expect(error.message).toContain('FEATURE_BILLING');
    expect(error.context?.['issues']).toBe(3);
  });

  test('reports never contain secret values', () => {
    const secret = 'postgres://user:hunter2@db/app';
    try {
      loadConfig(spec, { env: { DATABASE_URL: secret, HTTP_PORT: 'nope' } });
      throw new Error('expected failure');
    } catch (error: unknown) {
      const tsirError = error as TsirError;
      expect(tsirError.message).not.toContain('hunter2');
      expect(JSON.stringify(tsirError.toLogObject())).not.toContain('hunter2');
    }
  });

  test('overrides win over the environment', () => {
    const config = loadConfig(spec, {
      env: { DATABASE_URL: 'env', HTTP_PORT: '4000' },
      overrides: { HTTP_PORT: '5000' },
    });
    expect(config.values.HTTP_PORT).toBe(5000);
  });

  test('an override for an unknown key fails', () => {
    expectConfigError(
      () => loadConfig(spec, { env: { DATABASE_URL: 'x' }, overrides: { NOT_A_KEY: '1' } }),
      'CFG_INVALID',
    );
  });

  test('unknown TSIR_ keys warn by default and fail in strict mode', () => {
    const warnings: string[] = [];
    loadConfig(spec, {
      env: { DATABASE_URL: 'x', TSIR_MYSTERY: '1' },
      onWarning: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(1);

    expectConfigError(
      () => loadConfig(spec, { env: { DATABASE_URL: 'x', TSIR_MYSTERY: '1' }, strictEnv: true }),
      'CFG_INVALID',
    );
  });

  test("the toolchain's own TSIR_ switches are not reported as application keys", () => {
    // `TSIR_DIST` is exported by the distribution's `tsir new`; it tells the CLI where the
    // distribution lives. An application never declares it, so a strict-mode boot must not fail on
    // it either — the same warning appeared in a fresh scaffold's `tsir doctor`.
    const warnings: string[] = [];
    loadConfig(spec, {
      env: { DATABASE_URL: 'x', TSIR_DIST: '/somewhere/dist' },
      onWarning: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(0);
    expect(() =>
      loadConfig(spec, { env: { DATABASE_URL: 'x', TSIR_DIST: '/x' }, strictEnv: true }),
    ).not.toThrow();
  });

  test('the terminal switches are toolchain switches too, not unknown application keys', () => {
    // `TSIR_TUI=ascii` and `TSIR_NO_INTERACTIVE=1` are read by `@tsir/tui`, never by the
    // application. A developer who runs `tsir doctor` with either set must not be told their
    // configuration is wrong — that warning named the toolchain's own variable.
    for (const env of ['TSIR_TUI', 'TSIR_NO_INTERACTIVE']) {
      const warnings: string[] = [];
      loadConfig(spec, {
        env: { DATABASE_URL: 'x', [env]: '1' },
        onWarning: (message) => warnings.push(message),
      });
      expect(warnings).toHaveLength(0);
      expect(() =>
        loadConfig(spec, { env: { DATABASE_URL: 'x', [env]: '1' }, strictEnv: true }),
      ).not.toThrow();
    }
  });

  test('unrelated env vars are ignored', () => {
    const config = loadConfig(spec, {
      env: { DATABASE_URL: 'x', PATH: '/usr/bin', HOME: '/root' },
    });
    expect(config.values.APP_NAME).toBe('tsir-app');
  });
});

describe('config · explicit conversion', () => {
  test.each(['1e3', ' 3', '3 ', '0x10', '1,000', 'three', ''])('integer rejects %p', (raw) => {
    expectConfigError(
      () => loadConfig(spec, { env: { DATABASE_URL: 'x', HTTP_PORT: raw } }),
      'CFG_INVALID',
    );
  });

  test('boolean accepts only the literal true/false', () => {
    expectConfigError(
      () => loadConfig(spec, { env: { DATABASE_URL: 'x', FEATURE_BILLING: '1' } }),
      'CFG_INVALID',
    );
    const config = loadConfig(spec, { env: { DATABASE_URL: 'x', FEATURE_BILLING: 'false' } });
    expect(config.values.FEATURE_BILLING).toBe(false);
  });

  test('numeric bounds are enforced', () => {
    expectConfigError(
      () => loadConfig(spec, { env: { DATABASE_URL: 'x', DATABASE_POOL_MAX: '51' } }),
      'CFG_INVALID',
    );
  });
});

describe('config · redaction', () => {
  test('Redacted cannot leak through string coercion', () => {
    const secret = redact('super-secret', 'TOKEN');
    expect(String(secret)).toBe('[redacted]');
    expect(String(secret)).toBe('[redacted]');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(secret.reveal()).toBe('super-secret');
  });

  test('the masked view is safe to serialize', () => {
    const config = loadConfig(spec, { env: { DATABASE_URL: 'postgres://hunter2@db' } });
    expect(JSON.stringify(config.masked)).not.toContain('hunter2');
    expect(JSON.stringify(config.values)).not.toContain('hunter2');
  });

  test('reveal hooks observe unwrapping', () => {
    const reveals: string[] = [];
    const value = new Redacted('x', 'DB_URL', { onReveal: (label) => reveals.push(label) });
    value.reveal();
    expect(reveals).toEqual(['DB_URL']);
  });

  test('fingerprints are stable and do not contain the secret', async () => {
    const { fingerprint } = await import('./load.ts');
    const first = await fingerprint('postgres://a');
    const second = await fingerprint('postgres://a');
    const other = await fingerprint('postgres://b');
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toHaveLength(12);
    expect(first).not.toContain('postgres');
  });
});

describe('config · report formatting', () => {
  test('report aligns keys and never embeds values', () => {
    const issues: readonly ConfigIssue[] = [
      { key: 'HTTP_PORT', message: 'must be a base-10 integer', source: 'env', code: 'invalid' },
      { key: 'DATABASE_URL', message: 'required (secret)', source: 'env', code: 'missing' },
    ];
    const report = formatConfigReport(issues, 'acme');
    const lines = report.split('\n');
    expect(lines[0]).toContain('CFG_INVALID');
    expect(lines[1]).toContain('DATABASE_URL');
    expect(lines[2]).toContain('HTTP_PORT');
    expect(lines.at(-1)).toContain('no partial boot');
  });
});

describe('name-based redaction (CFG-005)', () => {
  test('an unannotated FOO_PASSWORD is redacted, with no .secret() declared', () => {
    const spec = defineConfig({ FOO_PASSWORD: env.string({ default: 'x' }) });
    const config = loadConfig(spec, { env: { FOO_PASSWORD: 'hunter2' } });
    expect(isRedacted(config.values.FOO_PASSWORD)).toBe(true);
    expect(JSON.stringify(config.masked)).not.toContain('hunter2');
    expect(String(config.values.FOO_PASSWORD)).not.toContain('hunter2');
  });
});

describe('production requires secrets (CFG-008)', () => {
  const spec = defineConfig({
    APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
    API_KEY: env.secret(),
  });

  test('a required secret missing in production is refused and named', () => {
    let thrown: unknown;
    try {
      loadConfig(spec, { env: { APP_ENV: 'production' } });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TsirError);
    expect(String((thrown as TsirError).message)).toContain('API_KEY');
  });

  test('the same secret set in production loads, redacted', () => {
    const config = loadConfig(spec, { env: { APP_ENV: 'production', API_KEY: 'real' } });
    expect(isRedacted(config.values.API_KEY)).toBe(true);
  });
});

describe('value precedence (CFG-013)', () => {
  const spec = defineConfig({
    APP_NAME: env.string({ default: 'from-default' }),
    DATABASE_URL: env.secret(),
  });

  test('an override beats the environment, which beats the default', () => {
    const fromEnv = loadConfig(spec, { env: { APP_NAME: 'from-env', DATABASE_URL: 'x' } });
    expect(fromEnv.values.APP_NAME).toBe('from-env');

    const fromOverride = loadConfig(spec, {
      env: { APP_NAME: 'from-env', DATABASE_URL: 'x' },
      overrides: { APP_NAME: 'forced' },
    });
    expect(fromOverride.values.APP_NAME).toBe('forced');

    const fromDefault = loadConfig(spec, { env: { DATABASE_URL: 'x' } });
    expect(fromDefault.values.APP_NAME).toBe('from-default');
  });

  test('a missing required reference is reported under its key path', () => {
    let thrown: unknown;
    try {
      loadConfig(spec, { env: {} });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TsirError);
    expect(String((thrown as TsirError).message)).toContain('DATABASE_URL');
  });
});
