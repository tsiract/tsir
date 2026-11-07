/**
 * Type-aware lint, one ESLint process per chunk.
 *
 * Type-aware ESLint keeps every project it loads in memory, so a single `eslint .` over all of
 * `src/framework` exhausts a 2 GB machine. Each framework package is linted in its own process, and
 * `src/tools`, `src/apps` and `src/apps/frontpage` get one each. Together they cover the files `eslint .` covered; the
 * ignores in `eslint.config.mjs` still apply. `make lint` and `tsir lint` both run this script, so
 * the two cannot drift (CLI-008).
 *
 *   bun src/tools/lint.ts
 */

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

export function lintChunks(root: string = ROOT): string[] {
  const packages = readdirSync(join(root, 'src/framework'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `src/framework/${entry.name}`)
    .sort();
  return [...packages, 'src/tools', 'src/apps', 'src/apps/frontpage'];
}

function main(): number {
  for (const chunk of lintChunks()) {
    process.stdout.write(`  → eslint ${chunk}\n`);
    const run = Bun.spawnSync([process.execPath, 'x', 'eslint', chunk], {
      cwd: ROOT,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (run.exitCode !== 0) return run.exitCode;
  }
  return 0;
}

if (import.meta.main) process.exit(main());
