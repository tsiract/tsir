import { describe, expect, test } from 'bun:test';

import {
  base64url,
  constantTimeEqual,
  formatApiKey,
  fromBase64url,
  hashToken,
  parseApiKey,
  randomHex,
  randomToken,
  tokenPrefix,
} from './token.ts';

describe('base64url', () => {
  test('round-trips arbitrary bytes, and is url-safe and unpadded', () => {
    for (const length of [1, 2, 3, 16, 31, 32, 64]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      const encoded = base64url(bytes);
      expect(encoded).not.toMatch(/[+/=]/u);
      expect([...fromBase64url(encoded)]).toEqual([...bytes]);
    }
    expect(base64url(new Uint8Array([]))).toBe('');
    expect([...fromBase64url('')]).toEqual([]);
  });

  test('the classic base64url boundary values decode as expected', () => {
    // 0xfb 0xff encodes as `-_8` in base64url — the two characters that differ from base64.
    expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect([...fromBase64url('-_8')]).toEqual([0xfb, 0xff]);
    // Padding is optional on the way in, which is what makes a hand-pasted token work.
    expect([...fromBase64url('-_8=')]).toEqual([0xfb, 0xff]);
  });
});

describe('tokens', () => {
  test('32 random bytes by default, and never the same twice', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) seen.add(randomToken());
    expect(seen.size).toBe(200);

    const token = randomToken();
    expect(token).toHaveLength(43); // 32 bytes → ceil(32 * 4 / 3) = 43 base64url characters
    expect([...fromBase64url(token)]).toHaveLength(32);
  });

  test('a token asking for less than 16 bytes is refused', () => {
    expect(() => randomToken(8)).toThrow(RangeError);
    expect(() => randomToken(15.5)).toThrow(/at least 16 bytes/u);
    expect(() => randomToken(16)).not.toThrow();
  });

  test('the stored form is a sha256 hex digest, not the token', async () => {
    const token = randomToken();
    const hash = await hashToken(token);

    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hash).not.toContain(token);
    expect(await hashToken(token)).toBe(hash); // deterministic, so it is a usable row key
    expect(await hashToken('another token entirely')).not.toBe(hash);
  });

  test('the well-known sha256 vector matches, so the digest is really SHA-256', async () => {
    expect(await hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('a public identifier is hex, so it cannot be confused with a separator', () => {
    expect(randomHex()).toMatch(/^[0-9a-f]{24}$/u);
    expect(randomHex(4)).toMatch(/^[0-9a-f]{8}$/u);
    expect(new Set(Array.from({ length: 100 }, () => randomHex())).size).toBe(100);
    expect(() => randomHex(3)).toThrow(RangeError);
    expect(() => randomHex(3.5)).toThrow(/at least 4 bytes/u);
  });

  test('the prefix is the public lookup half, and length is the caller’s choice', () => {
    const token = 'abcdefghijklmnop';
    expect(tokenPrefix(token)).toBe('abcdefgh');
    expect(tokenPrefix(token, 4)).toBe('abcd');
    expect(tokenPrefix('short', 40)).toBe('short'); // never pads
  });

  test('constant-time comparison is equality without an early exit', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('', '')).toBe(true);
    // Different lengths short-circuit: length is not a secret.
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    // Same length, one byte apart — the case an early-exit loop leaks.
    expect(constantTimeEqual('abcdef', 'abcdeg')).toBe(false);
    expect(constantTimeEqual('abcdef', 'Abcdef')).toBe(false);
  });
});

describe('API key strings', () => {
  test('the shape is `tsk_<id>_<secret>`, and it parses back exactly', () => {
    const id = 'abcdef012345';
    const secret = 'x'.repeat(43);
    const key = formatApiKey(id, secret);

    expect(key).toBe(`tsk_${id}_${secret}`);
    expect(parseApiKey(key)).toEqual({ id, secret });
  });

  test('a secret containing the separator still parses — base64url has `_` in it', () => {
    const id = 'abcdef012345';
    for (const secret of ['_'.repeat(32), 'a_b_c_d_e_f_g_h_i_j_k_l_m_n_o_p', '-_-_-_-_-_-_-_-_-']) {
      expect(parseApiKey(formatApiKey(id, secret))).toEqual({ id, secret });
    }
    // Every byte value that base64url can encode as `_` survives the round trip.
    const bytes = new Uint8Array(32).fill(0xff); // base64url `____…`
    const encoded = base64url(bytes);
    expect(encoded).toContain('_');
    expect(parseApiKey(formatApiKey(id, encoded))).toEqual({ id, secret: encoded });
  });

  test('anything that is not that shape is refused rather than guessed at', () => {
    const secret = 'y'.repeat(32);
    expect(parseApiKey('')).toBeUndefined();
    expect(parseApiKey(secret)).toBeUndefined();
    expect(parseApiKey(`tsk_${'id'.repeat(6)}`)).toBeUndefined(); // no second separator
    expect(parseApiKey(`tsk_abc_${secret}`)).toBeUndefined(); // id shorter than 6
    expect(parseApiKey(`tsk_${'i'.repeat(6)}_short`)).toBeUndefined(); // secret shorter than 16
    expect(parseApiKey(`key_${'i'.repeat(6)}_${secret}`)).toBeUndefined(); // wrong marker
    expect(parseApiKey(`tsk_${'i'.repeat(6)}_${secret}!`)).toBeUndefined(); // not base64url
    expect(parseApiKey(`tsk_${'i'.repeat(6)}${String.fromCharCode(0)}`)).toBeUndefined();
    expect(parseApiKey(`tsk__${secret}`)).toBeUndefined(); // empty id
  });

  test('a key survives a round trip through the parser at the exact boundary lengths', () => {
    const id = 'i'.repeat(6);
    const secret = 's'.repeat(16);
    expect(parseApiKey(formatApiKey(id, secret))).toEqual({ id, secret });
  });
});
