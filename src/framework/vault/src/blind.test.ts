import { describe, expect, test } from 'bun:test';

import { BLIND_INDEX_LENGTH, createBlindIndex, generateBlindIndexKey } from './blind.ts';

const KEY = generateBlindIndexKey();

/** `createBlindIndex` is async, so a refusal is a rejection, not a throw. */
async function rejects(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'none';
  } catch (reason: unknown) {
    return (reason as { code?: string }).code ?? 'no-code';
  }
}

describe('blind index (VLT-025)', () => {
  test('the same value produces the same 43-character digest', async () => {
    const index = await createBlindIndex({ key: KEY, table: 'users', column: 'email' });

    const first = await index.compute('alice@example.com');
    const second = await index.compute('alice@example.com');

    expect(first).toBe(second);
    expect(first).toHaveLength(BLIND_INDEX_LENGTH);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    // It is a digest, not the value.
    expect(first).not.toContain('alice');
  });

  test('different values, columns and keys produce unrelated digests', async () => {
    const users = await createBlindIndex({ key: KEY, table: 'users', column: 'email' });
    const phones = await createBlindIndex({ key: KEY, table: 'users', column: 'phone' });
    const other = await createBlindIndex({
      key: generateBlindIndexKey(),
      table: 'users',
      column: 'email',
    });

    const alice = await users.compute('alice@example.com');
    const bob = await users.compute('bob@example.com');

    expect(alice).not.toBe(bob);
    // Domain separation: the same value under a different column is a different
    // digest, so a digest cannot be replayed across columns.
    expect(await phones.compute('alice@example.com')).not.toBe(alice);
    // Key separation: a stolen digest is useless without the index secret.
    expect(await other.compute('alice@example.com')).not.toBe(alice);
  });

  test('matches() compares in constant time and says no honestly', async () => {
    const index = await createBlindIndex({ key: KEY, table: 'users', column: 'email' });
    const stored = await index.compute('alice@example.com');

    expect(await index.matches('alice@example.com', stored)).toBe(true);
    expect(await index.matches('bob@example.com', stored)).toBe(false);
    expect(await index.matches('alice@example.com', stored.slice(0, -1))).toBe(false);
    expect(await index.matches('alice@example.com', `${stored}extra`)).toBe(false);
  });

  test('normalisation is opt-in, and applies to lookups as well as writes', async () => {
    const raw = await createBlindIndex({ key: KEY, table: 'users', column: 'email' });
    expect(await raw.compute('  Alice@Example.com ')).not.toBe(
      await raw.compute('alice@example.com'),
    );

    const folded = await createBlindIndex({
      key: KEY,
      table: 'users',
      column: 'email',
      normalize: (value) => value.trim().toLowerCase(),
    });
    const stored = await folded.compute('  Alice@Example.com ');
    expect(await folded.matches('alice@example.com', stored)).toBe(true);
  });

  test('a vault key spec, a short key or a missing target is refused', async () => {
    expect(
      await rejects(createBlindIndex({ key: 'v1:aes-256-gcm:AAAA', table: 'u', column: 'c' })),
    ).toBe('VLT_INVALID_KEY_MATERIAL');
    expect(await rejects(createBlindIndex({ key: 'short', table: 'u', column: 'c' }))).toBe(
      'VLT_INVALID_KEY_MATERIAL',
    );
    expect(await rejects(createBlindIndex({ key: KEY, table: '', column: 'c' }))).toBe(
      'VLT_INVALID_KEY_MATERIAL',
    );
  });
});
