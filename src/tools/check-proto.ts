/**
 * Prove the committed gRPC contracts match `proto/` (`LNK-012`).
 *
 * Generated files are committed on purpose — a build must not need `buf`, and a service
 * must not parse a `.proto` at runtime. The cost of committing them is that they can go
 * stale, so this tool regenerates into a temp directory and diffs:
 *
 *   · identical → the committed contract is current;
 *   · different → fail and say which files drifted;
 *   · `buf` not installed → **skip with a note**, because `make check` has to work on a
 *     laptop that has never seen a Go binary. With `REQUIRE_BUF=1` — which the workflow
 *     sets — the skip becomes a failure, so CI cannot pass without actually running this.
 *
 * Usage: bun src/tools/check-proto.ts [--quiet]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const CONTRACTS = join(ROOT, 'src', 'framework', 'link', 'src', 'contracts');
const QUIET = process.argv.includes('--quiet');

function findBuf(): string | undefined {
  const explicit = process.env['BUF'];
  if (explicit !== undefined && existsSync(explicit)) return explicit;

  // `~/.cache/buf` is buf's own module cache, so the binary is kept beside it, not in it.
  for (const candidate of [
    'buf',
    join(ROOT, '.cache', 'bin', 'buf'),
    join(ROOT, 'node_modules', '.bin', 'buf'),
  ]) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path, base));
    else found.push(relative(base, path));
  }
  return found.sort();
}

const buf = findBuf();
if (buf === undefined) {
  // A skip is correct on a laptop that has never seen a Go binary, but it must not be silent in
  // CI: nothing installed `buf` there, so the "contracts are current" claim below was never made
  // by a runner — the check printed this note and passed. `REQUIRE_BUF` turns the skip into a
  // failure, and the workflow sets it, so the guarantee the header promises is actually enforced.
  //
  // Deliberately **not** named `TSIR_REQUIRE_BUF`: every `TSIR_`-prefixed name is a config key, and
  // an unknown one fails in strict-env mode. Using that prefix here broke `tsir start` tests
  // (`APP_MANIFEST_MISSING` began exiting 3 instead of 1) because the stray key made the load look
  // like a configuration error. Tool switches stay outside the reserved namespace.
  if (process.env['REQUIRE_BUF'] === '1') {
    process.stderr.write(
      '\nproto contracts were not checked: `buf` is required here (REQUIRE_BUF=1) and is not installed\n\n' +
        '  Install it: `bun add -d @bufbuild/buf` (the npm distribution ships the binary) or set BUF=<path>.\n\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    '  · proto contracts not checked: `buf` is not installed (CI requires it via REQUIRE_BUF)\n',
  );
  process.exit(0);
}

const lint = spawnSync(buf, ['lint'], { cwd: ROOT, encoding: 'utf8' });
if (lint.status !== 0) {
  process.stderr.write(`\nproto lint failed\n\n${lint.stderr || lint.stdout}\n`);
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), 'tsir-proto-'));

try {
  const template = readFileSync(join(ROOT, 'buf.gen.yaml'), 'utf8').replace(
    /out: .*/u,
    `out: ${scratch}`,
  );
  const templatePath = join(scratch, 'buf.gen.yaml');
  writeFileSync(templatePath, template);

  const generated = spawnSync(buf, ['generate', '--template', templatePath], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (generated.status !== 0) {
    process.stderr.write(`\nproto generation failed\n\n${generated.stderr || generated.stdout}\n`);
    process.exit(1);
  }

  const committed = walk(CONTRACTS);
  const fresh = walk(scratch).filter((path) => path !== 'buf.gen.yaml');
  const problems: string[] = [];

  for (const path of fresh) {
    const expected = readFileSync(join(scratch, path), 'utf8');
    const actualPath = join(CONTRACTS, path);
    if (!existsSync(actualPath)) {
      problems.push(`${path}: generated but not committed`);
      continue;
    }
    if (readFileSync(actualPath, 'utf8') !== expected) {
      problems.push(`${path}: committed contract is out of date`);
    }
  }
  for (const path of committed) {
    if (!fresh.includes(path)) problems.push(`${path}: committed but no longer generated`);
  }

  if (problems.length > 0) {
    process.stderr.write(`\nproto contracts are stale (${String(problems.length)})\n\n`);
    for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`);
    process.stderr.write('\nRun `make proto` and commit the result.\n\n');
    process.exit(1);
  }

  if (!QUIET) {
    process.stdout.write(
      `✓ gRPC contracts are current (${String(fresh.length)} generated file(s), buf lint clean)\n`,
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
