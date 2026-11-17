import { describe, expect, test } from 'bun:test';

import { createVault, MAX_PLAINTEXT_BYTES, randomNonce } from './cipher.ts';
import { createVaultCodec } from './codec.ts';
import { createKeyring, keyringManifest } from './keyring.ts';
import { encodeBase64Url, parseEnvelope } from './envelope.ts';
import { formatKeySpec, generateKey, importVaultKey, parseKeySpec } from './keys.ts';

function codeOf(work: () => Promise<unknown>): Promise<string> {
  return work().then(
    () => 'none',
    (reason: unknown) => (reason as { code?: string }).code ?? 'no-code',
  );
}

const KEY = formatKeySpec(generateKey());
const COLUMN = { table: 'users', column: 'tax_id' } as const;

async function vault() {
  return createVault({ keyring: createKeyring({ now: KEY }) });
}

describe('AES-256-GCM through WebCrypto (VLT-002 … VLT-007)', () => {
  test('round-trips a string and stores an envelope, not the plaintext', async () => {
    const cipher = await vault();
    const envelope = await cipher.encrypt(COLUMN, '123-45-6789');

    expect(envelope.startsWith('tsir:v1:')).toBe(true);
    expect(envelope).not.toContain('123-45-6789');
    expect(await cipher.decrypt(COLUMN, envelope)).toBe('123-45-6789');
  });

  test('the same plaintext encrypts to a different ciphertext every time', async () => {
    const cipher = await vault();
    const first = await cipher.encrypt(COLUMN, 'same value');
    const second = await cipher.encrypt(COLUMN, 'same value');

    expect(first).not.toBe(second);
    // Different nonce is the mechanism; different bytes are the observable.
    expect(parseEnvelope(first).payload).not.toEqual(parseEnvelope(second).payload);
  });

  test('one flipped ciphertext byte fails authentication', async () => {
    const cipher = await vault();
    const envelope = parseEnvelope(await cipher.encrypt(COLUMN, 'secret'));

    const tampered = new Uint8Array(envelope.payload);
    tampered[12] = (tampered[12] as number) ^ 0x01;

    expect(
      await codeOf(() =>
        cipher.decrypt(
          COLUMN,
          `tsir:v1:${envelope.keyId}:${envelope.alg}:${encodeBase64Url(tampered)}`,
        ),
      ),
    ).toBe('VLT_AUTH_FAILED');
  });

  test('one flipped tag byte fails authentication', async () => {
    const cipher = await vault();
    const envelope = parseEnvelope(await cipher.encrypt(COLUMN, 'secret'));

    const tampered = new Uint8Array(envelope.payload);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0x80;

    expect(
      await codeOf(() =>
        cipher.decrypt(
          COLUMN,
          `tsir:v1:${envelope.keyId}:${envelope.alg}:${encodeBase64Url(tampered)}`,
        ),
      ),
    ).toBe('VLT_AUTH_FAILED');
  });

  test('a ciphertext moved to another column fails, because the AAD binds the location', async () => {
    const cipher = await vault();
    const envelope = await cipher.encrypt(COLUMN, '123-45-6789');

    // Same key, same table, different column: the plaintext is valid, the location is not.
    expect(await codeOf(() => cipher.decrypt({ table: 'users', column: 'phone' }, envelope))).toBe(
      'VLT_AUTH_FAILED',
    );
    expect(
      await codeOf(() => cipher.decrypt({ table: 'accounts', column: 'tax_id' }, envelope)),
    ).toBe('VLT_AUTH_FAILED');
  });

  test('a row written by a key this deployment does not hold is VLT_UNKNOWN_KEY (matrix row 8)', async () => {
    const cipher = await vault();
    const envelope = parseEnvelope(await cipher.encrypt(COLUMN, 'secret'));

    // Simulates an older instance meeting a row from a key that was later
    // activated elsewhere: the id parses, the key is absent, and that is all the
    // caller is told.
    const other = `tsir:v1:k2m4n6p3:${envelope.alg}:${encodeBase64Url(envelope.payload)}`;
    expect(await codeOf(() => cipher.decrypt(COLUMN, other))).toBe('VLT_UNKNOWN_KEY');
  });

  test('an unknown key id is an error, never a plaintext fallback', async () => {
    const cipher = await vault();
    const envelope = parseEnvelope(await cipher.encrypt(COLUMN, 'secret'));

    const other = `tsir:v1:k2m4n6p3:${envelope.alg}:${encodeBase64Url(envelope.payload)}`;
    expect(await codeOf(() => cipher.decrypt(COLUMN, other))).toBe('VLT_UNKNOWN_KEY');
    // The stored value is never returned as if it were the plaintext.
    expect(await codeOf(() => cipher.decrypt(COLUMN, other))).not.toBe('none');
  });

  test('APP_KEY_NEXT starts writing immediately, and APP_KEY_NOW keeps decrypting', async () => {
    // ADR-0008 as amended: deploying the next key *is* starting the migration.
    const next = formatKeySpec(generateKey());
    const nextId = next.split(':')[0] as string;
    const cipher = await createVault({ keyring: createKeyring({ now: KEY, next }) });

    expect(cipher.activeKeyId).toBe(nextId);
    // The old key stays in the decrypt set: rows written before the switch remain
    // readable without a second deploy.
    expect(cipher.keyIds).toContain(KEY.split(':')[0] as string);

    const envelope = parseEnvelope(await cipher.encrypt(COLUMN, 'after-switch'));
    expect(envelope.keyId).toBe(nextId);
  });

  test('plaintext above the limit is refused before any crypto', async () => {
    const cipher = await createVault({
      keyring: createKeyring({ now: KEY }),
      maxPlaintextBytes: 16,
    });

    expect(await codeOf(() => cipher.encrypt(COLUMN, 'x'.repeat(17)))).toBe('VLT_TOO_LARGE');
    // The documented default is 64 KiB (`06-vault.md § 2`).
    expect(MAX_PLAINTEXT_BYTES).toBe(65_536);
  });

  // A nonce is 96 random bits (GCM's limit), so the property worth asserting is the **width** of
  // the source and a no-collision run big enough to catch a broken generator. 1e6 encoded strings
  // cost ~4.2 s of SHA-free work and a Set that large, which blew the 5 s per-test budget on a
  // loaded CPU: the test measured the machine, not the nonce. 50 000 draws is ~100 ms and still
  // fails loudly for a constant, a counter that repeats, or a truncated buffer.
  test('nonces are 96 bits and do not collide across 50,000 draws (matrix row 3)', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 50_000; index += 1) seen.add(encodeBase64Url(randomNonce()));

    // 12 bytes is the width, not a convention: AES-GCM is defined for 96-bit IVs.
    expect(randomNonce()).toHaveLength(12);
    // 50 000 draws from 2^96 values: an expected 3.9e-20 collisions, so a duplicate is a bug.
    expect(seen.size).toBe(50_000);
  });
});

