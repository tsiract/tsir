/**
 * GitHub OAuth2 provider.
 *
 * Uses the authorization code flow. Default scope is `read:user user:email`.
 */
import { githubTokenFailed, githubUserFailed } from '../errors.ts';
import type { ProviderConfig, SocializeProvider, SocialUser, TokenResponse } from '../types.ts';

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

export interface GitHubProviderConfig extends ProviderConfig {
  /** Override default scopes. Default: `read:user user:email`. */
  readonly scopes?: readonly string[];
}

const DEFAULT_SCOPES = ['read:user', 'user:email'];

export function githubProvider(config: GitHubProviderConfig): SocializeProvider {
  const scopes = config.scopes ?? DEFAULT_SCOPES;

  return {
    name: 'github',

    getAuthorizationUrl(state: string): string {
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: scopes.join(' '),
        state,
      });
      return `https://github.com/login/oauth/authorize?${params.toString()}`;
    },

    async exchangeCodeForToken(code: string): Promise<TokenResponse> {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
        }),
      });
      if (!res.ok) {
        throw githubTokenFailed(res.status);
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
      const res = await fetch('https://api.github.com/user', {
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          accept: 'application/vnd.github+json',
        },
      });
      if (!res.ok) {
        throw githubUserFailed(res.status);
      }
      const body = (await res.json()) as Record<string, unknown>;

      // GitHub's /user endpoint does not always include email; fetch it separately if needed.
      let email: string | null = typeof body['email'] === 'string' ? body['email'] : null;
      if (email === null) {
        const emailRes = await fetch('https://api.github.com/user/emails', {
          headers: {
            authorization: `Bearer ${token.accessToken}`,
            accept: 'application/vnd.github+json',
          },
        });
        if (emailRes.ok) {
          const emails = (await emailRes.json()) as Array<Record<string, unknown>>;
          const primary = emails.find((e) => e['primary'] === true && e['verified'] === true);
          if (primary !== undefined && typeof primary['email'] === 'string') {
            email = primary['email'];
          }
        }
      }

      return {
        id: asString(body['id']),
        email,
        name: typeof body['name'] === 'string' ? body['name'] : null,
        avatar: typeof body['avatar_url'] === 'string' ? body['avatar_url'] : null,
        provider: 'github',
        raw: body,
      };
    },
  };
}
