import { describe, expect, test } from 'bun:test';
import { generateState, verifyState } from './state.ts';
import { socialize } from './socialize.ts';
import { googleProvider } from './providers/google.ts';
import { githubProvider } from './providers/github.ts';
import type { SocializeProvider, SocialUser } from './types.ts';

describe('state tokens', () => {
  test('generateState produces a verifiable token', async () => {
    const state = await generateState();
    expect(state.length).toBeGreaterThan(20);
    expect(await verifyState(state)).toBe(true);
  });

  test('tampered state fails verification', async () => {
    const state = await generateState();
    const tampered = state.slice(0, -1) + (state.slice(-1) === 'a' ? 'b' : 'a');
    expect(await verifyState(tampered)).toBe(false);
  });

  test('garbage state fails verification', async () => {
    expect(await verifyState('not-a-real-token')).toBe(false);
    expect(await verifyState('')).toBe(false);
  });
});

describe('socialize factory', () => {
  const fakeProvider: SocializeProvider = {
    name: 'fake',
    getAuthorizationUrl: (state) => `https://fake.test/auth?state=${state}`,
    exchangeCodeForToken: async () => ({
      accessToken: 'tok',
      tokenType: 'Bearer',
      expiresIn: 3600,
      refreshToken: null,
      scope: null,
      raw: {},
    }),
    getUserFromToken: async () => ({
      id: '1',
      email: 'a@b.c',
      name: 'A',
      avatar: null,
      provider: 'fake',
      raw: {},
    }),
  };

  test('redirect builds the provider URL', () => {
    const s = socialize({ providers: { fake: fakeProvider } });
    const url = s.redirect('fake', 'state123');
    expect(url).toBe('https://fake.test/auth?state=state123');
  });

  test('callback returns a SocialUser', async () => {
    const s = socialize({ providers: { fake: fakeProvider } });
    const user = await s.callback('fake', 'code');
    expect(user.id).toBe('1');
    expect(user.email).toBe('a@b.c');
    expect(user.provider).toBe('fake');
  });

  test('unknown provider throws', () => {
    const s = socialize({ providers: { fake: fakeProvider } });
    expect(() => s.redirect('nope', 's')).toThrow('socialize: unknown provider "nope"');
  });
});

describe('google provider', () => {
  const provider = googleProvider({
    clientId: 'client-id',
    clientSecret: 'secret',
    redirectUri: 'https://app.test/callback',
  });

  test('authorization URL has correct params', () => {
    const url = provider.getAuthorizationUrl('state123');
    const params = new URL(url).searchParams;
    expect(params.get('client_id')).toBe('client-id');
    expect(params.get('redirect_uri')).toBe('https://app.test/callback');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('state')).toBe('state123');
    expect(params.get('scope')).toContain('openid');
  });

  test('exchangeCodeForToken parses the response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'acc',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'ref',
          scope: 'openid email',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const token = await provider.exchangeCodeForToken('code');
    expect(token.accessToken).toBe('acc');
    expect(token.tokenType).toBe('Bearer');
    expect(token.expiresIn).toBe(3600);
    expect(token.refreshToken).toBe('ref');

    globalThis.fetch = originalFetch;
  });

  test('getUserFromToken maps Google fields', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          sub: '12345',
          email: 'user@gmail.com',
          name: 'Test User',
          picture: 'https://lh3.googleusercontent.com/photo.jpg',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const user: SocialUser = await provider.getUserFromToken({
      accessToken: 'acc',
      tokenType: 'Bearer',
      expiresIn: null,
      refreshToken: null,
      scope: null,
      raw: {},
    });
    expect(user.id).toBe('12345');
    expect(user.email).toBe('user@gmail.com');
    expect(user.name).toBe('Test User');
    expect(user.avatar).toBe('https://lh3.googleusercontent.com/photo.jpg');
    expect(user.provider).toBe('google');

    globalThis.fetch = originalFetch;
  });
});

describe('github provider', () => {
  const provider = githubProvider({
    clientId: 'gh-id',
    clientSecret: 'gh-secret',
    redirectUri: 'https://app.test/callback',
  });

  test('authorization URL has correct params', () => {
    const url = provider.getAuthorizationUrl('state123');
    const params = new URL(url).searchParams;
    expect(params.get('client_id')).toBe('gh-id');
    expect(params.get('redirect_uri')).toBe('https://app.test/callback');
    expect(params.get('state')).toBe('state123');
    expect(params.get('scope')).toContain('read:user');
  });

  test('exchangeCodeForToken parses the response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'gh-tok',
          token_type: 'Bearer',
          scope: 'read:user,user:email',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const token = await provider.exchangeCodeForToken('code');
    expect(token.accessToken).toBe('gh-tok');
    expect(token.tokenType).toBe('Bearer');

    globalThis.fetch = originalFetch;
  });

  test('getUserFromToken maps GitHub fields and fetches email', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            id: 999,
            login: 'testuser',
            name: 'Test',
            avatar_url: 'https://avatars.github.com/u/999',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify([{ email: 'user@github.com', primary: true, verified: true }]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const user = await provider.getUserFromToken({
      accessToken: 'gh-tok',
      tokenType: 'Bearer',
      expiresIn: null,
      refreshToken: null,
      scope: null,
      raw: {},
    });
    expect(user.id).toBe('999');
    expect(user.email).toBe('user@github.com');
    expect(user.name).toBe('Test');
    expect(user.avatar).toBe('https://avatars.github.com/u/999');
    expect(user.provider).toBe('github');

    globalThis.fetch = originalFetch;
  });
});
