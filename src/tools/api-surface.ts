/**
 * Public API surface (FND-024).
 *
 * The project promises that a public API change is a *documented* change. Until
 * a package is published, nothing else catches a stray export: it is additive,
 * it compiles, and six months later it is a compatibility obligation.
 *
 * This records what each package exports, split by value vs type, and fails when
 * the surface moves without the snapshot being refreshed. The snapshot lives in
 * `src/docs/api-surface.json`, next to the docs, because that is where the
 * decision to widen an API belongs.
 *
 *   bun src/tools/api-surface.ts          # check (CI)
 *   bun src/tools/api-surface.ts --write  # accept the current surface
 *
 * Scope: named exports of each package's barrel **and of every declared subpath
 * entry** in its `exports` map, following relative re-exports (`export * from`,
 * `export { x } from`, `export type { T } from`).
 *
 * Subpath entries (`@tsir/database/postgres`, `@tsir/validate/mini`, …) are part
 * of the public API in exactly the same way the barrel is, and the first subpath
 * shipped a whole driver — a snapshot that only watched `index.ts` would have
 * called that an internal change.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const SNAPSHOT = join(ROOT, 'src', 'docs', 'api-surface.json');
const FRAMEWORK = join(ROOT, 'src', 'framework');

export type Surface = Readonly<Record<string, readonly string[]>>;

function modulePath(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = join(from, '..', specifier);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  return undefined;
}

function collect(file: string, into: Set<string>, seen = new Set<string>()): void {
  if (seen.has(file)) return;
  seen.add(file);

  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext);
  for (const statement of source.statements) {
    const exported = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false;

    if (ts.isExportDeclaration(statement)) {
      const target =
        statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
          ? modulePath(file, statement.moduleSpecifier.text)
          : undefined;

      if (statement.exportClause === undefined) {
        if (target !== undefined) collect(target, into, seen); // export * from
        continue;
      }
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const name = element.name.text;
          if (name === 'default') continue;
          into.add(name);
        }
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!exported || modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) === true)
      continue;

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) into.add(declaration.name.text);
      }
      continue;
    }

    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isFunctionDeclaration(statement)
    ) {
      if (statement.name !== undefined) into.add(statement.name.text);
    }
  }
}

export function surfaceOfFile(file: string): readonly string[] {
  if (!existsSync(file)) return [];
  const names = new Set<string>();
  collect(file, names);
  return [...names].sort();
}

/** Every named export of a package barrel, sorted. */
export function surfaceOf(packageDir: string): readonly string[] {
  return surfaceOfFile(join(packageDir, 'src', 'index.ts'));
}

/**
 * Declared subpath entries whose target is still source, e.g.
 * `{ './mini': './src/mini.ts' }` → `[['mini', '…/src/mini.ts']]`.
 */
function subpathEntries(packageDir: string): [string, string][] {
  const manifest = join(packageDir, 'package.json');
  if (!existsSync(manifest)) return [];
  const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
    exports?: Record<string, string | { types?: string; default?: string }>;
  };
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(parsed.exports ?? {})) {
    if (!key.startsWith('./') || key === './package.json') continue;
    const target = typeof value === 'string' ? value : (value.default ?? value.types);
    if (target === undefined || !target.endsWith('.ts')) continue;
    entries.push([key.slice(2), join(packageDir, target)]);
  }
  return entries;
}

export function currentSurface(): Surface {
  const surface: Record<string, readonly string[]> = {};
  for (const entry of readdirSync(FRAMEWORK, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(FRAMEWORK, entry.name);
    const exports = surfaceOf(dir);
    if (exports.length > 0) surface[entry.name] = exports;
    // Subpaths are keyed `package:subpath` so a change there is a visible diff
    // against the same snapshot rather than an unrecorded addition.
    for (const [subpath, file] of subpathEntries(dir)) {
      const names = surfaceOfFile(file);
      if (names.length > 0) surface[`${entry.name}:${subpath}`] = names;
    }
  }
  return surface;
}

if (import.meta.main) {
  const write = process.argv.includes('--write');
  const current = currentSurface();
  const previous: Surface = existsSync(SNAPSHOT)
    ? (JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Surface)
    : {};

  if (write) {
    writeFileSync(SNAPSHOT, `${JSON.stringify(current, null, 2)}\n`);
    const total = Object.values(current).reduce((sum, names) => sum + names.length, 0);
    process.stdout.write(
      `✓ api surface written (${String(Object.keys(current).length)} packages, ${String(total)} exports)\n`,
    );
    process.exit(0);
  }

  const problems: string[] = [];
  for (const pkg of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    const before = new Set(previous[pkg] ?? []);
    const after = new Set(current[pkg] ?? []);
    for (const name of after) if (!before.has(name)) problems.push(`  + ${pkg}: ${name}`);
    for (const name of before) if (!after.has(name)) problems.push(`  − ${pkg}: ${name}`);
  }

  if (problems.length > 0) {
    process.stderr.write('public API changed:\n');
    process.stderr.write(`${problems.join('\n')}\n\n`);
    process.stderr.write(
      'Describe the change in the package README, then run `bun src/tools/api-surface.ts --write`.\n',
    );
    process.exit(1);
  }

  const total = Object.values(current).reduce((sum, names) => sum + names.length, 0);
  process.stdout.write(
    `✓ api surface unchanged (${String(Object.keys(current).length)} packages, ${String(total)} exports)\n`,
  );
}
