/**
 * Third-party dependency policy (ADR-0012).
 *
 * The rule the user set: **no dependency that cannot be tree-shaken**, and the
 * ones we do use should be the established, widely-adopted libraries in their
 * domain (Zod for validation, Drizzle for SQL) — built *on top of*, never
 * re-implemented.
 *
 * "Supports tree shaking" is checked mechanically, not by reputation:
 *
 *   1. Every runtime dependency must be on the allowlist below, which records
 *      *why* it was chosen and which phase introduced it. A new dependency that
 *      nobody vetted fails the build.
 *   2. The installed artifact must ship native ESM (`exports.import` or
 *      `module`). A CJS-only package cannot be tree-shaken by any consumer
 *      bundler, so it is rejected outright.
 *   3. It must declare its purity for the bundler: `sideEffects: false`, or an
 *      explicit array of the few files that do have side effects.
 *   4. One version per dependency across the workspace — two copies of a
 *      validator is two sets of schema identities.
 *
 * Build-time-only dependencies (TypeScript, ESLint, Prettier) are exempt: they
 * never reach a consumer's bundle. They are still listed for the record.
 *
 * Usage: bun src/tools/check-deps.ts
 */

import { readdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DEV_ONLY, RUNTIME_ALLOWLIST } from './dependency-policy.ts';
import { importClosure } from './import-graph.ts';

const ROOT = resolve(import.meta.dir, '..', '..');
const FRAMEWORK = join(ROOT, 'src', 'framework');

interface Packument {
  readonly name?: string;
  readonly version?: string;
  readonly type?: string;
  readonly sideEffects?: boolean | readonly string[];
  readonly module?: string;
  readonly exports?: unknown;
}

const problems: string[] = [];
const notes: string[] = [];

function hasEsmEntry(manifest: Packument): boolean {
  if (manifest.type === 'module') return true;
  if (typeof manifest.module === 'string') return true;
  const exportsField = manifest.exports;
  if (typeof exportsField === 'object' && exportsField !== null) {
    const root: unknown = (exportsField as Record<string, unknown>)['.'];
    if (typeof root === 'object' && root !== null && 'import' in root) return true;
    if (typeof root === 'string' && /\.[cm]?js$/.test(root)) return true;
    if ('import' in (exportsField as Record<string, unknown>)) return true;
  }
  return false;
}

function purityVerdict(manifest: Packument): string | undefined {
  const sideEffects = manifest.sideEffects;
  if (sideEffects === false) return 'sideEffects: false';
  if (Array.isArray(sideEffects)) {
    return sideEffects.length === 0
      ? 'sideEffects: []'
      : `sideEffects: [${sideEffects.join(', ')}]`;
  }
  return undefined;
}

