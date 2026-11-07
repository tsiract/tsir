/**
 * The socialize factory: a map of provider name → provider.
 *
 * Projects configure their providers once; `redirect()` and `callback()` look
 * them up by name. Unknown providers throw a clear error.
 */
import { unknownProvider } from './errors.ts';
import type { SocializeProvider, SocialUser, TokenResponse } from './types.ts';

/** Configuration for `socialize()`. */
export interface SocializeConfig {
  /** Map of provider name → provider instance. */
  readonly providers: Record<string, SocializeProvider>;
}

/** The socialize instance. */
export interface Socialize {
  /** Build the authorization URL for a provider, including the state param. */
  redirect(provider: string, state: string): string;
  /** Exchange an authorization code for a SocialUser. */
  callback(provider: string, code: string): Promise<SocialUser>;
  /** Exchange code for a token (without fetching the user). */
  token(provider: string, code: string): Promise<TokenResponse>;
}

/** Build a socialize instance from a provider map. */
export function socialize(config: SocializeConfig): Socialize {
  const providers = config.providers;

  function get(name: string): SocializeProvider {
    const provider = providers[name];
    if (provider === undefined) {
      throw unknownProvider(name);
    }
    return provider;
  }

  return {
    redirect(provider, state) {
      return get(provider).getAuthorizationUrl(state);
    },

    async callback(provider, code) {
      const p = get(provider);
      const token = await p.exchangeCodeForToken(code);
      return p.getUserFromToken(token);
    },

    async token(provider, code) {
      return get(provider).exchangeCodeForToken(code);
    },
  };
}
