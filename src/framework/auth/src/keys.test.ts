import { describe, expect, test } from 'bun:test';

import { createApiKeys } from './keys.ts';
import type { ApiKeyRecord, ApiKeyStore } from './keys.ts';
import { formatApiKey, hashToken, parseApiKey } from './token.ts';
import { memoryApiKeyStore } from './drivers/memory.ts';

const MINUTE = 60_000;

function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe('issuing', () => {
  test('the key is shown once and the store keeps only a hash of the secret', async () => {
    const time = clock();
    const store = memoryApiKeyStore();
    const keys = createApiKeys({ store, now: time.now });

    const { key, record } = await keys.issue({
      subject: 'user_1',
      name: 'CI deploy',
      scopes: ['deploy:write', 'logs:read'],
    });

    const parsed = parseApiKey(key);
    expect(parsed).toBeDefined();
    expect(parsed?.id).toBe(record.id);
    expect(record.name).toBe('CI deploy');
    expect(record.scopes).toEqual(['deploy:write', 'logs:read']);
    expect(record.createdAt).toBe(time.now());

    // The row holds `sha256(secret)` — never the secret, and never the key string.
    expect(record.secretHash).toBe(await hashToken(parsed?.secret ?? ''));
    expect(record.secretHash).not.toBe(parsed?.secret);
    expect(JSON.stringify(await store.get(record.id))).not.toContain(parsed?.secret ?? 'x');

    expect(store.size).toBe(1);
    expect(store.sharedAcrossInstances).toBe(false);
  });

  test('two keys never collide, and the id is long enough to index', async () => {
    const keys = createApiKeys({ store: memoryApiKeyStore() });
    const issued = await Promise.all(
      Array.from({ length: 50 }, async (_unused, index) =>
        keys.issue({ subject: 'user_1', name: `key ${String(index)}` }),
      ),
    );
    expect(new Set(issued.map((entry) => entry.key)).size).toBe(50);
    expect(new Set(issued.map((entry) => entry.record.id)).size).toBe(50);
    // 12 bytes of hex: 24 characters, 96 bits. Short enough for a header, long enough to never
    // repeat, and hex because `_` is the separator and is also in the base64url alphabet.
    for (const entry of issued) expect(entry.key.split('_')[1]).toMatch(/^[0-9a-f]{24}$/u);
  });

  test('scopes are copied, so a caller mutating its array cannot change the key', async () => {
    const scopes = ['a'];
    const keys = createApiKeys({ store: memoryApiKeyStore() });
    const { record } = await keys.issue({ subject: 's', name: 'n', scopes });
    scopes.push('b');
    expect(record.scopes).toEqual(['a']);

    const plain = await keys.issue({ subject: 's', name: 'n' });
    expect(plain.record.scopes).toEqual([]);
  });

  test('`idBytes` and `secretBytes` are options, and both are floored by `randomToken`', async () => {
    const keys = createApiKeys({ store: memoryApiKeyStore(), idBytes: 16, secretBytes: 48 });
    const { key } = await keys.issue({ subject: 's', name: 'n' });
    expect(parseApiKey(key)?.secret).toHaveLength(64); // 48 bytes → 64 characters
    expect(() =>
      createApiKeys({ store: memoryApiKeyStore(), secretBytes: 8 }).issue({
        subject: 's',
        name: 'n',
      }),
    ).toThrow(/at least 16 bytes/u);
  });
});

