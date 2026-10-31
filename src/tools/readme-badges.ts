/**
 * The README badge block, generated from facts in the repository (FND-024).
 *
 * A README badge is a claim. Most projects let it rot: "419 tests passing" stays
 * on the page long after the count moved, and the reader has no way to tell a
 * stale number from a current one. This tool makes the badge block **generated
 * text**, like `src/docs/dependencies.md`:
 *
 *   bun src/tools/readme-badges.ts           # check — fails if README drifted
 *   bun src/tools/readme-badges.ts --write   # regenerate
 *
 * What it measures, and where:
 *
 *   · **tests** — runs `bun test` and reads the summary line, because the only
 *     honest source for "how many tests pass" is the runner.
 *   · **runtime dependencies** — the same scan `check-deps` uses: third-party
 *     deps declared by `src/framework/*`, never workspace ones.
 *   · **Phase** — the root `status.json`, so the badge cannot claim a later phase
 *     than the file the release process edits.
 *
 * Everything else is static (license, runtime, targets) because it is a decision
 * recorded in an ADR, not a measurement.
 *
 * Rendering: [Shields.io](https://shields.io) static badges with
 * [Simple Icons](https://simpleicons.org) logos — both from
 * `awesome-readme-tools`. No dynamic endpoints: a badge that depends on a
 * stranger's server is a broken image the day that server is down.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { RUNTIME_ALLOWLIST } from './dependency-policy.ts';

const ROOT = resolve(import.meta.dir, '..', '..');
const README = join(ROOT, 'README.md');
const FRAMEWORK = join(ROOT, 'src', 'framework');

const START = '<!-- badges:start -->';
const END = '<!-- badges:end -->';

/** One shields.io path segment: percent-encoded, with `-`/`_` doubled as shields requires. */
const encodePart = (part: string): string =>
  encodeURIComponent(part)
    // `encodeURIComponent` leaves parentheses alone, but a parenthesis ends a Markdown
    // link destination — `make links` treated the truncated URL as a file path. Escape
    // them by hand: shields.io renders `%28`/`%29` as parens again.
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('-', '--')
    .replaceAll('_', '__');

const badge = (label: string, value: string, color: string, logo?: string): string => {
  const path = [label, value].map(encodePart).join('-');
  const query = logo === undefined ? '' : `?logo=${logo}&logoColor=white`;
  return `https://img.shields.io/badge/${path}-${color}.svg${query}`;
};

/**
 * Third-party runtime deps declared by the framework packages, split by scope.
 *
 * `root` is what every consumer carries; `scoped` is what only one entrypoint pulls in
 * (ADR-0022 — `@tsir/link/grpc` and friends). Publishing one number for both would tell
 * a REST user they pay for a gRPC runtime they never import.
 */
