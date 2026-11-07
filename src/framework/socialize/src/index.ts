/**
 * @tsir/socialize — social OAuth authentication.
 *
 * A thin, dependency-free OAuth2 client that integrates with `@tsir/auth`
 * sessions. Providers implement the `SocializeProvider` interface; the
 * `socialize()` factory builds a provider map and exposes `redirect()` and
 * `callback()`.
 *
 * ```ts
 * import { socialize, googleProvider } from '@tsir/socialize';
 * import { googleProvider } from '@tsir/socialize/google';
 *
 * const s = socialize({
 *   providers: {
 *     google: googleProvider({ clientId, clientSecret, redirectUri }),
 *   },
 * });
 *
 * const url = s.redirect('google', await generateState());
 * const user = await s.callback('google', code);
 * // user: { id, email, name, avatar, provider, raw }
 * ```
 *
 * Three rules:
 *   · **No vendor SDK.** Only `fetch` and `crypto`. Providers are ~40 lines.
 *   · **CSRF state is mandatory.** `redirect()` takes a state; `callback()` does
 *     not verify it (the caller does, so state can live in a cookie or session).
 *   · **Uniform user shape.** Every provider returns `SocialUser`; provider-
 *     specific fields are in `raw` so callers don't branch on the provider.
 */

export { socialize } from './socialize.ts';
export type { Socialize, SocializeConfig } from './socialize.ts';

export type { SocialUser, SocializeProvider, ProviderConfig, TokenResponse } from './types.ts';

export { generateState, verifyState, type StateStore } from './state.ts';

export { googleProvider } from './providers/google.ts';
export type { GoogleProviderConfig } from './providers/google.ts';

export { githubProvider } from './providers/github.ts';
export type { GitHubProviderConfig } from './providers/github.ts';

export {
  createSocializeBootstrap,
  type SocializeBootstrap,
  type SocializeBootstrapOptions,
} from './bootstrap.ts';
