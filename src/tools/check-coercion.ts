/**
 * Static check for implicit coercion (VLD-007).
 *
 * The rule is a design constraint, not a preference: if `"42"` silently becomes
 * `42`, a client cannot tell a typo from a value, and a validation error stops
 * being actionable. The framework therefore allows coercion only where it is
 * declared — `IntParam`, `PageQuery` and friends use an explicit
 * `.transform()`, which is visible at the declaration site.
 *
 * The patterns below are the ways coercion sneaks in:
 *
 *   · `z.coerce.*` — Zod's own coercion, which accepts `"1e3"`, `" 3"` and `""`;
 *   · `parseInt` / `parseFloat` — prefix parsing, so `"12abc"` becomes `12`;
 *   · `Number(x)` applied to a non-literal — `Number("")` is `0`.
 *
 * A line may opt out with a `coercion-ok` comment, trailing or on one of the two
 * lines immediately above it — a justification long enough to be worth reading
 * rarely fits on one line. Both forms are loud in review. Tests are exempt: they
 * exist to assert that coercion *fails*.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface CoercionViolation {
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
  readonly text: string;
}

const PATTERNS: readonly { readonly name: string; readonly test: (line: string) => boolean }[] = [
  { name: 'z.coerce', test: (line) => /\bz\.coerce\b/.test(line) },
  { name: 'parseInt', test: (line) => /\bparseInt\s*\(/.test(line) },
  { name: 'parseFloat', test: (line) => /\bparseFloat\s*\(/.test(line) },
  {
    name: 'Number()',
    // `Number.MAX_SAFE_INTEGER`, `Number.isSafeInteger` and numeric literals are
    // fine; only a `Number(...)` *call* on a variable coerces silently.
    test: (line) => /\bNumber\s*\((?!\s*[-+]?[\d.'"])/.test(line),
  },
];

const EXEMPT = /coercion-ok/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.cache', 'coverage']);

/** Files the rule applies to: framework and application source, never tests. */
function* sources(root: string, dir: string = root): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      yield* sources(root, path);
      continue;
    }
    if (!path.endsWith('.ts')) continue;
    if (path.endsWith('.test.ts') || path.includes(`${sep}test${sep}`)) continue;
    if (path.includes(`${sep}src${sep}tools${sep}`)) continue; // this tool names the patterns
    yield path;
  }
}

/** Pure: every coercing line in one file's source. */
export function findCoercion(file: string, source: string): readonly CoercionViolation[] {
  const violations: CoercionViolation[] = [];
  const lines = source.split('\n');

  lines.forEach((text, index) => {
    // Comments describe the rule ("no parseInt anywhere"); they do not break it.
    const code = text.replace(/\/\/.*$/, '');
    const context = [lines[index - 1] ?? '', lines[index - 2] ?? '', text].join('\n');
    if (EXEMPT.test(context)) return;
    if (/\*\s|^\s*\*/.test(text)) return; // block-comment body
    for (const pattern of PATTERNS) {
      if (!pattern.test(code)) continue;
      violations.push({ file, line: index + 1, pattern: pattern.name, text: text.trim() });
      break;
    }
  });

  return violations;
}

export function checkCoercion(root: string): readonly CoercionViolation[] {
  const violations: CoercionViolation[] = [];
  for (const file of sources(join(root, 'src'))) {
    violations.push(...findCoercion(relative(root, file), readFileSync(file, 'utf8')));
  }
  return violations;
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const violations = checkCoercion(root);

  if (violations.length === 0) {
    console.log('✓ no implicit coercion (VLD-007)');
  } else {
    for (const violation of violations) {
      console.error(
        `✗ ${violation.file}:${String(violation.line)} — ${violation.pattern}\n    ${violation.text}`,
      );
    }
    console.error(
      `\n${String(violations.length)} coercing call(s). Use an explicit transform, or annotate the line with "coercion-ok".`,
    );
    process.exit(1);
  }
}
