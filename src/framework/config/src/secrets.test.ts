/**
 * The inlined-secret detector (`CFG-016`): a literal key or a literal URL password is a finding;
 * an environment reference or a placeholder is not.
 */

import { describe, expect, test } from 'bun:test';

import { inlinedSecrets, inlinedSecretsInText, isSecretName, secretKind } from './secrets.ts';

const KEY = 'q8Zl3vT1nH6mWcR0yBfXk2Ld9sUoAeP4iJtVg7NhCz8='; // 32 random bytes in base64

describe('secretKind (CFG-016)', () => {
  test('a 32-byte base64 key is a finding', () => {
    expect(KEY.length).toBe(44);
    expect(secretKind(KEY)).toBe('base64-32-byte-key');
  });

  test('a URL with a literal password is a finding', () => {
    expect(secretKind('postgres://app:hunter2@db.internal:5432/app')).toBe('url-password');
  });

  test('ordinary values are not findings', () => {
    expect(secretKind('postgres://db.internal:5432/app')).toBeUndefined();
    expect(secretKind('postgres://app@db.internal/app')).toBeUndefined();
    expect(secretKind('postgres://app:${DB_PASSWORD}@db.internal/app')).toBeUndefined();
    expect(secretKind('hello world')).toBeUndefined();
    expect(secretKind('abc')).toBeUndefined();
  });
});

describe('inlinedSecrets (loaded configuration)', () => {
  test('lists every literal by key path and never includes the value', () => {
    const found = inlinedSecrets({
      database: { url: 'postgres://app:hunter2@db/app' },
      vault: { keys: [KEY] },
      app: { name: 'fine' },
    });
    expect(found).toEqual([
      { where: 'database.url', kind: 'url-password' },
      { where: 'vault.keys[0]', kind: 'base64-32-byte-key' },
    ]);
    expect(JSON.stringify(found)).not.toContain('hunter2');
  });

  test('an environment reference is never a finding', () => {
    expect(inlinedSecrets({ database: { url: { fromEnv: 'DATABASE_URL' } } })).toEqual([]);
  });
});

describe('inlinedSecretsInText (CFG-114)', () => {
  test('reports the line of each quoted secret and ignores a comment', () => {
    const text = [
      'export default {',
      '  // postgres://app:hunter2@db/app is only an example',
      `  database: { url: 'postgres://app:hunter2@db/app' },`,
      '};',
    ].join('\n');
    expect(inlinedSecretsInText(text)).toEqual([{ where: 'line 3', kind: 'url-password' }]);
  });
});

describe('isSecretName (CFG-005)', () => {
  test.each([
    'FOO_PASSWORD',
    'api_token',
    'PRIVATE_KEY',
    'DB_CREDENTIALS',
    'STRIPE_API_KEY',
    'SECRET',
  ])('%s is secret-named', (key) => {
    expect(isSecretName(key)).toBe(true);
  });

  test.each(['PASSWORD_MIN_LENGTH', 'KEYBOARD', 'APP_NAME', 'TOKENIZER_MODE'])(
    '%s is not',
    (key) => {
      expect(isSecretName(key)).toBe(false);
    },
  );
});
