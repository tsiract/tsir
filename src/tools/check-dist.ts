/**
 * `make dist-check` — assert the core/distribution boundary (DOC-018).
 *
 * `make dist` produces the product; this proves the product contains only what a
 * developer needs and nothing that belongs to the engineering workspace. It is the
 * executable form of `plans/architecture/18-core-vs-distribution.md`:
 *
 *   1. **The launcher exists** and is executable — `tsir` and `bin/tsir`.
 *   2. **The package surface is present** — every `src/framework/*` package has an
 *      emitted directory with a distributable manifest (no `private`, no `workspace:*`).
 *   3. **No engineering workspace leaks** — no repository tooling, tests, plans, CI
 *      config, benchmarks or fixtures under the distribution root.
 *   4. **No absolute paths** — nothing in a distributed manifest may name a directory
 *      on the machine that built it (that is how the old scaffold broke: it recorded
 *      `/abs/path/to/dist/framework/*` as a workspace).
 *   5. **Templates and docs travel** — `tsir new` needs the stubs, and developers need
 *      the docs; both are checked by identity against the source.
 *
 * Exit codes follow the CLI convention: 0 clean, 1 violations found.
 *
 * Usage: bun src/tools/check-dist.ts [--dist dist]
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');

function argValue(argv: readonly string[], flag: string, fallback: string): string {
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  return value ?? fallback;
}

export interface BoundaryProblem {
  readonly rule: string;
  readonly detail: string;
}

/** Everything under `dir`, relative to it, for the recursive scans below. */
function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path, base));
    else found.push(relative(base, path));
  }
  return found;
}

/**
 * Paths that must never appear in a distribution.
 *
 * Each one is a thing the *engineering* workspace needs and an application does not. The list is
 * by path segment, so it catches `apps/x/e2e/` as well as a top-level `tests/`.
 */
const FORBIDDEN_SEGMENTS = [
  'plans', // internal design ledger (check-plan-refs keeps it out of src/ too)
  '.github', // CI configuration
  'bench', // framework benchmarks
  '.changeset', // release bookkeeping
  'rfc',
  'fixtures', // test fixtures of every kind
  'type-tests',
  'coverage',
  '.verify',
  '.tsir',
];

/** File-name shapes that are engineering-only regardless of where they live. */
const FORBIDDEN_FILES: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /^tsconfig\.dist\.json$/u, why: 'the distribution compile config is a build input' },
  { pattern: /^\.eslintrc/u, why: 'lint configuration is repository tooling' },
  { pattern: /^playwright\.config\.ts$/u, why: 'browser suites are not shipped' },
  { pattern: /^commitlint\.config\.mjs$/u, why: 'commit policy is repository tooling' },
  { pattern: /^buf\.(yaml|gen\.yaml)$/u, why: 'proto generation is framework-internal' },
];

/** Rule 1–5, as a pure check of a distribution directory. */
export function boundaryProblems(dist: string): BoundaryProblem[] {
  const problems: BoundaryProblem[] = [];
  if (!existsSync(dist)) {
    return [{ rule: 'exists', detail: `${dist} does not exist — run \`make dist\` first` }];
  }

  // ── 1. launcher
  for (const launcher of ['tsir', join('bin', 'tsir')]) {
    const path = join(dist, launcher);
    if (!existsSync(path)) {
      problems.push({ rule: 'launcher', detail: `${launcher} is missing` });
      continue;
    }
    const mode = statSync(path).mode;
    if ((mode & 0o111) === 0) problems.push({ rule: 'launcher', detail: `${launcher} is not executable` });
  }

  // ── 2. package surface
  const framework = join(dist, 'framework');
  if (!existsSync(framework)) {
    problems.push({ rule: 'packages', detail: 'framework/ is missing' });
  } else {
    const sourcePackages = readdirSync(join(ROOT, 'src', 'framework'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of sourcePackages) {
      const manifestPath = join(framework, name, 'package.json');
      if (!existsSync(manifestPath)) {
        problems.push({ rule: 'packages', detail: `framework/${name}/package.json is missing` });
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        private?: boolean;
        dependencies?: Record<string, string>;
        version?: string;
      };
      if (manifest.private === true) {
        problems.push({ rule: 'packages', detail: `framework/${name} is marked private` });
      }
      for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
        if (range.startsWith('workspace:')) {
          problems.push({
            rule: 'packages',
            detail: `framework/${name} depends on ${dep}@${range} — a workspace range cannot resolve outside the repository`,
          });
        }
      }
    }
  }

  // ── 3. no engineering workspace
  const files = walk(dist).filter((path) => !path.split(/[\\/]/u).includes('node_modules'));
  for (const path of files) {
    for (const segment of FORBIDDEN_SEGMENTS) {
      if (path.split(/[\\/]/u).includes(segment)) {
        problems.push({ rule: 'no-internal-assets', detail: `${path} (${segment} belongs to engineering)` });
        break;
      }
    }
    const base = path.split(/[\\/]/u).pop() ?? '';
    for (const { pattern, why } of FORBIDDEN_FILES) {
      if (pattern.test(base)) problems.push({ rule: 'no-internal-assets', detail: `${path} — ${why}` });
    }
    // A test file that ships is a test file somebody will run from the product.
    if (/\.test\.ts$/u.test(path) && !path.startsWith('apps/')) {
      problems.push({ rule: 'no-internal-assets', detail: `${path} — framework tests do not ship` });
    }
  }

  // ── 4. no absolute paths in any shipped manifest
  for (const path of files.filter((file) => file.endsWith('package.json'))) {
    const text = readFileSync(join(dist, path), 'utf8');
    if (text.includes(ROOT)) {
      problems.push({
        rule: 'no-absolute-paths',
        detail: `${path} names the build machine's directory (${ROOT})`,
      });
    }
  }

  // ── 5. templates and docs travel with the product
  for (const required of ['framework/console/stubs', 'src/docs']) {
    if (!existsSync(join(dist, required))) {
      problems.push({ rule: 'developer-assets', detail: `${required} is missing — \`tsir new\` needs it` });
    }
  }

  return problems;
}

if (import.meta.main) {
  const dist = resolve(argValue(Bun.argv.slice(2), '--dist', join(ROOT, 'dist')));
  const problems = boundaryProblems(dist);
  if (problems.length > 0) {
    process.stderr.write(`\ndistribution boundary violations (${String(problems.length)})\n\n`);
    for (const problem of problems.slice(0, 40)) {
      process.stderr.write(`  ✗ [${problem.rule}] ${problem.detail}\n`);
    }
    if (problems.length > 40) {
      process.stderr.write(`  … ${String(problems.length - 40)} more\n`);
    }
    process.stderr.write('\nSee plans/architecture/18-core-vs-distribution.md.\n\n');
    process.exit(1);
  }
  process.stdout.write('✓ distribution boundary holds (launcher, packages, no internal assets)\n');
}
