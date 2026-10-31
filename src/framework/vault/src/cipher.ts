/**
 * AES-256-GCM through WebCrypto (`VLT-002` … `VLT-004`, `VLT-007`).
 *
 * There is no custom primitive here and there never will be: every byte of crypto
 * is `crypto.subtle` and `crypto.getRandomValues`, both of which exist unchanged in
 * Bun, Node 20+ and Workers.
 *
 * The three decisions worth naming:
 *
 * 1. **AAD binds the location.** The tag covers `tsir:v1:<id>:<alg>:<table>.<column>`,
 *    so a ciphertext moved from `users.tax_id` to `users.phone` fails to decrypt.
 *    Without it, a `UPDATE … SET phone = tax_id` bug is a silent data swap that no
 *    type checker would catch — both columns are strings.
 * 2. **A fresh 96-bit nonce per encryption**, from the CSPRNG, never derived from a
 *    counter: a counter needs durable state, and durable state in a serverless
 *    runtime is exactly the thing that gets reset and reused.
 * 3. **One uniform failure.** A tag mismatch, a wrong key and a wrong AAD all raise
 *    `VLT_AUTH_FAILED`. Distinguishing them would hand an attacker a decryption
 *    oracle for free.
 */

import {
  associatedData,
  joinPayload,
  parseEnvelope,
  serializeEnvelope,
  splitPayload,
} from './envelope.ts';
import type { VaultAlg } from './envelope.ts';
import { authFailed, tooLarge, unknownKey } from './errors.ts';
import { TsirError } from '@tsir/core';
import type { Keyring } from './keyring.ts';
import { assertUsableKey, localKeyProvider, type VaultKeyProvider } from './provider.ts';

/** `06-vault.md § 2`: columns hold short values; blobs belong in storage. */
export const MAX_PLAINTEXT_BYTES = 64 * 1024;

/** 96 bits, the size AES-GCM is defined for. */
export const NONCE_BYTES = 12;

export interface VaultColumn {
  readonly table: string;
  readonly column: string;
}

export interface Vault {
  /** The key id new writes carry. */
  readonly activeKeyId: string;
  /** Every id this process can decrypt with, for operator output. */
  readonly keyIds: readonly string[];
  /** Application string → stored envelope. */
  encrypt(column: VaultColumn, plaintext: string): Promise<string>;
  /** Stored envelope → application string. Throws rather than returning ciphertext. */
  decrypt(column: VaultColumn, stored: string): Promise<string>;
}

export interface VaultOptions {
  readonly keyring: Keyring;
  /**
   * Where the `CryptoKey`s come from (`VLT-026`). Defaults to importing the
   * keyring's own material; a KMS/HSM adapter supplies its own.
   */
  readonly provider?: VaultKeyProvider | undefined;
  /** Overrides the documented limit; tests use a small one to prove the path. */
  readonly maxPlaintextBytes?: number | undefined;
}

/**
 * A fresh 96-bit nonce from the platform CSPRNG.
 *
 * Typed as `Uint8Array<ArrayBuffer>` because `crypto.subtle` refuses a view over a
 * `SharedArrayBuffer`; making that explicit here keeps the copy-into-a-buffer dance
 * out of every call site.
 */
export function randomNonce(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
}

/**
 * Loads one key from a provider and refuses anything the vault cannot use.
 *
 * A provider failure is wrapped rather than propagated raw: the operator needs to
 * know *which provider* could not load *which key id*, and a KMS SDK's error message
 * ("AccessDeniedException") says nothing about either.
 */
