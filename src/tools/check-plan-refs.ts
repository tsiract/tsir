/**
 * The `plans/` boundary (DOC-016).
 *
 * `plans/` is the internal source of truth for design and sequencing. It is deliberately
 * **not** part of the product surface: a reader of the README, of a package, or of someone
 * else's application should never be handed a path into a directory they do not have. What
 * crosses the boundary is an id — `HTP-013`, `ADR-0027` — which is stable, greppable and
 * survives the folder being reorganised.
 *
 * This gate is mechanical because the alternative is a review habit, and review habits rot.
 * It fails when the literal string `plans/` appears in a file outside `plans/` itself.
 *
 * Exempt, deliberately:
 *
 *   · `plans/**`           — the directory may cite itself freely;
 *   · `.cache`, `dist`, `coverage`, `node_modules`, … — excluded by name;
 *   · the two tools that police this directory — they have to spell the string to look for
 *     it, and they are the only files allowed to.
 *
 *   bun src/tools/check-plan-refs.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** `src/tools/check-plan-refs.ts` → repository root. */
const ROOT = resolve(import.meta.dir, '..', '..');

const NEEDLE = 'plans/';

/** Directories that are generated, vendored, or the plans themselves. */
const SKIP_DIRS = new Set([
  'plans',
  'node_modules',
  'dist',
  'coverage',
  '.cache',
  '.bun',
  '.tsir',
  '.verify',
  '.arena',
  '.trae',
  '.git',
]);

/** Files with no prose and no paths worth scanning. */
const SKIP_FILES = new Set(['bun.lock', 'bun.lockb']);

const TEXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.md',
  '.html',
  '.css',
  '.yml',
  '.yaml',
  '.json',
  '.sh',
  '.toml',
]);

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function walk(dir: string, found: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), found);
      continue;
    }
    const name = entry.name;
    if (SKIP_FILES.has(name)) continue;
    const dot = name.lastIndexOf('.');
    const ext = dot === -1 ? '' : name.slice(dot);
    if (TEXT.has(ext.toLowerCase()) || name === 'Makefile') found.push(join(dir, name));
  }
}

const files: string[] = [];
walk(ROOT, files);

/**
 * The tools that enforce this rule name the directory in order to find references to it.
 * Keeping the exemption to a literal list is the point: a new exception is a review decision.
 */
const EXEMPT = new Set(
  ['src/tools/check-plan-refs.ts', 'src/tools/check-plans.ts'].map((path) =>
    relative(ROOT, join(ROOT, path)),
  ),
);
const hits: Hit[] = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  if (EXEMPT.has(rel)) continue;
  if (statSync(file).size > 512 * 1024) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.includes(NEEDLE)) continue;
    hits.push({ file: rel, line: index + 1, text: line.trim() });
  }
}

if (hits.length > 0) {
  process.stderr.write(
    `\nplans/ is internal, but ${String(hits.length)} reference(s) leak out:\n\n`,
  );
  for (const hit of hits) {
    process.stderr.write(`  ✗ ${hit.file}:${String(hit.line)} — ${hit.text.slice(0, 120)}\n`);
  }
  process.stderr.write(
    '\n  Cite an id (`HTP-013`, `ADR-0027`) or a real path (`src/docs/…`, `rfc/…`) instead.\n\n',
  );
  process.exit(1);
}

process.stdout.write(
  `✓ plans/ stays internal (${String(files.length)} files scanned outside it)\n`,
);
