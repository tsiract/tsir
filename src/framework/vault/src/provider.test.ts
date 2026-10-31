/**
 * `VaultKeyProvider` — the KMS/HSM seam (`VLT-026`).
 *
 * Every test here is about the *contract*, not about a vendor: the vault must be
 * able to run with keys that never existed as material in this process, and it must
 * fail boot — never the first request — when a provider hands it something it cannot
 * safely use.
 */

import { describe, expect, test } from 'bun:test';

import { createVault } from './cipher.ts';
import { formatKeySpec, generateKey } from './keys.ts';
import { createKeyring } from './keyring.ts';
import { localKeyProvider, type VaultKeyProvider, type VaultKeyRequest } from './provider.ts';

const V1 = generateKey('aes-256-gcm', 'v1');
const V2 = generateKey('aes-256-gcm', 'v2');
const COLUMN = { table: 'users', column: 'tax_id' } as const;

async function materialFor(request: VaultKeyRequest): Promise<CryptoKey> {
  const source = request.keyId === 'v1' ? V1 : V2;
  return crypto.subtle.importKey('raw', source.material, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** A fake KMS: returns real keys, and remembers every id it was asked for. */
function fakeKms(overrides: Partial<VaultKeyProvider> = {}): VaultKeyProvider & {
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    name: 'fake-kms',
    asked,
    async loadKey(request) {
      asked.push(request.keyId);
      return materialFor(request);
    },
    ...overrides,
  };
}

describe('VaultKeyProvider (VLT-026)', () => {
  test('the vault runs on keys that were never material in this process', async () => {
    const provider = fakeKms();
    const vault = await createVault({
      keyring: createKeyring({ now: formatKeySpec(V1), next: formatKeySpec(V2) }),
      provider,
    });

    const sealed = await vault.encrypt(COLUMN, '123-45-6789');
    expect(await vault.decrypt(COLUMN, sealed)).toBe('123-45-6789');

    // Once per key id at boot — never per row. The order follows `decryptKeyIds`
    // (writer first), so the assertion is about the set, not the sequence.
    expect([...provider.asked].sort()).toEqual(['v1', 'v2']);
  });

  test('a decrypt-only key with no local material boots when a provider can supply it', async () => {
    // The KMS case that the env-var deployment cannot express: the manifest says
    // "v1 still decrypts", but this process was never given v1's bytes.
    const keyring = createKeyring({
      now: formatKeySpec(V2),
      manifest: [
        { id: 'v1', alg: 'aes-256-gcm', state: 'decrypt-only' },
        { id: 'v2', alg: 'aes-256-gcm', state: 'active' },
      ],
      materials: { v2: formatKeySpec(V2) },
    });

    const withoutProvider = await createVault({ keyring }).catch((reason: unknown) => reason);
    expect(withoutProvider).toMatchObject({ code: 'VLT_INVALID_KEY_MATERIAL' });

    const vault = await createVault({ keyring, provider: fakeKms() });
    expect([...vault.keyIds].sort()).toEqual(['v1', 'v2']);
  });

  test('a provider failure fails boot, and names the provider and the key', async () => {
    const provider = fakeKms({
      async loadKey() {
        throw new Error('AccessDeniedException');
      },
    });

    const failure = (await createVault({
      keyring: createKeyring({ now: formatKeySpec(V1) }),
      provider,
    }).catch((reason: unknown) => reason)) as { code: string; message: string; hint: string };

    expect(failure.code).toBe('VLT_INVALID_KEY_MATERIAL');
    expect(failure.message).toContain('fake-kms');
    expect(failure.message).toContain('v1');
    expect(failure.message).toContain('AccessDeniedException');
    expect(failure.hint).toContain('cannot read back');
  });

  test('a key the vault cannot use is refused at boot, whatever the provider says', async () => {
    const extractable = await crypto.subtle.importKey(
      'raw',
      V1.material,
      { name: 'AES-GCM' },
      true, // <- the property the vault exists for
      ['encrypt', 'decrypt'],
    );
    const decryptOnly = await crypto.subtle.importKey(
      'raw',
      V1.material,
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );

    const cases: { readonly name: string; readonly key: CryptoKey; readonly message: string }[] = [
      { name: 'extractable', key: extractable, message: 'extractable' },
      // `v1` is the writer, so a decrypt-only key cannot encrypt with it.
      { name: 'no encrypt usage', key: decryptOnly, message: 'encrypt' },
    ];

    for (const testCase of cases) {
      const failure = (await createVault({
        keyring: createKeyring({ now: formatKeySpec(V1) }),
        provider: fakeKms({
          async loadKey() {
            return testCase.key;
          },
        }),
      }).catch((reason: unknown) => reason)) as { code: string; message: string };

      expect(failure.code).toBe('VLT_INVALID_KEY_MATERIAL');
      expect(failure.message).toContain(testCase.message);
    }
  });

  test('the default provider is the keyring, and it can be used explicitly', async () => {
    const keyring = createKeyring({ now: formatKeySpec(V1), next: formatKeySpec(V2) });
    const vault = await createVault({
      keyring,
      provider: localKeyProvider({ materials: keyring.keys }),
    });

    const sealed = await vault.encrypt(COLUMN, 'plain');
    expect(await vault.decrypt(COLUMN, sealed)).toBe('plain');
    expect(vault.activeKeyId).toBe('v2');
  });
});
