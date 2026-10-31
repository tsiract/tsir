/**
 * License consistency (DOC-017 / FND-003).
 *
 * A workspace with twelve manifests drifts: someone copies a package skeleton,
 * leaves `"license"` off, and the next `npm publish` ships a package with no
 * declared license. That is a legal defect, not a formatting one, so it is
 * checked mechanically rather than remembered.
 *
 * Checks:
 *   1. `LICENSE` exists and is the MIT text (identified by its first line).
 *   2. Root and every workspace manifest declare the same SPDX identifier.
 *   3. No source file carries a conflicting `SPDX-License-Identifier` header.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED = 'MIT';
const problems: string[] = [];

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error: unknown) {
    problems.push(`${path}: unreadable JSON (${String(error)})`);
    return {};
  }
}

// ── 1. the license text itself ─────────────────────────────────────────────
if (!existsSync('LICENSE')) {
  problems.push('LICENSE is missing');
} else {
  const text = readFileSync('LICENSE', 'utf8');
  if (!text.startsWith('MIT License')) problems.push('LICENSE does not begin with "MIT License"');
  if (!text.includes('THE SOFTWARE IS PROVIDED "AS IS"')) {
    problems.push('LICENSE is missing the MIT warranty disclaimer');
  }
  if (!/Copyright \(c\) \d{4} \S/.test(text)) {
    problems.push('LICENSE has no "Copyright (c) YYYY Holder" line');
  }
}

// ── 2. every manifest agrees ───────────────────────────────────────────────
// Root, plus the single packages that live directly under src/apps.
const manifests = ['package.json', 'src/apps/frontpage/package.json'];
/** Directories whose children are all workspaces; every child needs a manifest. */
const WORKSPACE_DIRS = ['src/framework', 'src/apps/examples'] as const;

for (const dir of WORKSPACE_DIRS) {
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(dir, entry.name, 'package.json');
    if (existsSync(candidate)) manifests.push(candidate);
    else problems.push(`${dir}/${entry.name}: directory without a package.json`);
  }
}

for (const manifest of manifests) {
  const data = readJson(manifest);
  const license = data['license'];
  if (license !== EXPECTED) {
    problems.push(
      `${manifest}: license is ${JSON.stringify(license ?? null)}, expected "${EXPECTED}"`,
    );
  }
}

// ── 3. no stray SPDX headers ───────────────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.tsir'].includes(entry.name)) continue;
      walk(path, out);
    } else if (/\.(ts|js|mjs|sh)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const SPDX = /SPDX-License-Identifier:\s*([^\s*]+)/;
for (const dir of ['src/framework', 'src/apps', 'src/tools']) {
  for (const file of walk(dir)) {
    const header = SPDX.exec(readFileSync(file, 'utf8').slice(0, 600));
    if (header?.[1] !== undefined && header[1] !== EXPECTED) {
      problems.push(`${file}: SPDX header says ${header[1]}, expected ${EXPECTED}`);
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`\nlicense check failed (${String(problems.length)})\n\n`);
  for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write(
  `✓ licensing consistent (${EXPECTED}; ${String(manifests.length)} manifests)\n`,
);
