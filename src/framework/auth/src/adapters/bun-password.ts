/**
 * argon2id through `Bun.password` (`@tsir/auth/bun`).
 *
 * The better hash, on the one runtime that ships it natively. It is an **adapter** — a subpath a
 * Bun/Lambda deployment imports and a Worker never sees — for the same reason `@tsir/mail`'s SMTP
 * adapter is one: the barrel has to stay loadable under `target: 'browser'`.
 *
 * The parameters are Bun's defaults, pinned in the name so a change is visible:
 * `memoryCost = 65536 KiB` (64 MiB), `timeCost = 2`. They are written down rather than inherited
 * because an inherited cost is a cost nobody can audit — and because the encoded string carries its
 * own parameters, raising them later does not break a single stored hash.
 *
 * The encoded result is `$argon2id$v=19$m=65536,t=2,p=1$…` — Bun's PHC string, **not** this
 * package's `$tsir$…` format. `parseHash` does not read it, so verification goes through this
 * driver explicitly (`extraHashers`), which is the honest arrangement: one format for hashes this
 * package wrote, one adapter for the native one, and no pretending they are interchangeable.
 */

import type { PasswordHasher, PasswordPolicy } from '../password.ts';
import { assertPasswordAcceptable } from '../password.ts';
import { invalidHash } from '../errors.ts';

export interface BunArgon2Options {
  /** KiB of memory per hash. Default 65 536 (64 MiB). */
  readonly memoryCost?: number | undefined;
  /** Passes. Default 2. */
  readonly timeCost?: number | undefined;
  readonly policy?: PasswordPolicy | undefined;
}

const PREFIX = '$argon2id$';

interface BunCrypto {
  readonly password: {
    hash(
      password: string,
      options?: { algorithm?: 'argon2id'; memoryCost?: number; timeCost?: number },
    ): Promise<string>;
    verify(password: string, hash: string): Promise<boolean>;
  };
}

export function bunArgon2Hasher(options: BunArgon2Options = {}): PasswordHasher {
  const memoryCost = options.memoryCost ?? 65_536;
  const timeCost = options.timeCost ?? 2;
  const policy = options.policy;
  const name = 'argon2id';

  const bun = (globalThis as { Bun?: BunCrypto }).Bun;
  if (bun?.password === undefined) {
    throw new TypeError(
      'the `argon2id` hasher needs `Bun.password` — on a runtime without it, use `defaultHasher` (PBKDF2)',
    );
  }

  return {
    name,

    async hash(password) {
      assertPasswordAcceptable(password, policy);
      return bun.password.hash(password, { algorithm: 'argon2id', memoryCost, timeCost });
    },

    async verify(password, hash) {
      if (!hash.startsWith(PREFIX)) throw invalidHash('it is not an argon2id string');
      return bun.password.verify(password, hash);
    },

    needsRehash(hash) {
      if (!hash.startsWith(PREFIX)) return true;
      const memory = /m=(\d+)/u.exec(hash);
      const time = /t=(\d+)/u.exec(hash);
      if (memory === null || time === null) return true;
      // coercion-ok: the regexes above admit only decimal digits, and these are counts.
      return Number(memory[1]) < memoryCost || Number(time[1]) < timeCost;
    },
  };
}