// Sorted, because this list drives `importers` — which is rendered into
// `src/docs/dependencies.md`. Directory order is filesystem-dependent (ext4 returns hash
// order, APFS returns creation order), so an unsorted list made the generated table differ
// between Linux and macOS and turned a docs file into a platform-specific artifact.
const packages = (await readdir(FRAMEWORK, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * Where a third-party package actually landed.
 *
 * Bun hoists to the workspace root *unless* a workspace already pinned that
 * dependency to a different version, in which case it installs under the
 * package. Looking only at the root would report an installed dependency as
 * missing and silently skip every check on it.
 */
function installedManifest(dep: string): string | undefined {
  const candidates = [
    join(ROOT, 'node_modules', dep, 'package.json'),
    ...packages.map((name) => join(FRAMEWORK, name, 'node_modules', dep, 'package.json')),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** dep name → versions seen, and which packages require it. */
const runtimeUses = new Map<string, { versions: Set<string>; importers: string[] }>();

for (const name of packages) {
  const path = join(FRAMEWORK, name, 'package.json');
  if (!existsSync(path)) continue;
  const manifest = JSON.parse(await Bun.file(path).text()) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (range.startsWith('workspace:')) continue;
    const entry = runtimeUses.get(dep) ?? { versions: new Set<string>(), importers: [] };
    entry.versions.add(range);
    entry.importers.push(manifest.name ?? name);
    runtimeUses.set(dep, entry);
  }

  for (const dep of Object.keys(manifest.devDependencies ?? {})) {
    if (DEV_ONLY[dep] === undefined && !dep.startsWith('@tsir/')) {
      problems.push(
        `${manifest.name ?? name}: dev dependency "${dep}" is not classified in ADR-0012 (add it to DEV_ONLY with a reason)`,
      );
    }
  }
}

for (const [dep, use] of [...runtimeUses].sort(([a], [b]) => a.localeCompare(b))) {
  const policy = RUNTIME_ALLOWLIST[dep];
  if (policy === undefined) {
    problems.push(
      `runtime dependency "${dep}" (used by ${use.importers.join(', ')}) is not on the allowlist — ` +
        'write an ADR entry first, then add it to src/tools/check-deps.ts',
    );
    continue;
  }

  if (use.versions.size > 1) {
    problems.push(`"${dep}" is required at conflicting ranges: ${[...use.versions].join(', ')}`);
  }

  const installed = installedManifest(dep);
  if (installed === undefined) {
    notes.push(`${dep}: not installed yet (planned for ${policy.phase})`);
    continue;
  }

  const manifest = JSON.parse(await Bun.file(installed).text()) as Packument;

  const nodeOnly = policy.nodeOnly;
  if (nodeOnly !== undefined && policy.scope === undefined) {
    problems.push(
      `"${dep}": nodeOnly requires an explicit scope — an exception without a scope is a root dependency`,
    );
  }

  if (!hasEsmEntry(manifest)) {
    if (nodeOnly === undefined) {
      problems.push(
        `"${dep}": no native ESM entry — a CommonJS-only dependency cannot be tree-shaken. ` +
          'Reject it or find an ESM alternative, or declare `nodeOnly` if it is a Node adapter (ADR-0022).',
      );
    } else {
      notes.push(`${dep}: CommonJS accepted — ${nodeOnly.why}`);
    }
  }

  const purity = purityVerdict(manifest);
  if (purity === undefined) {
    if (nodeOnly !== undefined) {
      notes.push(`${dep}: no sideEffects declaration, accepted for a Node-only adapter`);
    } else {
      problems.push(
        `"${dep}": does not declare "sideEffects" — a bundler must assume every module has side ` +
          'effects, so nothing can be dropped. Ask upstream to declare it, or avoid the dependency.',
      );
    }
  } else {
    const local = installed.startsWith(join(ROOT, 'node_modules')) ? '' : ' (package-local)';
    notes.push(
      `${dep}@${manifest.version ?? '?'}${local} · ${purity} · ${use.importers.join(', ')}`,
    );
  }
}

/**
 * Subpath scoping (ADR-0022).
 *
 * A dependency declared with a `scope` may only be reached through those entrypoints.
 * The proof is the package's own import graph: start at `exports['.']`, follow relative
 * imports, and fail if the dependency shows up. This is what lets `@tsir/link/grpc`
 * carry `@grpc/grpc-js` without every REST user paying for it.
 */
interface PackageInfo {
  readonly name: string;
  readonly dir: string;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly dependencies: readonly string[];
}

function entryFile(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return entryFile(record['types']) ?? entryFile(record['default']);
}

const packageInfos: PackageInfo[] = [];
for (const name of packages) {
  const path = join(FRAMEWORK, name, 'package.json');
  if (!existsSync(path)) continue;
  const manifest = JSON.parse(await Bun.file(path).text()) as {
    name?: string;
    exports?: Record<string, unknown>;
  };
  packageInfos.push({
    name: manifest.name ?? name,
    dir: join(FRAMEWORK, name),
    exports: manifest.exports ?? {},
    dependencies: Object.keys(
      (manifest as { dependencies?: Record<string, string> }).dependencies ?? {},
    ).filter((dep) => !dep.startsWith('@tsir/')),
  });
}

let scopedCount = 0;
for (const [dep, policy] of Object.entries(RUNTIME_ALLOWLIST)) {
  if (policy.scope === undefined) continue;
  if (!runtimeUses.has(dep)) {
    notes.push(`${dep}: scoped to ${policy.scope.join(', ')} but not declared by any package yet`);
    continue;
  }
  scopedCount += 1;

  for (const info of packageInfos) {
    // Only the package that actually declares the dependency owns the claim; every other
    // package in the workspace has nothing to prove here.
    if (!info.dependencies.includes(dep)) continue;

    const entry = entryFile(info.exports['.']);
    if (entry === undefined) continue;

    for (const subpath of policy.scope) {
      const sub = subpath.startsWith(`${info.name}/`) ? subpath.slice(info.name.length + 1) : '';
      if (sub === '' || info.exports[`./${sub}`] === undefined) {
        problems.push(
          `${dep}: scoped to "${subpath}", but ${info.name} does not export "./${sub}" — the scope names an entrypoint that does not exist`,
        );
      }
    }

    const rootEntry = resolve(info.dir, entry);
    const closure = importClosure([rootEntry]);
    for (const missing of closure.unresolved) {
      problems.push(
        `${dep}: import graph is incomplete at ${missing} — a dangling file cannot prove a negative`,
      );
    }

    const importers = closure.packages.get(dep);
    if (importers !== undefined && importers.length > 0) {
      problems.push(
        `${dep}: declared as ${policy.scope.join(', ')} only, but ${importers[0]} is reachable from ${info.name}'s root entrypoint (ADR-0022)`,
      );
    }
  }
}

for (const note of notes) process.stdout.write(`  · ${note}\n`);

/** FND-017: the allowlist is documentation too, so it is generated, never typed. */
const docLines: string[] = [];
docLines.push(
  '# Runtime dependencies',
  '',
  '> Generated by `make deps-doc` from the same allowlist `make deps` enforces.',
  '> Do not edit by hand; the check fails if this file and the allowlist disagree.',
  '',
  'A runtime dependency is one an application ships. Each one has to earn its',
  'bytes: ESM, tree-shakeable, `sideEffects` declared, and an ADR that says why',
  'it is worth carrying (ADR-0012).',
  '',
  '| Package | Version | Used by | Rationale |',
  '| ------- | ------- | ------- | --------- |',
);
for (const [dep, use] of [...runtimeUses].sort(([a], [b]) => a.localeCompare(b))) {
  const policy = RUNTIME_ALLOWLIST[dep];
  const scope = policy?.scope === undefined ? '' : ` _(only with ${policy.scope.join(', ')})_`;
  docLines.push(
    `| \`${dep}\` | ${[...use.versions].join(', ')} | ${[...use.importers].sort().join(', ')} | ${policy?.rationale ?? '—'}${scope} |`,
  );
}
docLines.push('');

const docText = `${docLines.join('\n')}\n`;
const docPath = 'src/docs/dependencies.md';
if (process.argv.includes('--write')) {
  writeFileSync(docPath, docText);
  process.stdout.write('  ✓ src/docs/dependencies.md written\n');
} else if (existsSync(docPath) && readFileSync(docPath, 'utf8') !== docText) {
  problems.push(`${docPath} is stale — run \`make deps-doc\` and commit the result`);
}

const rootCount = runtimeUses.size - scopedCount;
const scopeNote =
  scopedCount === 0 ? '' : `, ${String(scopedCount)} load only with a subpath entrypoint`;
process.stdout.write(
  `✓ dependency policy holds (${String(rootCount)} runtime dependenc${rootCount === 1 ? 'y' : 'ies'}${scopeNote}, all tree-shakeable)\n`,
);

if (problems.length > 0) {
  process.stderr.write(`\ndependency policy failed (${String(problems.length)})\n\n`);
  for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`);
  process.stderr.write('\n');
  process.exit(1);
}