describe('verifying', () => {
  test('the right key verifies, and the record comes back', async () => {
    const store = memoryApiKeyStore();
    const keys = createApiKeys({ store });
    const { key, record } = await keys.issue({ subject: 'user_1', name: 'ci', scopes: ['build'] });

    const verified = await keys.verify(key);
    expect(verified?.id).toBe(record.id);
    expect(verified?.subject).toBe('user_1');
    expect(verified?.scopes).toEqual(['build']);
  });

  test('a wrong secret, an unknown id and a malformed key all answer `undefined`', async () => {
    const keys = createApiKeys({ store: memoryApiKeyStore() });
    const { key } = await keys.issue({ subject: 'user_1', name: 'ci' });
    const parts = key.split('_');
    const id = parts[1] ?? '';
    const secret = parts[2] ?? '';

    expect(await keys.verify(`${formatApiKey(id, `${secret.slice(0, -1)}X`)}`)).toBeUndefined();
    // Same length, one character different: the case a naive comparison leaks.
    const flipped = `${secret.slice(0, 4)}${secret[4] === 'A' ? 'B' : 'A'}${secret.slice(5)}`;
    expect(await keys.verify(formatApiKey(id, flipped))).toBeUndefined();

    expect(await keys.verify(formatApiKey('unknow', secret))).toBeUndefined();
    expect(await keys.verify('not a key at all')).toBeUndefined();
    expect(await keys.verify('')).toBeUndefined();
    expect(await keys.verify(`tsk_${id}`)).toBeUndefined();
    // The id alone, however correct, is never enough.
    expect(await keys.verify(`tsk_${id}_${secret.slice(0, 16)}`)).toBeUndefined();
  });

  test('a revoked key stops verifying even with the right secret', async () => {
    const time = clock();
    const keys = createApiKeys({ store: memoryApiKeyStore(), now: time.now });
    const { key, record } = await keys.issue({ subject: 'user_1', name: 'ci' });

    time.advance(MINUTE);
    expect(await keys.revoke(record.id)).toBe(true);
    expect(await keys.verify(key)).toBeUndefined();
    // The row stays: an audit needs to know the key existed.
    expect(await keys.list('user_1')).toHaveLength(1);
    expect((await keys.list('user_1'))[0]?.revokedAt).toBe(time.now());
    expect(await keys.revoke(record.id)).toBe(true); // idempotent on the memory store
    expect(await keys.revoke('nosuchkey')).toBe(false);
  });

  test('an expired key stops verifying, at the exact instant', async () => {
    const time = clock();
    const store = memoryApiKeyStore();
    const keys = createApiKeys({ store, now: time.now });
    const { key } = await keys.issue({
      subject: 'user_1',
      name: 'temporary',
      expiresAt: time.now() + MINUTE,
    });

    expect(await keys.verify(key)).toBeDefined();
    time.advance(MINUTE - 1);
    expect(await keys.verify(key)).toBeDefined();
    time.advance(1);
    expect(await keys.verify(key)).toBeUndefined();
  });

  test('`lastUsedAt` is recorded on a successful verify, and only on success', async () => {
    const time = clock();
    const store = memoryApiKeyStore();
    const keys = createApiKeys({ store, now: time.now });
    const { key, record } = await keys.issue({ subject: 'user_1', name: 'ci' });

    expect((await store.get(record.id))?.lastUsedAt).toBeUndefined();
    time.advance(MINUTE);
    await keys.verify(key);
    expect((await store.get(record.id))?.lastUsedAt).toBe(time.now());

    time.advance(MINUTE);
    const id = record.id;
    const secretPart = key.slice(`tsk_${id}_`.length);
    await keys.verify(formatApiKey(id, `${secretPart.slice(0, -1)}Z`));
    expect((await store.get(record.id))?.lastUsedAt).toBe(time.now() - MINUTE); // unchanged
  });

  test('a store that cannot touch still verifies: last use is best effort', async () => {
    const memory = memoryApiKeyStore();
    const flaky: ApiKeyStore = {
      ...memory,
      put: (record) => memory.put(record),
      get: (id) => memory.get(id),
      list: (subject) => memory.list(subject),
      revoke: (id, at) => memory.revoke(id, at),
      touch: () => Promise.reject(new Error('read-only replica')),
    };
    const keys = createApiKeys({ store: flaky });
    const { key } = await keys.issue({ subject: 'user_1', name: 'ci' });
    expect(await keys.verify(key)).toBeDefined();
  });
});

describe('listing', () => {
  test('a subject sees only its own keys, and a key list never carries a usable secret', async () => {
    const keys = createApiKeys({ store: memoryApiKeyStore() });
    await keys.issue({ subject: 'user_1', name: 'laptop' });
    await keys.issue({ subject: 'user_1', name: 'ci' });
    await keys.issue({ subject: 'user_2', name: 'other' });

    const listed = await keys.list('user_1');
    expect(listed.map((entry) => entry.name).sort()).toEqual(['ci', 'laptop']);
    expect(await keys.list('nobody')).toEqual([]);

    // The hash is present, the secret is not — a key screen needs the id, never the key.
    for (const entry of listed) {
      expect(entry.secretHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(entry).not.toHaveProperty('secret');
      expect(entry).not.toHaveProperty('key');
    }
  });

  test('the store hands back copies, so a listed record is not a live handle', async () => {
    const store = memoryApiKeyStore();
    const keys = createApiKeys({ store });
    const { record } = await keys.issue({ subject: 'user_1', name: 'ci', scopes: ['a'] });

    const copy = (await store.get(record.id)) as { scopes: string[] } & ApiKeyRecord;
    copy.scopes.push('b');
    expect((await store.get(record.id))?.scopes).toEqual(['a']);
  });
});

describe('errors', () => {
  test('the two coded errors are on the service, so a caller maps without importing', () => {
    const keys = createApiKeys({ store: memoryApiKeyStore() });
    expect(keys.errors.invalid().code).toBe('AUTH_API_KEY_INVALID');
    expect(keys.errors.revoked('abcdef').code).toBe('AUTH_API_KEY_REVOKED');
    expect(keys.errors.revoked('abcdef').message).toBe('API key "abcdef" was revoked');
  });
});
