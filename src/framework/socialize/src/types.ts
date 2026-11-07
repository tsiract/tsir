/**
 * Shared types for socialize providers.
 */

/** The normalized user every provider returns. */
export interface SocialUser {
  /** Provider-specific stable user id. */
  readonly id: string;
  /** Verified email, when the provider returns one. */
  readonly email: string | null;
  /** Display name, when available. */
  readonly name: string | null;
  /** Avatar URL, when available. */
  readonly avatar: string | null;
  /** The provider name (e.g. 'google', 'github'). */
  readonly provider: string;
  /** The raw provider response, for fields the normalized shape omits. */
  readonly raw: Record<string, unknown>;
}

/** The OAuth2 token response. */
export interface TokenResponse {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresIn: number | null;
  readonly refreshToken: string | null;
  readonly scope: string | null;
  readonly raw: Record<string, unknown>;
}

/** What a provider needs from a project. */
export interface ProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/**
 * The contract every OAuth2 provider implements.
 *
 * `getAuthorizationUrl` builds the redirect URL with the state param.
 * `exchangeCodeForToken` POSTs the code to the token endpoint.
 * `getUserFromToken` fetches the user profile with the access token.
 */
export interface SocializeProvider {
  readonly name: string;
  getAuthorizationUrl(state: string): string;
  exchangeCodeForToken(code: string): Promise<TokenResponse>;
  getUserFromToken(token: TokenResponse): Promise<SocialUser>;
}