describe('the encrypted-text column codec (VLT-008, VLT-009)', () => {
  test('round-trips a string and passes null through untouched', async () => {
    const codec = createVaultCodec(await vault());

    const stored = await codec.encode(COLUMN, 'hello');
    expect(typeof stored).toBe('string');
    expect(await codec.decode(COLUMN, stored)).toBe('hello');

    // SQL NULL is "no value", not "encrypt the empty string".
    expect(await codec.encode(COLUMN, null)).toBeNull();
    expect(await codec.decode(COLUMN, null)).toBeNull();
  });

  test('an empty string is encrypted, not confused with null', async () => {
    const codec = createVaultCodec(await vault());
    const stored = await codec.encode(COLUMN, '');

    expect(stored).not.toBeNull();
    expect(stored).not.toBe('');
    expect(await codec.decode(COLUMN, stored)).toBe('');
  });

  test('non-strings are refused instead of being coerced', async () => {
    const codec = createVaultCodec(await vault());

    for (const value of [42, true, { a: 1 }, ['x'], undefined]) {
      expect(await codeOf(() => codec.encode(COLUMN, value))).toBe('VLT_UNSUPPORTED_TYPE');
    }
    expect(await codeOf(() => codec.decode(COLUMN, 42))).toBe('VLT_UNSUPPORTED_TYPE');
  });

  test('the codec is structurally compatible with the database seam', () => {
    // `@tsir/database`'s `ColumnCodec` is `{ name, encode, decode }`; importing it
    // here would invert the dependency arrow (database → vault), so the shape is
    // asserted structurally instead.
    const codec = createVaultCodec({
      activeKeyId: 'k7f3q2ab',
      keyIds: ['k7f3q2ab'],
      encrypt: async () => 'tsir:v1:k7f3q2ab:aes-256-gcm:AAAA',
      decrypt: async () => 'x',
    });

    expect(codec.name).toBe('vault.envelope.v1');
    expect(typeof codec.encode).toBe('function');
    expect(typeof codec.decode).toBe('function');
  });
});

