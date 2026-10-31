/**
 * @tsir/vault — versioned, authenticated column encryption.
 *
 * Public surface:
 *   createVault, Vault, VaultOptions, MAX_PLAINTEXT_BYTES, randomNonce,
 *   createVaultCodec, VaultColumnCodec, VaultColumnRef,
 *   createKeyring, Keyring, KeyringEntry, KeyringInput, KeyState, KEY_STATES,
 *   canTransition, assertTransition, keyringManifest,
 *   parseKeySpec, importVaultKey, formatKeySpec, generateKey, assertKeyId, keyIdOf,
 *   ParsedKey, KEY_BYTES,
 *   parseEnvelope, serializeEnvelope, splitPayload, associatedData, Envelope, VaultAlg,
 *   VAULT_ALGS, ENVELOPE_PREFIX, ENVELOPE_VERSION, KEY_ID_PATTERN,
 *   VaultErrorCode
 *
 * The design rule that shapes every file here: **fail closed**. There is no code
 * path in this package that returns a stored value to an application when it cannot
 * authenticate it, and no path that returns a partial plaintext. `06-vault.md § 7`
 * lists the codes; `errors.ts` implements them with that rule in the comments.
 */

export {
  BLIND_INDEX_BYTES,
  BLIND_INDEX_LENGTH,
  createBlindIndex,
  generateBlindIndexKey,
} from './blind.ts';
export type { BlindIndex, BlindIndexOptions } from './blind.ts';

export { assertUsableKey, importMaterial, localKeyProvider } from './provider.ts';
export type { LocalKeyProviderOptions, VaultKeyProvider, VaultKeyRequest } from './provider.ts';

export { planActivation, planRetire } from './activate.ts';
export type {
  ActivationPlan,
  ActivationPlanInput,
  RetirePlan,
  RetirePlanInput,
} from './activate.ts';

export { ROTATION_LEDGER, ROTATION_METRICS, rotationStatus, runRotation } from './rotation.ts';
export type {
  RotationFailure,
  RotationObserver,
  RotationScope,
  RotationOptions,
  RotationReport,
  RotationRow,
  RotationStatus,
  RotationStatusEntry,
  RotationStore,
  RotationTarget,
  RotationTargetProgress,
} from './rotation.ts';

export { createVault, MAX_PLAINTEXT_BYTES, NONCE_BYTES, randomNonce } from './cipher.ts';
export type { Vault, VaultColumn, VaultOptions } from './cipher.ts';

export { createVaultCodec } from './codec.ts';
export type { VaultColumnCodec, VaultColumnRef } from './codec.ts';

export {
  assertTransition,
  canTransition,
  createKeyring,
  KEY_STATES,
  keyringManifest,
} from './keyring.ts';
export type { Keyring, KeyringEntry, KeyringInput, KeyState } from './keyring.ts';

export {
  assertKeyId,
  formatKeySpec,
  generateKey,
  importVaultKey,
  KEY_BYTES,
  keyIdOf,
  parseKeySpec,
} from './keys.ts';
export type { ParsedKey } from './keys.ts';

export {
  associatedData,
  ENVELOPE_PREFIX,
  ENVELOPE_VERSION,
  KEY_ID_PATTERN,
  parseEnvelope,
  serializeEnvelope,
  splitPayload,
  VAULT_ALGS,
  encodeBase64Url,
  decodeBase64Url,
} from './envelope.ts';
export type { Envelope, SplitPayload, VaultAlg } from './envelope.ts';

export type { VaultErrorCode } from './errors.ts';
