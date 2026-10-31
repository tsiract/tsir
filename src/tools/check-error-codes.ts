/**
 * Error codes are a public contract (ERR-002, ERR-004).
 *
 * A `TsirError` code is what a caller branches on, what a log line is searched for, and what a
 * dashboard alert is written against. The message can change; the code cannot. This gate makes
 * three things mechanical:
 *
 *   1. **Every code raised is registered.** `new TsirError('X', …)` and literal `callError(kind, 'X')`
 *      anywhere in shipped framework code must appear in its package's `…ErrorCode` union, so the
 *      type system and this file agree on the list.
 *   2. **Append-only.** A code in the committed baseline (`src/docs/error-codes.json`) may not
 *      disappear or move to another package. Retiring a code is a deprecation, not a deletion.
 *   3. **Every registered code has a docs entry.** `src/docs/errors.md` lists each one. A code
 *      without a row fails CI, so the docs cannot silently fall behind the code.
 *
 * `--write` regenerates the baseline and the docs. It refuses to run if that would remove a code.
 *
 *   bun src/tools/check-error-codes.ts          # check (CI)
 *   bun src/tools/check-error-codes.ts --write  # after adding a code on purpose
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const FRAMEWORK = join(ROOT, 'src/framework');
const BASELINE = join(ROOT, 'src/docs/error-codes.json');
const DOCS = join(ROOT, 'src/docs/errors.md');

const CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u;

/**
 * Codes deliberately declared by more than one package, each with the reason. A shared code is a
 * contract two packages honour the same way (ADR-0027), not an accident. Anything not listed here
 * that appears in two unions is an error.
 */
const SHARED_CODES: Readonly<Record<string, string>> = {
  CAP_DRIVER_MISSING: 'cache and queue: the capability-driver contract (ADR-0027)',
  CAP_FORBIDDEN_IN_PRODUCTION: 'cache and queue: the capability-driver contract (ADR-0027)',
  CAP_UNSUPPORTED_OPERATION: 'cache and queue: the capability-driver contract (ADR-0027)',
};

/** Files whose throws are deliberately not registered: tests and assertion helpers. */
function isExempt(path: string): boolean {
  return (
    path.endsWith('.test.ts') ||
    path.endsWith('.test-support.ts') ||
    path.endsWith('conformance.ts') ||
    path.includes('/fixtures/') ||
    path.includes('/framework/testing/') ||
    path.includes('/type-tests/')
  );
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'contracts') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Registry {
  /** code → package that registers it */
  readonly owner: Map<string, string>;
  readonly problems: string[];
}

/**
 * Codes declared in every `…ErrorCode` union, per package. Scans every shipped source file, not
 * just `errors.ts`: a client-facing catalogue (`http/problems.ts`) is a registry too.
 */
function registry(): Registry {
  const owner = new Map<string, string>();
  const problems: string[] = [];
  // Sorted: ownership of a shared code must not depend on directory order.
  for (const pkg of [...readdirSync(FRAMEWORK)].sort()) {
    const src = join(FRAMEWORK, pkg, 'src');
    if (!existsSync(src)) continue;
    for (const file of tsFiles(src)) {
      if (isExempt(relative(ROOT, file))) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/export type \w+ErrorCode\s*=([^;]+);/gu)) {
        for (const literal of (match[1] ?? '').matchAll(/'([A-Z][A-Z0-9_]*)'/gu)) {
          const code = literal[1] ?? '';
          const previous = owner.get(code);
          if (previous !== undefined && previous !== pkg && SHARED_CODES[code] === undefined) {
            problems.push(`${code} is registered by two packages: ${previous} and ${pkg}`);
          }
          if (previous === undefined) owner.set(code, pkg);
        }
      }
    }
  }
  return { owner, problems };
}

/** Codes raised with `new TsirError('CODE', …)` in shipped code, and where. */
function raised(): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const file of tsFiles(FRAMEWORK)) {
    const rel = relative(ROOT, file);
    if (isExempt(rel)) continue;
    const text = readFileSync(file, 'utf8');
    // `configError(code, …)` is a helper that forwards a code; its literal call sites count too.
    // `callError(kind, 'LNK_…')` builds a value rather than throwing, but its literal code is what a
    // caller branches on, so it is raised in the same sense and must be registered. Protocol codes
    // built from a template (`HTTP_${status}`) carry no literal and are out of scope here.
    // Raise helpers are recognised by name: any `…rror(` call taking the code first (`errorWith`,
    // `appError`, `configError`, `TsirError`), a `super(` call from an error subclass, and `fail(`
    // in the XML parser. A code passed through a variable is not visible here and is covered by
    // the union rule instead.
    const patterns = [
      /(?:\bnew\s+\w*Error|\b\w*[Ee]rror\w*|\bfail|\bsuper)\(\s*'([A-Z][A-Z0-9_]*)'/gu,
      /callError\(\s*[^,()]+,\s*'([A-Z][A-Z0-9_]*)'/gu,
      /fallbackCode\s*=\s*'([A-Z][A-Z0-9_]*)'/gu,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const code = match[1] ?? '';
        if (!CODE.test(code)) continue;
        const list = sites.get(code) ?? [];
        list.push(rel);
        sites.set(code, list);
      }
    }
  }
  return sites;
}