describe('key material handling (VLT-005, VLT-006)', () => {
  test('the imported CryptoKey is not extractable', async () => {
    const key = await importVaultKey(parseKeySpec(KEY));

    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(['encrypt', 'decrypt']);
    // The one property that matters: the raw bytes cannot be read back out.
    expect(
      await crypto.subtle.exportKey('raw', key).then(
        () => 'exported',
        () => 'refused',
      ),
    ).toBe('refused');
  });

  test('the keyring keeps ids and states, never the material', async () => {
    const keyring = createKeyring({ now: KEY });
    const serialized = JSON.stringify(keyringManifest(keyring));
    const material = KEY.split(':')[2] as string;

    expect(serialized).not.toContain(material);
    expect(serialized).toContain(keyring.active.id);
    // And the vault itself exposes only ids.
    const cipher = await createVault({ keyring });
    expect(JSON.stringify({ keys: cipher.keyIds, active: cipher.activeKeyId })).not.toContain(
      material,
    );
  });
});

describe('versioned keys: APP_KEY_NOW=v1, APP_KEY_NEXT=v2 (ADR-0008 amended)', () => {
  const KEY_BYTES = () => crypto.getRandomValues(new Uint8Array(32));

  function spec(id: string): string {
    return formatKeySpec({ id, alg: 'aes-256-gcm', material: KEY_BYTES() });
  }

  test('a version id parses in three- and two-segment form', () => {
    const short = `v1:${encodeBase64Url(KEY_BYTES())}`;
    const parsed = parseKeySpec(short);

    expect(parsed.id).toBe('v1');
    expect(parsed.alg).toBe('aes-256-gcm');

    const long = parseKeySpec(`v2:aes-256-gcm:${encodeBase64Url(KEY_BYTES())}`);
    expect(long.id).toBe('v2');
  });

  test('envelopes carry the version, so a stored row says which key wrote it', async () => {
    const cipher = await createVault({
      keyring: createKeyring({ now: spec('v1'), next: spec('v2') }),
    });

    const envelope = await cipher.encrypt(COLUMN, 'hello');
    expect(envelope.startsWith('tsir:v1:v2:')).toBe(true);
    expect(parseEnvelope(envelope).keyId).toBe('v2');
  });

  test('v2 writes, v1 still reads, and v1 rows decrypt after the switch', async () => {
    const v1 = spec('v1');
    const v2 = spec('v2');

    // Before: only v1 deployed.
    const before = await createVault({ keyring: createKeyring({ now: v1 }) });
    const oldRow = await before.encrypt(COLUMN, 'written under v1');

    // Deploy APP_KEY_NEXT=v2: same instance now writes v2 and still reads v1.
    const after = await createVault({ keyring: createKeyring({ now: v1, next: v2 }) });
    const newRow = await after.encrypt(COLUMN, 'written under v2');

    expect(parseEnvelope(newRow).keyId).toBe('v2');
    expect(await after.decrypt(COLUMN, oldRow)).toBe('written under v1');

    // After activation: NEXT is gone, v1 remains decrypt-only via the manifest.
    const activated = await createVault({
      keyring: createKeyring({
        now: v2,
        manifest: [
          { id: 'v2', alg: 'aes-256-gcm', state: 'active' },
          { id: 'v1', alg: 'aes-256-gcm', state: 'decrypt-only' },
        ],
        materials: { v1 },
      }),
    });
    expect(await activated.decrypt(COLUMN, oldRow)).toBe('written under v1');
    expect(await activated.decrypt(COLUMN, newRow)).toBe('written under v2');
  });

  test('a manifest that still calls the previous key active is tolerated', () => {
    // The everyday case: v2 is deployed as APP_KEY_NEXT while the manifest written
    // yesterday still says v1 is active. The env decides the writer; the stale flag
    // is rewritten rather than treated as a second writer.
    const keyring = createKeyring({
      now: spec('v1'),
      next: spec('v2'),
      manifest: [{ id: 'v1', alg: 'aes-256-gcm', state: 'active' }],
    });

    expect(keyring.active.id).toBe('v2');
    expect(keyring.entry('v1')?.state).toBe('decrypt-only');
  });

  test('a manifest naming a third key active is still refused', async () => {
    expect(
      await codeOf(async () =>
        createKeyring({
          now: spec('v1'),
          next: spec('v2'),
          manifest: [{ id: 'v9', alg: 'aes-256-gcm', state: 'active' }],
        }),
      ),
    ).toBe('VLT_KEYRING_INVALID');
  });

  test('a generated id may be a version instead of random', async () => {
    const key = generateKey('aes-256-gcm', 'v3');
    expect(key.id).toBe('v3');
    expect(await codeOf(async () => generateKey('aes-256-gcm', '3v'))).toBe('VLT_KEYRING_INVALID');
  });
});