function runtimeDependencyCounts(): { root: number; scoped: number } {
  const deps = new Set<string>();
  for (const entry of readdirSync(FRAMEWORK, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(FRAMEWORK, entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const [name, range] of Object.entries(parsed.dependencies ?? {})) {
      if (range.startsWith('workspace:') || name.startsWith('@tsir/')) continue;
      deps.add(name);
    }
  }

  let scoped = 0;
  for (const dep of deps) {
    if (RUNTIME_ALLOWLIST[dep]?.scope !== undefined) scoped += 1;
  }
  return { root: deps.size - scoped, scoped };
}

/**
 * `419 pass` from the runner's summary — and `undefined` unless it is green.
 *
 * Reading only the `pass` count was the first version of this function, and it
 * published "418 passing" while a run had one failure: a badge that reports the
 * size of a failing suite is worse than no badge at all.
 */
function passingTests(): number | undefined {
  const result = spawnSync('bun', ['test'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const passed = /^\s*(\d+) pass\s*$/m.exec(output)?.[1];
  const failed = /^\s*(\d+) fail\s*$/m.exec(output)?.[1] ?? '0';
  if (passed === undefined || Number(failed) > 0 || result.status !== 0) return undefined;
  return Number(passed);
}

/** The current phase, read from the root `status.json`. */
function currentPhase(): string {
  const text = readFileSync(join(ROOT, 'status.json'), 'utf8');
  const phase = (JSON.parse(text) as { phase?: number }).phase;
  return typeof phase === 'number' ? `P${String(phase)}` : 'pre-alpha';
}

function render(measured: Measured): string {
  const rows = [
    [
      `[![License: MIT](https://img.shields.io/badge/license-MIT-1f6feb.svg)](./LICENSE)`,
      `[![TypeScript strict](${badge('TypeScript', 'strict', '3178c6', 'typescript')})](https://www.typescriptlang.org/tsconfig#strict)`,
      `[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.2-fbf0df.svg?logo=bun&logoColor=black)](https://bun.sh)`,
    ],
    [
      `[![Tests](${badge('tests', `${String(measured.tests)} passing`, '3fb950')})](./Makefile)`,
      `[![Runtime dependencies](${badge('runtime deps', runtimeBadgeValue(measured.dependencies), '8b949e')})](./src/docs/dependencies.md)`,
      `[![Deploy targets](${badge('deploy', 'Workers + Lambda', 'f0883e', 'cloudflareworkers')})](./src/framework/deploy)`,
    ],
    [
      `[![Tree-shaking: verified](${badge('tree shaking', 'verified', '3fb950', 'esbuild')})](./src/docs/dependencies.md)`,
      `[![Startup focus: zero cost](${badge('startup focus', 'zero cost', 'a371f7')})](#why-tsir)`,
      `[![Status: pre-alpha](${badge('status', `${measured.phase} · pre-alpha`, 'd29922')})](./status.json)`,
    ],
  ];

  return [
    START,
    '',
    '<p align="center">',
    '',
    ...rows.map((row) => `${row.join(' ')}<br/>`),
    '',
    '</p>',
    '',
    END,
  ].join('\n');
}

interface Measured {
  readonly tests: number;
  readonly dependencies: { readonly root: number; readonly scoped: number };
  readonly phase: string;
}

/**
 * `2` when no dependency is subpath-scoped, `2 (+2 adapters)` when some are — the same
 * text `verify()` compares against, so the badge and the check cannot drift.
 */
function runtimeBadgeValue(counts: { readonly root: number; readonly scoped: number }): string {
  return counts.scoped === 0
    ? String(counts.root)
    : `${String(counts.root)} (+${String(counts.scoped)} adapters)`;
}

/**
 * Compares the committed badges with the measurements.
 *
 * Deliberately **not** a byte comparison: prettier reformats markdown, and a gate
 * that fails because a line got rewrapped teaches people to regenerate without
 * reading. What must match is the claim — the numbers and the phase — plus the
 * presence of every badge the header is supposed to carry.
 */
function problemsIn(block: string, measured: Measured): readonly string[] {
  const problems: string[] = [];
  // Compared as encoded badge segments, not as prose: `2 (+2 adapters)` is a claim with
  // more than a number in it, and a `(\d+)` capture silently compared only the `2`.
  const claims: [label: string, expected: string, pattern: RegExp][] = [
    ['tests', encodePart(`${String(measured.tests)} passing`), /tests-(.*?)-[0-9a-f]{6}\.svg/],
    [
      'runtime dependencies',
      encodePart(runtimeBadgeValue(measured.dependencies)),
      /runtime%20deps-(.*?)-[0-9a-f]{6}\.svg/,
    ],
    ['phase', encodePart(`${measured.phase} · pre-alpha`), /status-(.*?)-[0-9a-f]{6}\.svg/],
  ];

  for (const [label, expected, pattern] of claims) {
    const found = pattern.exec(block)?.[1];
    if (found === undefined) problems.push(`  ✗ ${label}: badge missing from the block`);
    else if (found !== expected)
      problems.push(`  ✗ ${label}: README says ${found}, repository says ${expected}`);
  }

  const required = [
    'license-MIT',
    'TypeScript-strict',
    'runtime-Bun',
    'deploy-Workers',
    'tree%20shaking-verified',
    'startup%20focus-zero%20cost',
  ];
  for (const needle of required) {
    if (!block.includes(needle)) problems.push(`  ✗ badge missing: ${needle}`);
  }
  return problems;
}

if (import.meta.main) {
  const measured: Measured = {
    tests: passingTests() ?? -1,
    dependencies: runtimeDependencyCounts(),
    phase: currentPhase(),
  };

  if (measured.tests < 0) {
    process.stderr.write(
      '  ✗ `bun test` is not green — refusing to publish a passing-tests badge\n',
    );
    process.exit(1);
  }

  const current = existsSync(README) ? readFileSync(README, 'utf8') : '';
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start === -1 || end === -1) {
    process.stderr.write(`  ✗ README.md is missing the ${START} … ${END} markers\n`);
    process.exit(1);
  }

  if (process.argv.includes('--write')) {
    writeFileSync(
      README,
      current.slice(0, start) + render(measured) + current.slice(end + END.length),
    );
    process.stdout.write('  ✓ README.md badges regenerated\n');
    process.exit(0);
  }

  const problems = problemsIn(current.slice(start, end + END.length), measured);
  if (problems.length > 0) {
    process.stderr.write(
      `README badge claims do not match the repository:\n${problems.join('\n')}\n\n` +
        'Run `make readme` — the counts are measured, not typed.\n',
    );
    process.exit(1);
  }

  process.stdout.write(
    `✓ README badges match the repository (${String(measured.tests)} tests, ${runtimeBadgeValue(measured.dependencies)} runtime deps, ${measured.phase})\n`,
  );
}
