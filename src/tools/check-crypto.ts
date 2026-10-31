/**
 * `make crypto` — cryptography inventory + prohibited-practices lint (`SEC-005`).
 *
 * Two jobs, because they are the same walk over the same files:
 *
 *   1. **Inventory.** What primitives does the framework actually use, and where? A
 *      security review that starts by reading `grep` output is a review that misses
 *      the one call nobody remembered. The inventory is printed, so "we only use
 *      AES-GCM and HMAC-SHA256" is a claim the build restates on every run.
 *   2. **Prohibitions.** The rules from `14-security.md § 3` are lint here, not
 *      prose: no hand-rolled crypto, no `Math.random` for anything security-shaped,
 *      no MD5/SHA-1, no password-hashing library smuggled in beside the vault.
 *
 * Scope: `src/framework/**\/src/**` excluding tests. Test files may use
 * `Math.random()` for fixtures — that is not a security decision, and pretending
 * otherwise teaches people to disable the check.
 *
 * Escapes: a line annotated `crypto-ok: <reason>` is allowed. There are none today;
 * the annotation exists so that a future deliberate exception is visible in a diff
 * instead of being added to an ignore list.
 *
 * Usage: bun src/tools/check-crypto.ts [--json]
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const FRAMEWORK = join(ROOT, 'src', 'framework');

interface Rule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly why: string;
}

/** Each rule is a mistake somebody has actually made in a framework like this one. */
const RULES: readonly Rule[] = [
  {
    id: 'math-random',
    pattern: /\bMath\.random\s*\(/g,
    why: 'not a CSPRNG — use crypto.getRandomValues (vault), randomNonce(), or systemRandom()',
  },
  {
    id: 'weak-hash',
    pattern: /\bcreateHash\s*\(\s*['"](?:md5|sha1)['"]/gi,
    why: 'MD5 and SHA-1 are collision-broken; the framework uses SHA-256',
  },
  {
    id: 'legacy-cipher',
    pattern: /\bcreate(?:De)?Cipher(?:iv)?\s*\(/g,
    why: 'the legacy node:crypto cipher API has no authentication; use AES-256-GCM via crypto.subtle',
  },
  {
    id: 'password-library',
    pattern: /from\s+['"](?:bcrypt|bcryptjs|argon2|scrypt-js|pbkdf2)['"]/g,
    why: 'password hashing is Bun.password (argon2id) behind one API — a second library is a second policy',
  },
  {
    id: 'token-library',
    pattern: /from\s+['"](?:jsonwebtoken|jose|node-jose|jws|jwt-simple)['"]/g,
    why: 'token formats are the ecosystem’s to standardise, and a dependency needs an ADR (ADR-0012)',
  },
  {
    id: 'custom-crypto',
    pattern: /from\s+['"](?:crypto-js|node-forge|tweetnacl|elliptic|forge)['"]/g,
    why: 'no custom or third-party crypto primitive without an ADR and a security review',
  },
];

/**
 * Primitives the inventory recognises. Order matters only for readability; a
 * primitive not listed here still shows up as `unknown`, which is the point — an
 * inventory that silently ignores new calls is not an inventory.
 */
const PRIMITIVES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'AES-256-GCM', pattern: /name:\s*['"]AES-GCM['"]|AES-GCM/ },
  { name: 'HMAC-SHA256', pattern: /name:\s*['"]HMAC['"]|HMAC/ },
  { name: 'SHA-256', pattern: /hash:\s*['"]SHA-256['"]/ },
  { name: 'RSA', pattern: /\bRSA-[A-Z0-9-]+\b|\bRSASSA\b/ },
  { name: 'ECDSA/ECDH', pattern: /\bECDSA\b|\bECDH\b|\bP-256\b/ },
  { name: 'Ed25519', pattern: /\bEd25519\b/ },
  { name: 'PBKDF2', pattern: /\bPBKDF2\b/ },
  { name: 'HKDF', pattern: /\bHKDF\b/ },
];

interface Violation {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly why: string;
}

async function* sources(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* sources(path);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    // Tests may use Math.random for fixtures; they are not a security surface.
    if (/\.test\.ts$|\.test-support\.ts$|\.integration\.test\.ts$/.test(entry.name)) continue;
    yield path;
  }
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const violations: Violation[] = [];
  const inventory = new Map<string, Set<string>>();
  let scanned = 0;

  for await (const path of sources(FRAMEWORK)) {
    scanned += 1;
    const text = await readFile(path, 'utf8');
    const name = relative(ROOT, path);
    const lines = text.split('\n');

    for (const [index, line] of lines.entries()) {
      if (line.includes('crypto-ok:')) continue;

      for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(line)) {
          violations.push({
            rule: rule.id,
            file: name,
            line: index + 1,
            text: line.trim(),
            why: rule.why,
          });
        }
      }

      for (const primitive of PRIMITIVES) {
        if (!primitive.pattern.test(line)) continue;
        const files = inventory.get(primitive.name) ?? new Set<string>();
        files.add(name);
        inventory.set(primitive.name, files);
      }
    }
  }

  if (json) {
    const data = {
      scanned,
      inventory: Object.fromEntries(
        [...inventory].map(([primitive, files]) => [primitive, [...files].sort()]),
      ),
      violations,
    };
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    process.exit(violations.length === 0 ? 0 : 1);
  }

  process.stdout.write('\n  cryptography inventory\n\n');
  for (const [primitive, files] of [...inventory].sort(([a], [b]) => a.localeCompare(b))) {
    process.stdout.write(
      `  · ${primitive.padEnd(14)} ${String(files.size).padStart(2)} file(s)  ${[...files][0] ?? ''}\n`,
    );
  }
  const unused = PRIMITIVES.filter((primitive) => !inventory.has(primitive.name));
  if (unused.length > 0) {
    process.stdout.write(`  · not used: ${unused.map((entry) => entry.name).join(', ')}\n`);
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(
        `  ✗ ${violation.file}:${String(violation.line)} — ${violation.rule}\n` +
          `    ${violation.text}\n    ↳ ${violation.why}\n`,
      );
    }
    process.stderr.write(`\n  ${String(violations.length)} prohibited practice(s)\n\n`);
    process.exit(1);
  }

  process.stdout.write(
    `\n  ✓ no prohibited crypto practice (${String(scanned)} source files scanned)\n\n`,
  );
}

await main();
