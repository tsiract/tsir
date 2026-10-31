import { describe, expect, test } from 'bun:test';

import {
  assertPasswordAcceptable,
  defaultHasher,
  parseHash,
  PASSWORD_LIMITS,
  pbkdf2Hasher,
  verifyPassword,
} from './password.ts';
import { bunArgon2Hasher } from './adapters/bun-password.ts';

/**
 * The iterations here are the documented production floor, not a test value: the point of the suite
 * is that the shipped parameters work, and PBKDF2 at 210 000 is fast enough to hash a handful of
 * passwords in a test file.
 */
const hasher = defaultHasher();

describe('password hashing', () => {
  test('the documented parameters are the ones used, and the floor is enforced', () => {
    expect(PASSWORD_LIMITS).toEqual({ minLength: 8, maxLength: 1024 });
    // 210 000 is OWASP's current floor for PBKDF2-SHA256; a cheaper hasher cannot be constructed.
    expect(() => pbkdf2Hasher({ iterations: 1_000 })).toThrow(/at least 100000 iterations/u);
    expect(() => pbkdf2Hasher({ iterations: 210_000 })).not.toThrow();
  });

  test('a hash is self-describing, and every parameter a verify needs is in it', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$tsir\$pbkdf2-sha256\$i=210000,l=32\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/u);

    const parsed = parseHash(hash);
    expect(parsed?.algorithm).toBe('pbkdf2-sha256');
    expect(parsed?.iterations).toBe(210_000);
    expect(parsed?.salt.length).toBe(16);
    expect(parsed?.digest.length).toBe(32);
  });

  test('the same password hashes differently every time — the salt is random', async () => {
    const first = await hasher.hash('correct horse battery staple');
    const second = await hasher.hash('correct horse battery staple');
    expect(first).not.toBe(second);
    expect(await hasher.verify('correct horse battery staple', first)).toBe(true);
    expect(await hasher.verify('correct horse battery staple', second)).toBe(true);
  });

  test('a wrong password is false, and a hash from another format is refused', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify('correct horse battery stapl', hash)).toBe(false);
    expect(await hasher.verify('', hash)).toBe(false);
    // Not this package's format: `verify` answers false, `verifyPassword` throws with a code.
    // A hash this build cannot verify is a coded refusal, not a false: silently answering "wrong
    // password" to a row nobody can read is an account nobody can log into.
    expect(hasher.verify('x', '$argon2id$v=19$m=65536,t=2,p=1$abc$def')).rejects.toThrow(
      /no hasher can verify a "argon2id" hash/u,
    );
    expect(verifyPassword('x', 'not-a-hash')).rejects.toThrow(/is not a `\$algorithm\$…` string/u);
    expect(hasher.verify('x', '$tsir$pbkdf2-sha256$i=abc$aaaa$bbbb')).rejects.toThrow(
      /parameters could not be read/u,
    );
  });

  test('a weak password is refused before it is hashed', async () => {
    expect(() => assertPasswordAcceptable('short')).toThrow(/shorter than 8 characters/u);
    expect(() => assertPasswordAcceptable('x'.repeat(1025))).toThrow(/longer than 1024/u);
    expect(() => assertPasswordAcceptable('password123')).toThrow(/breach list/u);
    expect(() => assertPasswordAcceptable('aaaaaaaaaa')).toThrow(/at most two distinct/u);
    expect(() => hasher.hash('short')).toThrow(/shorter than 8/u);
    expect(assertPasswordAcceptable('correct horse battery staple')).toBe(
      'correct horse battery staple',
    );
    // The policy is a parameter, not a constant: a project may demand more.
    expect(() => assertPasswordAcceptable('twelve chars', { minLength: 20 })).toThrow(/shorter/u);
    expect(() => assertPasswordAcceptable('password123', { refuseCommon: false })).not.toThrow();
  });

  test('`needsRehash` is true only when the hash is weaker than this driver', async () => {
    const current = await hasher.hash('correct horse battery staple');
    expect(hasher.needsRehash(current)).toBe(false);

    // A hash made with a weaker cost, as an old deployment would have written it.
    const weaker = pbkdf2Hasher({ iterations: 100_000 });
    const old = await weaker.hash('correct horse battery staple');
    expect(weaker.needsRehash(old)).toBe(false);
    expect(hasher.needsRehash(old)).toBe(true);
    // And it still verifies: raising the cost must not log anybody out.
    expect(await hasher.verify('correct horse battery staple', old)).toBe(true);

    expect(hasher.needsRehash('garbage')).toBe(true);
  });

  test('a malformed hash is refused by the parser rather than guessed at', async () => {
    const weak = pbkdf2Hasher({ iterations: 120_000, saltBytes: 16, keyBytes: 32 });
    const hash = await weak.hash('correct horse battery staple');
    const [, algorithm, params, salt, digest] = hash.split('$');

    expect(parseHash(`${String(params)}$${String(salt)}$${String(digest)}`)).toBeUndefined();
    expect(
      parseHash(`$other$${String(algorithm)}$${String(params)}$${String(salt)}$${String(digest)}`),
    ).toBeUndefined();
    expect(
      parseHash(`$tsir$${String(algorithm)}$i=abc$${String(salt)}$${String(digest)}`),
    ).toBeUndefined();
    expect(
      parseHash(`$tsir$${String(algorithm)}$i=0$${String(salt)}$${String(digest)}`),
    ).toBeUndefined();
    expect(
      parseHash(`$tsir$${String(algorithm)}$${String(params)}$c2hvcnQ$${String(digest)}`),
    ).toBeUndefined();
    expect(
      parseHash(`$tsir$${String(algorithm)}$${String(params)}$${String(salt)}$c2hvcnQ`),
    ).toBeUndefined();
  });

  test('argon2id on Bun verifies its own hashes and names its cost in the string', async () => {
    const argon = bunArgon2Hasher({ memoryCost: 8_192, timeCost: 1 });
    const hash = await argon.hash('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await argon.verify('correct horse battery staple', hash)).toBe(true);
    expect(await argon.verify('wrong password here', hash)).toBe(false);
    expect(argon.needsRehash(hash)).toBe(false);
    // A higher cost than the stored hash makes it a rehash candidate.
    expect(bunArgon2Hasher({ memoryCost: 65_536, timeCost: 3 }).needsRehash(hash)).toBe(true);
    expect(() => argon.verify('x', 'nonsense')).toThrow(/not an argon2id string/u);
  });

  test('an argon2id hash is verified through `verifyPassword`, so a runtime move keeps working', async () => {
    const argon = bunArgon2Hasher({ memoryCost: 8_192, timeCost: 1 });
    const hash = await argon.hash('correct horse battery staple');

    expect(
      await verifyPassword('correct horse battery staple', hash, { extraHashers: [argon] }),
    ).toBe(true);
    expect(await verifyPassword('wrong password here', hash, { extraHashers: [argon] })).toBe(
      false,
    );
    expect(verifyPassword('x', hash)).rejects.toThrow(/no hasher can verify a "argon2id" hash/u);
  });
});
