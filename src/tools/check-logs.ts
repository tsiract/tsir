/**
 * `make logs` — run the whole suite and fail if any output contains vault key
 * material (`VLT-027`, suite half).
 *
 * The per-package test (`vault/src/logs.test.ts`) proves that *vault's own* error
 * paths do not log secrets. This tool answers the other question: does anything in
 * the repository print a key while the suite runs? It spawns `bun test`, keeps both
 * streams, and scans them.
 *
 * What it can and cannot see, stated plainly:
 *
 *   · **It sees everything the runner prints** — test names, failures, console
 *     output, and stack traces. A `console.log(spec)` anywhere fails here.
 *   · **It does not see output a test captures.** `vault:key:generate` replaces
 *     `process.stdout.write` while it runs, which is the documented exception
 *     (that command exists to print a key once). A test double that swallows a
 *     leak is invisible to this scan; the in-package capture test is what covers
 *     the logged-error paths.
 *   · **Plaintext has no fixed shape**, so this scan looks for the canary the vault
 *     suite uses (`PAN-4000-…`). A plaintext leak elsewhere needs its own canary —
 *     a rule that pretends to catch every string would be a rule that catches none.
 *
 * Usage: bun src/tools/check-logs.ts [--quiet]
 */

import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

/** `id:alg:material` anywhere in a line. The 43 chars are 32 bytes, base64url. */
const KEY_SPEC = /[a-z][a-z0-9]{1,31}:aes-256-gcm:[A-Za-z0-9_-]{43}/;
/**
 * `APP_KEY_*=<spec>` — the same material, named. The `{20,}` matters: a test *title*
 * may legitimately say `APP_KEY_NOW=v1, APP_KEY_NEXT=v2`, and flagging that would
 * make the tool cry wolf until somebody added an exception list.
 */
const ENV_SPEC = /APP_KEY_(?:NOW|NEXT)=[a-z][a-z0-9]{1,31}:(?:aes-256-gcm:)?[A-Za-z0-9_-]{20,}/;
/** The plaintext canary `vault/src/logs.test.ts` uses. */
const CANARY = 'PAN-4000-0000-0000-0002';

interface Finding {
  readonly rule: string;
  readonly line: string;
}

function scan(text: string): readonly Finding[] {
  const findings: Finding[] = [];
  for (const line of text.split('\n')) {
    if (KEY_SPEC.test(line)) findings.push({ rule: 'key material', line });
    else if (ENV_SPEC.test(line)) findings.push({ rule: 'APP_KEY_* value', line });
    else if (line.includes(CANARY)) findings.push({ rule: 'plaintext canary', line });
  }
  return findings;
}

async function main(): Promise<void> {
  const quiet = process.argv.includes('--quiet');
  const run = Bun.spawnSync([process.execPath, 'test'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  });

  const text = `${run.stdout.toString()}\n${run.stderr.toString()}`;
  const findings = scan(text);

  if (!quiet) {
    const lines = text.split('\n').length;
    process.stdout.write(`\n  log capture · ${String(lines)} line(s) of suite output scanned\n`);
  }

  if (run.exitCode !== 0) {
    process.stderr.write(`  ✗ the suite did not pass; run \`bun test\` for the reason\n`);
    process.exit(1);
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(`  ✗ ${finding.rule} in output: ${finding.line.trim().slice(0, 160)}\n`);
    }
    process.exit(1);
  }

  if (!quiet) {
    process.stdout.write(
      '  ✓ no key material, APP_KEY_* value or plaintext canary in any output\n\n',
    );
  }
}

await main();
