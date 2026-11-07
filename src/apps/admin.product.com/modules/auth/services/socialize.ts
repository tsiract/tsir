/**
 * Social auth (Socialize) bootstrap for the admin app.
 *
 * Wires Google and GitHub OAuth2 providers via `@tsir/socialize`. The OAuth
 * client credentials come from the app config (`SOCIALIZE_GOOGLE_CLIENT_ID`,
 * etc.). When a provider's credentials are absent, that provider is skipped —
 * the socialize instance simply won't know about it.
 *
 * This is the future-facing wiring: the redirect + callback endpoints that
 * consume this bootstrap are not yet built, but the DI provider is in place so
 * a future `SocialController` can resolve it.
 */
import { token } from '@tsir/container';
import {
  createSocializeBootstrap,
  githubProvider,
  googleProvider,
  type Socialize,
  type SocializeBootstrap,
} from '@tsir/socialize';

export interface SocializeConfig {
  readonly stateSecret: string;
  readonly google?: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
  };
  readonly github?: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
  };
}

export const socializeToken = token<Socialize>('socialize');

/**
 * Build the socialize layer from the app config. Returns the DI token + value
 * provider so the auth module can register them.
 */
export function createSocializeProviders(config: SocializeConfig): SocializeBootstrap {
  const providers: Record<string, ReturnType<typeof googleProvider>> = {};

  if (config.google !== undefined) {
    providers.google = googleProvider({
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      redirectUri: config.google.redirectUri,
    });
  }

  if (config.github !== undefined) {
    providers.github = githubProvider({
      clientId: config.github.clientId,
      clientSecret: config.github.clientSecret,
      redirectUri: config.github.redirectUri,
    });
  }

  const { socialize, socializeProvider } = createSocializeBootstrap({
    providers,
    stateSecret: config.stateSecret,
  });

  return { socialize, socializeToken, socializeProvider };
}
