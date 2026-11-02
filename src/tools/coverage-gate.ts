/**
 * Coverage gate (CTN-014 / CFG-010, Gate P1 item 3).
 *
 * `bun test --coverage` prints a table but does not fail on thresholds per
 * package, and a single global floor would hide a well-covered package behind a
 * poorly-covered one. This reads the table, aggregates by package, and fails
 * unless every package in scope clears its own bar.
 *
 *   bun src/tools/coverage-gate.ts [--line 90] [--funcs 85] [paths…]
 */

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    line: { type: 'string', default: '90' },
    funcs: { type: 'string', default: '85' },
  },
});

const lineGate = Number(values.line);

/**
 * Packages held to a lower line bar than `--line`, with the reason written next to the number.
 * Keep this list short; a package that can clear the default should not be here.
 *
 * - `src/framework/console`: most of its command files are exercised through child processes
 *   (`cli.ts`, built servers, deploy fixtures). Bun's coverage cannot see a child process, and
 *   the deploy commands share process-wide registries, so they cannot run in-process together.
 *   Function coverage is still held to the full 85%.
 */
const LINE_OVERRIDES: Readonly<Record<string, number>> = {
  'src/framework/console': 80,
};
const funcGate = Number(values.funcs);
const targets = positionals.length > 0 ? positionals : ['src/framework'];

const result = spawnSync(process.execPath, ['test', '--coverage', ...targets], {
  encoding: 'utf8',
  env: { ...process.env, FORCE_COLOR: '0' },
});

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

// Rows look like: ` packages/core/src/bootstrap.ts | 93.10 | 95.85 | 183-185`
const row = /^\s+(\S+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/;
const inScope = (file: string): boolean =>
  targets.some((target) => {
    const prefix = target.replace(/\/+$/, '');
    return file === prefix || file.startsWith(`${prefix}/`);
  });
const perPackage = new Map<string, { funcs: number[]; lines: number[] }>();

for (const raw of output.split('\n')) {
  const match = row.exec(raw);
  if (match === null) continue;
  const [, file, funcs, lines] = match;
  if (file === undefined || file.startsWith('All files') || !file.includes('/src/')) continue;
  // Only the packages in scope count. Scratch directories that tests create under /tmp also
  // contain `/src/` and would otherwise be graded as packages of their own.
  if (!inScope(file)) continue;
  // Test fixtures are inputs to the tests, not product code. Their app files run in child
  // processes or temp copies, so they show up as untested lines that the tests cannot reach.
  if (file.includes('/fixtures/')) continue;
  const pkg = file.slice(0, file.indexOf('/src/'));
  const entry = perPackage.get(pkg) ?? { funcs: [], lines: [] };
  entry.funcs.push(Number(funcs));
  entry.lines.push(Number(lines));
  perPackage.set(pkg, entry);
}

if (perPackage.size === 0) {
  process.stdout.write(output);
  process.stderr.write('\ncoverage-gate: no coverage rows found — did the test run fail?\n');
  process.exit(1);
}

const average = (numbers: readonly number[]): number =>
  numbers.length === 0 ? 0 : numbers.reduce((sum, value) => sum + value, 0) / numbers.length;

const failures: string[] = [];
const lines: string[] = [];

for (const [pkg, entry] of [...perPackage].sort(([a], [b]) => a.localeCompare(b))) {
  const funcs = average(entry.funcs);
  const covered = average(entry.lines);
  const bar = LINE_OVERRIDES[pkg] ?? lineGate;
  const ok = covered >= bar && funcs >= funcGate;
  lines.push(
    `  ${ok ? '✓' : '✗'} ${pkg.padEnd(24)} lines ${covered.toFixed(2).padStart(6)} % (≥ ${String(bar)})` +
      `   funcs ${funcs.toFixed(2).padStart(6)} %`,
  );
  if (!ok) failures.push(pkg);
}

process.stdout.write(
  `\n coverage gate · line ≥ ${String(lineGate)} % · funcs ≥ ${String(funcGate)} %\n\n`,
);
process.stdout.write(`${lines.join('\n')}\n\n`);

if (result.status !== 0) {
  process.stderr.write('tests failed — see the output above\n');
  process.exit(result.status ?? 1);
}

if (failures.length > 0) {
  process.stderr.write(`below threshold: ${failures.join(', ')}\n`);
  process.exit(1);
}

process.stdout.write('  coverage gate passed\n');
