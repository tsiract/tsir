/**
 * Integration test runner (FND-012).
 *
 * Some tests need a real database, a real network socket, or a real workerd.
 * They must not run by default — `bun test` has to stay fast and hermetic — and
 * they must not *silently* pass when the dependency is missing either, or CI
 * goes green while proving nothing.
 *
 * Contract:
 *   - `DATABASE_URL` set    → run the integration suites, fail if they fail.
 *   - `DATABASE_URL` unset  → print exactly what was skipped and exit 0, unless
 *                             `--require` was passed (CI uses it for the
 *                             Postgres job, where a missing URL is a mistake).
 *
 * Integration suites live next to the code they cover and end in
 * `.integration.test.ts`.
 */

import { Glob } from 'bun';

const PATTERNS = ['src/**/*.integration.test.ts', 'test/**/*.integration.test.ts'];
const require = process.argv.includes('--require');
const hasDatabase = (process.env['DATABASE_URL'] ?? '') !== '';

const files: string[] = [];
for (const pattern of PATTERNS) {
  for await (const file of new Glob(pattern).scan('.')) files.push(file);
}

if (!hasDatabase) {
  process.stdout.write(
    `  · DATABASE_URL is not set — skipping ${String(files.length)} integration suite(s)\n`,
  );
  process.stdout.write(
    files.map((file) => `    ${file}`).join('\n') + (files.length === 0 ? '' : '\n'),
  );
  if (require) {
    process.stderr.write('\n--require was passed but DATABASE_URL is empty\n');
    process.exit(1);
  }
  process.exit(0);
}

if (files.length === 0) {
  process.stdout.write('  · no integration suites found\n');
  process.exit(0);
}

const run = Bun.spawnSync([process.execPath, 'test', '--timeout', '20000', ...files], {
  stdio: ['inherit', 'inherit', 'inherit'],
  env: process.env,
});

process.exit(run.exitCode ?? 1);
