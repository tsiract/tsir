/**
 * One-call socialize bootstrap for apps that use `@tsir/socialize`.
 *
 * Builds a `socialize` instance from the app's provider config and exposes the
 * DI token + value provider the rest of the app wires into its modules.
 */
import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { socialize, type Socialize, type SocializeConfig } from './socialize.ts';
import type { SocializeProvider } from './types.ts';
import { setStateSecret } from './state.ts';

/** Options for `createSocializeBootstrap`. */
export interface SocializeBootstrapOptions {
  /** Map of provider name → provider instance (e.g. `{ google: googleProvider({...}) }`). */
  readonly providers: Record<string, SocializeProvider>;
  /** Shared HMAC secret for CSRF state tokens. Required in multi-worker deployments. */
  readonly stateSecret?: string;
}

/** Everything an app needs to wire its social auth layer. */
export interface SocializeBootstrap {
  /** The socialize instance. */
  readonly socialize: Socialize;
  /** DI token for `socialize`. */
  readonly socializeToken: Token<Socialize>;
  /** Value provider for `socialize`. */
  readonly socializeProvider: Provider<Socialize>;
}

/**
 * Build the socialize layer from provider config.
 *
 * ```ts
 * import { createSocializeBootstrap, googleProvider } from '@tsir/socialize';
 *
 * export const { socialize, socializeToken, socializeProvider } = createSocializeBootstrap({
 *   providers: {
 *     google: googleProvider({ clientId, clientSecret, redirectUri }),
 *   },
 *   stateSecret: env.SOCIALIZE_STATE_SECRET,
 * });
 * ```
 */
export function createSocializeBootstrap(options: SocializeBootstrapOptions): SocializeBootstrap {
  if (options.stateSecret !== undefined) {
    setStateSecret(options.stateSecret);
  }

  const config: SocializeConfig = { providers: options.providers };
  const instance = socialize(config);

  const socializeToken = token<Socialize>('socialize');
  const socializeProvider = valueProvider(socializeToken, instance);

  return { socialize: instance, socializeToken, socializeProvider };
}
