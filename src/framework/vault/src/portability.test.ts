/**
 * Portability: what a value is bound to (`06-vault.md § 6.1`).
 *
 * The question behind these tests is the one that decides whether a vault is usable
 * in a fleet at all: *is a ciphertext readable by a different process on a different
 * machine, given only the key?* If the answer were no — an OS keychain, a TPM, an
 * instance identity — then every autoscaled deployment and every local reproduction
 * of a production bug would be broken.
 *
 * The strong version of that test is a separate process, because a second `Vault`
 * object in the same process shares a heap with the first one. `bun -e` gets nothing
 * but the key spec and a ciphertext through the environment.
 */

import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createVault } from './cipher.ts';
import { createKeyring } from './keyring.ts';
import { formatKeySpec, generateKey } from './keys.ts';

const COLUMN = { table: 'users', column: 'tax_id' } as const;
const PACKAGE_DIR = join(import.meta.dir, '..');
const KEY = formatKeySpec(generateKey());

describe('a ciphertext travels between processes (VLT-002)', () => {
  test('a second process decrypts a value it never saw being written', async () => {
    const writer = await createVault({ keyring: createKeyring({ now: KEY }) });
    const envelope = await writer.encrypt(COLUMN, '123-45-6789');

    const bun = Bun.which('bun') ?? 'bun';
    const child = Bun.spawn(
      [
        bun,
        '-e',
        `const { createVault, createKeyring } = await import('./src/index.ts');
const vault = await createVault({ keyring: createKeyring({ now: process.env.TSIR_KEY }) });
const plaintext = await vault.decrypt(
  { table: 'users', column: 'tax_id' },
  process.env.TSIR_CIPHERTEXT,
);
process.stdout.write(plaintext);`,
      ],
      {
        cwd: PACKAGE_DIR,
        // The child's entire world: the key, the ciphertext. No files, no state.
        env: { PATH: process.env['PATH'] ?? '', TSIR_KEY: KEY, TSIR_CIPHERTEXT: envelope },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const [output, error] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await child.exited).toBe(0);
    expect(error).toBe('');
    expect(output).toBe('123-45-6789');
  });

  test('a key written on one "server" reads rows written on another', async () => {
    // Two independent keyrings built from the same spec: nothing is shared but the
    // string, which is the whole point of carrying material in the environment.
    const serverA = await createVault({ keyring: createKeyring({ now: KEY }) });
    const serverB = await createVault({ keyring: createKeyring({ now: KEY }) });

    const written = await serverA.encrypt(COLUMN, 'from A');
    expect(await serverB.decrypt(COLUMN, written)).toBe('from A');

    const reversed = await serverB.encrypt(COLUMN, 'from B');
    expect(await serverA.decrypt(COLUMN, reversed)).toBe('from B');
  });

  test('a different key is not a scheme to try: it fails like any other wrong key', async () => {
    const other = await createVault({
      keyring: createKeyring({ now: formatKeySpec(generateKey()) }),
    });
    const envelope = await other.encrypt(COLUMN, 'not for you');

    const mine = await createVault({ keyring: createKeyring({ now: KEY }) });
    const error = await mine.decrypt(COLUMN, envelope).then(
      () => undefined,
      (reason: unknown) => reason as { code?: string },
    );

    expect(error?.code).toBe('VLT_UNKNOWN_KEY');
  });
});

describe('the package stays runtime- and machine-neutral', () => {
  test('no source file imports a Node or Bun builtin', async () => {
    const files = (await readdir(import.meta.dir)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(5);

    for (const name of files) {
      const source = await readFile(join(import.meta.dir, name), 'utf8');
      // `check-boundaries.ts` enforces this for the whole repo; asserting it here means
      // a regression fails in the package's own suite, not only in the CI gate.
      expect(source).not.toMatch(/from '(node|bun):/);
      expect(source).not.toContain("from 'node:");
      expect(source).not.toContain("from 'bun:");
    }
  });

  test('the only platform primitive is the WebCrypto global', async () => {
    const cipher = await readFile(join(import.meta.dir, 'cipher.ts'), 'utf8');
    expect(cipher).toContain('crypto.subtle');
    // No host-specific entropy source, no keyring API, no process identity.
    for (const banned of ['chacha', 'scrypt', 'pbkdf2', 'keychain', 'hostname', 'machine']) {
      expect(cipher.toLowerCase()).not.toContain(banned);
    }
  });
});