interface Baseline {
  readonly codes: Record<string, string>;
}

function readBaseline(): Baseline {
  if (!existsSync(BASELINE)) return { codes: {} };
  return JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
}

function docsFor(owner: Map<string, string>): string {
  const byPackage = new Map<string, string[]>();
  for (const [code, pkg] of owner) {
    const list = byPackage.get(pkg) ?? [];
    list.push(code);
    byPackage.set(pkg, list);
  }
  const lines = [
    '# Error codes',
    '',
    '<!-- Generated by `bun src/tools/check-error-codes.ts --write`. Do not edit by hand. -->',
    '',
    'Every `TsirError` code a framework package can raise. Codes are stable: a code is never',
    'renamed or reused. A caller may branch on the code; the message is for people and may change.',
    '',
    `${String(owner.size)} codes across ${String(byPackage.size)} packages.`,
    '',
  ];
  for (const pkg of [...byPackage.keys()].sort()) {
    // Column padded to the widest code so the file is already Prettier-formatted (`make format-check`).
    const cells = (byPackage.get(pkg) ?? []).sort().map((code) => `\`${code}\``);
    const width = Math.max('Code'.length, ...cells.map((cell) => cell.length));
    lines.push(
      `## \`@tsir/${pkg}\``,
      '',
      `| ${'Code'.padEnd(width)} |`,
      `| ${'-'.repeat(width)} |`,
    );
    for (const cell of cells) lines.push(`| ${cell.padEnd(width)} |`);
    lines.push('');
  }
  return lines.join('\n');
}

function main(): void {
  const write = process.argv.includes('--write');
  const { owner, problems } = registry();
  const sites = raised();
  const baseline = readBaseline();

  // 1. raised ⇒ registered
  for (const [code, files] of sites) {
    if (!owner.has(code)) {
      problems.push(`${code} is raised in ${files.join(', ')} but is not in any *ErrorCode union`);
    }
  }

  // 2. append-only: nothing in the baseline may vanish or move
  const removed: string[] = [];
  for (const [code, pkg] of Object.entries(baseline.codes)) {
    if (owner.get(code) === undefined) removed.push(code);
    else if (owner.get(code) !== pkg) {
      problems.push(`${code} moved from ${pkg} to ${owner.get(code) ?? '?'} — codes never move`);
    }
  }

  if (write) {
    if (removed.length > 0 || problems.length > 0) {
      process.stderr.write('refusing to write the baseline:\n');
      for (const problem of [...problems, ...removed.map((c) => `${c} was removed`)]) {
        process.stderr.write(`  ✗ ${problem}\n`);
      }
      process.exit(1);
    }
    const codes = Object.fromEntries([...owner].sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE, `${JSON.stringify({ codes }, null, 2)}\n`);
    writeFileSync(DOCS, docsFor(owner));
    process.stdout.write(`✓ error codes written (${String(owner.size)} codes)\n`);
    process.exit(0);
  }

  for (const code of removed) problems.push(`${code} was removed — codes are append-only`);

  // 3. registered ⇒ documented
  const docs = existsSync(DOCS) ? readFileSync(DOCS, 'utf8') : '';
  for (const code of owner.keys()) {
    if (!docs.includes(`\`${code}\``)) {
      problems.push(`${code} has no entry in src/docs/errors.md — run --write`);
    }
  }

  // newly-added codes are fine, but the baseline must record them
  for (const code of owner.keys()) {
    if (baseline.codes[code] === undefined) {
      problems.push(`${code} is new — record it with --write`);
    }
  }

  if (problems.length > 0) {
    process.stderr.write(`error codes are inconsistent (${String(problems.length)}):\n\n`);
    for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`);
    process.stderr.write('\n');
    process.exit(1);
  }
  process.stdout.write(
    `✓ error codes are consistent (${String(owner.size)} registered, ${String(sites.size)} raised, all documented, none removed)\n`,
  );
}

main();
