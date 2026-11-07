/**
 * Google OAuth2 provider.
 *
 * Uses the authorization code flow. Default scopes are `openid email profile`.
 * No SDK — just `fetch` to Google's well-known endpoints.
 */
import { googleTokenFailed, googleUserinfoFailed } from '../errors.ts';
import type { ProviderConfig, SocializeProvider, SocialUser, TokenResponse } from '../types.ts';

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

export interface GoogleProviderConfig extends ProviderConfig {
  /** Override default scopes. Default: `openid email profile`. */
  readonly scopes?: readonly string[];
}

const DEFAULT_SCOPES = ['openid', 'email', 'profile'];

export function googleProvider(config: GoogleProviderConfig): SocializeProvider {
  const scopes = config.scopes ?? DEFAULT_SCOPES;

  return {
    name: 'google',

    getAuthorizationUrl(state: string): string {
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        state,
        access_type: 'offline',
        prompt: 'consent',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    },

    async exchangeCodeForToken(code: string): Promise<TokenResponse> {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      if (!res.ok) {
        throw googleTokenFailed(res.status);
      }
      const body = (await res.json()) as Record<string, unknown>;
      return {
        accessToken: asString(body['access_token']),
        tokenType: asString(body['token_type']) || 'Bearer',
        expiresIn: typeof body['expires_in'] === 'number' ? body['expires_in'] : null,
        refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : null,
        scope: typeof body['scope'] === 'string' ? body['scope'] : null,
        raw: body,
      };
    },

    async getUserFromToken(token: TokenResponse): Promise<SocialUser> {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { authorization: `Bearer ${token.accessToken}` },
      });
      if (!res.ok) {
        throw googleUserinfoFailed(res.status);
      }
      const body = (await res.json()) as Record<string, unknown>;
      return {
        id: asString(body['sub']),
        email: typeof body['email'] === 'string' ? body['email'] : null,
        name: typeof body['name'] === 'string' ? body['name'] : null,
        avatar: typeof body['picture'] === 'string' ? body['picture'] : null,
        provider: 'google',
        raw: body,
      };
    },
  };
}
