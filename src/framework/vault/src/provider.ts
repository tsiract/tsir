/**
 * `VaultKeyProvider` — where the vault gets its keys when they do not live in the
 * environment (`VLT-026`).
 *
 * The default deployment is a secret manager injecting `APP_KEY_NOW` /
 * `APP_KEY_NEXT` / `TSIR_KEYRING_FILE`. That is not every deployment: a KMS or an
 * HSM keeps the key material where it cannot be exported at all and hands back a
 * handle instead. This file is the seam for that case, and it is deliberately an
 * **interface with no vendor code** — a provider for AWS KMS, GCP KMS or a PKCS#11
 * module is twenty lines of adapter in *your* application, not a dependency in this
 * framework.
 *
 * The contract, in the order that matters:
 *
 *   1. **Called at boot, once per key id** — never per row. A provider that is asked
 *      per decryption is a network call inside a request, and the first p99 story
 *      writes itself.
 *   2. **It returns a `CryptoKey`**, not bytes. A KMS that can only *use* the key
 *      (encrypt/decrypt as a service) needs a different seam — one the framework does
 *      not have yet, and pretending otherwise would be the wrong interface to freeze.
 *   3. **The keyring still decides policy.** States (`active`, `decrypt-only`,
 *      `retired`) and ids come from the manifest; the provider only answers "give me
 *      the key for `v2`". Which keys exist is a deployment decision, not a KMS one.
 *
 * A provider that fails to load a key fails **boot**, loudly: a vault that starts
 * without one of its keys can write rows it cannot read back.
 */

import { invalidKeyMaterial } from './errors.ts';
import type { VaultAlg } from './envelope.ts';

/** What the vault asks for: the id it needs and the algorithm the envelope will use. */
export interface VaultKeyRequest {
  readonly keyId: string;
  readonly alg: VaultAlg;
}

export interface VaultKeyProvider {
  /** Shown in errors ("the `aws-kms` provider failed…"), so name it after the store. */
  readonly name: string;
  /**
   * Resolves one key. The returned key must be a non-extractable AES-GCM key with
   * the requested usages — a provider that hands back an extractable key has given
   * up the property the vault exists for.
   */
  loadKey(request: VaultKeyRequest): Promise<CryptoKey>;
}

/**
 * The default provider: the keyring's own material, imported per key id.
 *
 * Exposed so an application can wrap or decorate it — a provider that consults a KMS
 * for production keys and falls back to this one for local tests is a five-line
 * composition rather than a special case inside the vault.
 */
export interface LocalKeyProviderOptions {
  /** The material, keyed by id. `keyring.keys` has exactly this shape. */
  readonly materials: ReadonlyMap<
    string,
    { readonly alg: VaultAlg; readonly material: Uint8Array<ArrayBuffer> }
  >;
}

export function localKeyProvider(options: LocalKeyProviderOptions): VaultKeyProvider {
  return {
    name: 'local',

    async loadKey({ keyId, alg }): Promise<CryptoKey> {
      const entry = options.materials.get(keyId);
      if (entry === undefined) {
        throw invalidKeyMaterial(
          keyId,
          'the keyring lists this key as decryptable but no material was provided (add it to TSIR_KEYRING_FILE materials, or configure a VaultKeyProvider)',
        );
      }
      return importMaterial(keyId, alg, entry.material);
    },
  };
}

/**
 * Imports raw AES-256 material as a non-extractable key.
 *
 * Shared with the vault's own boot path so a provider and the default cannot drift
 * on the one property that matters: `extractable: false`.
 */
export async function importMaterial(
  keyId: string,
  alg: VaultAlg,
  material: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  if (alg !== 'aes-256-gcm') {
    throw invalidKeyMaterial(
      keyId,
      `${alg} has no implementation in this build — see 06-vault.md § 6 (ADR required before adding the dependency)`,
    );
  }
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Rejects a `CryptoKey` the vault cannot safely use.
 *
 * A KMS adapter that returns the wrong algorithm, an extractable key, or a
 * decrypt-only key for the writer is a bug that must surface at boot — never as a
 * confusing `VLT_AUTH_FAILED` on the first request.
 */
export function assertUsableKey(key: CryptoKey, request: VaultKeyRequest, writer: boolean): void {
  const algorithm = key.algorithm as { name?: string; length?: number };
  if (algorithm.name !== 'AES-GCM' || algorithm.length !== 256) {
    throw invalidKeyMaterial(
      request.keyId,
      `provider returned a ${algorithm.name ?? 'unknown'}${algorithm.length === undefined ? '' : `-${String(algorithm.length)}`} key; the vault needs AES-GCM-256`,
    );
  }
  if (key.extractable) {
    throw invalidKeyMaterial(
      request.keyId,
      'provider returned an extractable key; a vault key must be non-extractable so it cannot be exported by accident',
    );
  }
  // `KeyUsage` is a DOM lib type; the repo targets multiple runtimes and does not
  // depend on `lib.dom` being present in every tsconfig. The literal is enough.
  const needed: 'encrypt' | 'decrypt' = writer ? 'encrypt' : 'decrypt';
  if (!key.usages.includes(needed)) {
    throw invalidKeyMaterial(
      request.keyId,
      `provider returned a key without the "${needed}" usage`,
    );
  }
}
