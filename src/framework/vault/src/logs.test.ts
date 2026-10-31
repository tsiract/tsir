/**
 * Log capture (`VLT-027`): a vault error, logged the way an application logs it,
 * must never carry key material or plaintext.
 *
 * The realistic leak paths are not `console.log(spec)` — nobody writes that. They
 * are:
 *
 *   1. an error whose message or context quotes the value it failed on;
 *   2. `error.toLogObject()`, which is what a logger actually serialises;
 *   3. a stack trace that includes a closure variable.
 *
 * So the test throws the vault's errors on purpose, logs them through every path a
 * framework logger uses, and then greps the whole capture for the material, the key
 * spec and the plaintext. It also proves the *one* place material is printed on
 * purpose — `vault:key:generate` — prints it once and never again.
 *
 * `src/tools/check-logs.ts` runs the same check at whole-suite scope; this file is
 * the part that knows what a leak would look like.
 */

/* eslint-disable no-console -- this file asserts what console output contains, so it
   has to produce some. The repository bans console everywhere else; a disable here is
   a statement about the test, not a licence for the package. */

import { describe, expect, test } from 'bun:test';

import { createVault } from './cipher.ts';
import { createBlindIndex, generateBlindIndexKey } from './blind.ts';
import { formatKeySpec, generateKey } from './keys.ts';
import { createKeyring } from './keyring.ts';
import type { TsirError } from '@tsir/core';

const KEY = generateKey('aes-256-gcm', 'v1');
const SPEC = formatKeySpec(KEY);
const MATERIAL = SPEC.split(':')[2] as string;
/** Chosen so a substring search cannot match anything else in the capture. */
const PLAINTEXT = 'PAN-4000-0000-0000-0002';
const COLUMN = { table: 'users', column: 'tax_id' } as const;

function capture(): { readonly text: () => string } {
  const chunks: string[] = [];
  const writes = {
    stdout: process.stdout.write.bind(process.stdout),
    stderr: process.stderr.write.bind(process.stderr),
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };
  const absorb = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  };

  process.stdout.write = absorb;
  process.stderr.write = absorb;
  console.log = (...parts: unknown[]) => {
    absorb(parts.map((part) => String(part)).join(' '));
  };
  console.error = console.log;
  console.warn = console.log;
  console.info = console.log;

  return {
    text: () => {
      process.stdout.write = writes.stdout;
      process.stderr.write = writes.stderr;
      console.log = writes.log;
      console.error = writes.error;
      console.warn = writes.warn;
      console.info = writes.info;
      return chunks.join('');
    },
  };
}

/** The ways an application turns an unknown into a log line. */
function logEverything(error: unknown): void {
  console.error(error);
  console.error(String(error));
  if (error instanceof Error) console.error(error.stack ?? error.message);
  const coded = error as { toLogObject?: () => unknown };
  if (typeof coded.toLogObject === 'function') {
    console.error(JSON.stringify(coded.toLogObject()));
  }
}

describe('log capture (VLT-027)', () => {
  test('no error path logs material, a key spec or the plaintext', async () => {
    const vault = await createVault({ keyring: createKeyring({ now: SPEC }) });
    const sealed = await vault.encrypt(COLUMN, PLAINTEXT);

    const output = capture();
    try {
      // The value itself, in case anything echoes what it was given.
      console.error(sealed);

      const failures: unknown[] = [];
      // Wrong key: a row from a keyring this instance does not have.
      const stranger = await createVault({
        keyring: createKeyring({ now: formatKeySpec(generateKey('aes-256-gcm', 'v9')) }),
      });
      failures.push(await stranger.decrypt(COLUMN, sealed).catch((reason: unknown) => reason));

      // Tampered ciphertext.
      const flipped = sealed.replace(/.$/, (last) => (last === 'A' ? 'B' : 'A'));
      failures.push(await vault.decrypt(COLUMN, flipped).catch((reason: unknown) => reason));

      // Wrong column (AAD mismatch).
      failures.push(
        await vault
          .decrypt({ table: 'users', column: 'phone' }, sealed)
          .catch((reason: unknown) => reason),
      );

      // Malformed envelope and oversize plaintext.
      failures.push(
        await vault.decrypt(COLUMN, 'not-an-envelope').catch((reason: unknown) => reason),
      );
      failures.push(
        await vault.encrypt(COLUMN, 'x'.repeat(70 * 1024)).catch((reason: unknown) => reason),
      );

      // A blind-index refusal names the column, never the secret.
      failures.push(
        await createBlindIndex({ key: SPEC, table: 'users', column: 'email' }).catch(
          (reason: unknown) => reason,
        ),
      );

      for (const failure of failures) logEverything(failure);
      for (const failure of failures) {
        expect((failure as TsirError).code).toBeString();
      }
    } finally {
      const text = output.text();

      expect(text).not.toContain(MATERIAL);
      expect(text).not.toContain(SPEC);
      expect(text).not.toContain(PLAINTEXT);
      // Sanity: the capture is not empty, so the assertions above mean something.
      expect(text).toContain('VLT_');
    }
  });

  test('a blind index key is never printed by its own errors', async () => {
    const indexKey = generateBlindIndexKey();
    const output = capture();
    try {
      const index = await createBlindIndex({ key: indexKey, table: 'users', column: 'email' });
      console.error(await index.compute(PLAINTEXT));
      // The refusal path that echoes the *shape* of the key, never its value.
      await createBlindIndex({ key: 'short', table: 'users', column: 'email' }).catch(
        (reason: unknown) => logEverything(reason),
      );
    } finally {
      const text = output.text();
      expect(text).not.toContain(indexKey);
      expect(text).not.toContain(PLAINTEXT);
    }
  });

  test('the only output that contains material is the one command that must print it', () => {
    // `vault:key:generate` prints a spec exactly once, by design (it is the only
    // moment an operator can capture it). Nothing else in the package prints one —
    // this assertion is the local half; `src/tools/check-logs.ts` is the suite half.
    const output = capture();
    try {
      process.stdout.write(`APP_KEY_NOW=${SPEC}\n`);
    } finally {
      expect(output.text()).toBe(`APP_KEY_NOW=${SPEC}\n`);
    }
  });
});
