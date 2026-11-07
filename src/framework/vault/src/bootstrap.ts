/**
 * One-call vault bootstrap for apps that use `@tsir/vault`.
 *
 * Replaces the hand-written `modules/system/services/vault.ts` every app
 * previously needed: it builds the keyring and vault from `config/vault.ts`,
 * exposes the `vault` promise, and creates the DI token + value provider
 * the rest of the app wires into its modules.
 *
 * When the config's `now` field is empty (the dev/test default), a local key
 * is generated on import so the app boots without a secret. **This means
 * encrypted data does not survive a restart in dev** — set `now` to a real
 * key spec (`<id>:<alg>:<base64url-material>`) in production.
 */

import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { createVault, type Vault } from './cipher.ts';
import { createKeyring } from './keyring.ts';
import { formatKeySpec, generateKey } from './keys.ts';
import { localKeyProvider } from './provider.ts';

/** The shape of `config/vault.ts`. */
export interface VaultConfig {
  /** The active key spec, or empty to generate a local dev key. */
  readonly now?: string | undefined;
  /** Decrypt-only key specs for rotation. */
  readonly previous?: readonly string[] | undefined;
}

/** Options for `createVaultBootstrap`. */
export interface VaultBootstrapOptions {
  /** The app's vault configuration from `config/vault.ts`. */
  readonly config: VaultConfig;
}

/** Everything an app needs to wire its vault layer. */
export interface VaultBootstrap {
  /** The vault, resolved asynchronously (key import is async). */
  readonly vault: Promise<Vault>;
  /** DI token for `vault`. */
  readonly vaultToken: Token<Promise<Vault>>;
  /** Value provider for `vault`. */
  readonly vaultProvider: Provider<Promise<Vault>>;
}

/**
 * Build the vault layer from `config/vault.ts`.
 *
 * ```ts
 * import { createVaultBootstrap } from '@tsir/vault';
 * import config from '../../config/vault.ts';
 *
 * export const { vault, vaultToken, vaultProvider } = createVaultBootstrap({
 *   config,
 * });
 * ```
 */
export function createVaultBootstrap(options: VaultBootstrapOptions): VaultBootstrap {
  // Dev/test fallback: generate a key when none is configured.
  const now =
    options.config.now !== undefined && options.config.now.trim() !== ''
      ? options.config.now
      : formatKeySpec(generateKey());

  const keyring = createKeyring({ now });

  const vault = createVault({
    keyring,
    provider: localKeyProvider({ materials: keyring.keys }),
  });

  const vaultToken = token<Promise<Vault>>('vault');
  const vaultProvider = valueProvider(vaultToken, vault);

  return { vault, vaultToken, vaultProvider };
}
