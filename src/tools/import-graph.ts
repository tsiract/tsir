/**
 * Static import graph for one package's entrypoints (ADR-0022).
 *
 * The question this answers is narrow and mechanical: *starting from these files,
 * following relative imports, which modules are reachable — and does any of them
 * import a given third-party package?*
 *
 * It is deliberately not a bundler. It reads `import … from`, `export … from` and
 * dynamic `import(…)` specifiers with a regex, resolves only relative specifiers, and
 * stops at anything else. A regex cannot be fooled by a bundler plugin, and it also
 * cannot see one — which is why the ADR pairs this check with a bundle-size proof in
 * `verify-dist` rather than trusting either alone.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const BARE_IMPORT = /^\s*import\s+['"]([^'"]+)['"]/gm;

/** Every specifier a file imports or re-exports, in source order, de-duplicated. */
export function importedSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const found = new Set<string>();

  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1];
    if (specifier !== undefined) found.add(specifier);
  }
  for (const match of source.matchAll(BARE_IMPORT)) {
    const specifier = match[1];
    if (specifier !== undefined) found.add(specifier);
  }
  return [...found];
}

/** The package a specifier points at: `@scope/name/deep` → `@scope/name`. */
export function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return undefined;
  }
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0];
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

export interface ClosureResult {
  /** Files reached from the entries, absolute paths. */
  readonly files: readonly string[];
  /** Third-party package → the files that import it. */
  readonly packages: ReadonlyMap<string, readonly string[]>;
}

/**
 * Everything reachable from `entries` through relative imports.
 *
 * A missing relative target is reported through `unresolved` rather than ignored: a
 * dangling import in the graph means the closure is incomplete, and an incomplete
 * closure would make the "this dependency never reaches the root" claim false.
 */
export function importClosure(
  entries: readonly string[],
): ClosureResult & { readonly unresolved: readonly string[] } {
  const seen = new Set<string>();
  const packages = new Map<string, string[]>();
  const unresolved: string[] = [];
  const queue = [...entries];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    if (!existsSync(file)) {
      unresolved.push(file);
      continue;
    }
    seen.add(file);

    for (const specifier of importedSpecifiers(file)) {
      const pkg = packageOf(specifier);
      if (pkg !== undefined) {
        const importers = packages.get(pkg) ?? [];
        importers.push(file);
        packages.set(pkg, importers);
        continue;
      }
      if (!specifier.startsWith('.')) continue; // node: builtins and absolute paths: not ours

      const target = resolveRelative(file, specifier);
      if (target === undefined) unresolved.push(`${file} → ${specifier}`);
      else queue.push(target);
    }
  }

  return { files: [...seen], packages, unresolved };
}