async function loadFrom(
  provider: VaultKeyProvider,
  request: { readonly keyId: string; readonly alg: VaultAlg },
  writer: boolean,
): Promise<CryptoKey> {
  let key: CryptoKey;
  try {
    key = await provider.loadKey(request);
  } catch (reason: unknown) {
    throw new TsirError(
      'VLT_INVALID_KEY_MATERIAL',
      `the "${provider.name}" VaultKeyProvider could not load key "${request.keyId}": ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
      {
        kind: 'vault',
        hint: 'the vault refuses to start without a key it lists as decryptable: it would write rows it cannot read back',
        context: { provider: provider.name, keyId: request.keyId },
      },
    );
  }
  assertUsableKey(key, request, writer);
  return key;
}

/** Copies into an `ArrayBuffer`-backed view — the shape WebCrypto accepts. */
function toBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

/**
 * Builds the vault and imports every decryptable key.
 *
 * Async on purpose — WebCrypto imports keys asynchronously, so there is no way to
 * hand an application a vault whose keys are "not ready yet". Construction failing
 * is the correct outcome for a bad keyring: the process should not start.
 */
export async function createVault(options: VaultOptions): Promise<Vault> {
  const { keyring } = options;
  const limit = options.maxPlaintextBytes ?? MAX_PLAINTEXT_BYTES;

  // One provider, two sources: the keyring's material by default, a KMS when the
  // deployment has one. Either way the import happens exactly once per key id —
  // here, at boot — and never inside a request.
  const provider =
    options.provider ??
    localKeyProvider({
      materials: keyring.keys,
    });

  const imported = new Map<string, CryptoKey>();
  for (const id of keyring.decryptKeyIds) {
    const entry = keyring.entry(id);
    const request = { keyId: id, alg: entry?.alg ?? 'aes-256-gcm' };
    const key = await loadFrom(provider, request, id === keyring.active.id);
    imported.set(id, key);
  }

  const activeKey = keyring.keys.get(keyring.active.id) ?? keyring.entry(keyring.active.id);
  if (activeKey === undefined) throw unknownKey(keyring.active.id, [...keyring.keys.keys()]);
  const activeCryptoKey = imported.get(activeKey.id) as CryptoKey;

  const encoder = new TextEncoder();

  return {
    activeKeyId: keyring.active.id,
    keyIds: [...imported.keys()],

    async encrypt(column, plaintext) {
      const bytes = encoder.encode(plaintext);
      // Size first: rejecting after the crypto call would have already produced a
      // ciphertext nobody can store.
      if (bytes.byteLength > limit) throw tooLarge(bytes.byteLength, limit);

      const alg: VaultAlg = activeKey.alg;
      const nonce = randomNonce();
      const sealed = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: toBuffer(associatedData(alg, activeKey.id, column.table, column.column)),
          tagLength: 128,
        },
        activeCryptoKey,
        toBuffer(bytes),
      );

      // Serialized through the envelope module, so the write path and the parse
      // path cannot disagree about the format.
      return serializeEnvelope({
        keyId: activeKey.id,
        alg,
        payload: joinPayload(nonce, new Uint8Array(sealed)),
      });
    },

    async decrypt(column, stored) {
      const envelope = parseEnvelope(stored);
      const key = imported.get(envelope.keyId);
      // A row from a newer deployment, or one written with a key that was removed.
      // Never a fallback: returning the ciphertext would be a silent leak.
      if (key === undefined) throw unknownKey(envelope.keyId, [...imported.keys()]);

      const { nonce, ciphertext, tag } = splitPayload(envelope.alg, envelope.payload);
      const sealed = new Uint8Array(ciphertext.length + tag.length);
      sealed.set(ciphertext, 0);
      sealed.set(tag, ciphertext.length);

      let plaintext: ArrayBuffer;
      try {
        plaintext = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: toBuffer(nonce),
            additionalData: toBuffer(
              associatedData(envelope.alg, envelope.keyId, column.table, column.column),
            ),
            tagLength: 128,
          },
          key,
          toBuffer(sealed),
        );
      } catch {
        // One error for tampering, wrong key and wrong AAD: see the module note.
        throw authFailed(envelope.keyId);
      }

      return new TextDecoder().decode(plaintext);
    },
  };
}
