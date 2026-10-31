/**
 * Application-module boundaries (`MOD-003`).
 *
 * `check-boundaries` enforces the *package* graph. This enforces the graph
 * *inside an application*, which is where a modular monolith actually rots: not
 * with a wrong dependency between framework packages, but with one feature
 * reaching into another feature's internals because the deadline was close.
 *
 * Layout it assumes:
 *
 *   src/apps/<app>/src/modules/<module>/     one module = one directory
 *   src/apps/<app>/src/modules/<module>/index.ts   its public surface
 *   src/apps/<app>/src/shared/               code with no owner
 *
 * Rules:
 *   1. A module may import another module **only** through its `index.ts`.
 *   2. A module may not re-enter itself through `../` — that is a module
 *      reaching around its own public surface, and it always means the file is in
 *      the wrong place.
 *   3. `shared/` may not import a module. If it needs one, the code has an owner
 *      and belongs in that module — this is the rule that stops `shared/` from
 *      silently becoming a second application.
 *
 * Generated files (`*.gen.ts`) are exempt: they are assembled by the CLI and
 * deliberately import every module's controllers.
 *
 * Usage: bun src/tools/check-modules.ts [--json]
 */

import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** `src/tools/` → repository root. */
const ROOT = resolve(import.meta.dir, '..', '..');
const APPS_DIR = join(ROOT, 'src', 'apps');

export type ModuleRule = 'cross-module-internal' | 'self-import' | 'shared-depends-on-module';

export interface ModuleViolation {
  /** Repository-relative path of the importing file. */
  readonly file: string;
  /** Module (or `shared`) the file belongs to. */
  readonly importer: string;
  readonly rule: ModuleRule;
  readonly specifier: string;
  readonly detail: string;
}

export interface ModuleContext {
  /** Absolute path of the importing file. */
  readonly file: string;
  /** App root, absolute — the directory containing `src/`. */
  readonly appRoot: string;
}

/** Splits a repository-relative path into `modules/<name>/…` when it lives there. */
export function moduleOf(
  path: string,
): { readonly name: string; readonly rest: string } | undefined {
  const marker = `${sep}modules${sep}`;
  const index = path.lastIndexOf(marker);
  if (index === -1) return undefined;
  const tail = path.slice(index + marker.length);
  const slash = tail.indexOf(sep);
  const name = slash === -1 ? tail : tail.slice(0, slash);
  if (name === '') return undefined;
  return { name, rest: slash === -1 ? '' : tail.slice(slash + 1) };
}

function isInsideShared(path: string): boolean {
  return path.includes(`${sep}shared${sep}`);
}

/**
 * Whether a module-to-module import goes through the public entry.
 *
 * `./index.ts`, `../users` and `../users/index.ts` are the same door; anything
 * deeper (`../users/repository.ts`) is the wall being climbed.
 */
function isPublicEntry(rest: string): boolean {
  return rest === '' || rest === 'index.ts' || rest === 'index';
}

/** The whole rule set as a pure function: one specifier in, at most one violation out. */
export function checkModuleSpecifier(
  specifier: string,
  context: ModuleContext,
): ModuleViolation | undefined {
  // Bare specifiers are packages; `@tsir/*` is check-boundaries' job, and app
  // path aliases would need their own resolution. Only relative paths are ours.
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;

  const file = relative(ROOT, context.file).split(sep).join('/');
  const app = relative(ROOT, context.appRoot).split(sep).join('/');
  const target = resolve(dirname(context.file), specifier);
  const targetRel = relative(ROOT, target);
  const targetModule = moduleOf(targetRel);
  const selfModule = moduleOf(relative(ROOT, context.file));

  if (targetModule !== undefined) {
    // shared/ importing a module: the dependency inverts ownership.
    if (isInsideShared(relative(ROOT, context.file)) && selfModule === undefined) {
      return {
        file,
        importer: 'shared',
        rule: 'shared-depends-on-module',
        specifier,
        detail: `shared/ may not import module "${targetModule.name}" — the code has an owner; move it into that module or invert the dependency`,
      };
    }

    if (selfModule !== undefined && targetModule.name !== selfModule.name) {
      if (!isPublicEntry(targetModule.rest)) {
        return {
          file,
          importer: selfModule.name,
          rule: 'cross-module-internal',
          specifier,
          detail: `module "${selfModule.name}" reaches into "${targetModule.name}/${targetModule.rest}" — import "../${targetModule.name}/index.ts" instead`,
        };
      }
      return undefined;
    }

    // `../users/...` written from inside `users` — a module going around itself.
    if (
      selfModule !== undefined &&
      targetModule.name === selfModule.name &&
      specifier.includes(`../`)
    ) {
      if (specifier.split('/').includes(selfModule.name)) {
        return {
          file,
          importer: selfModule.name,
          rule: 'self-import',
          specifier,
          detail: `module "${selfModule.name}" re-enters itself through ".." — use a relative "./" path, or move the file`,
        };
      }
    }
    return undefined;
  }

  // Escaping the app entirely (`../../../../framework/...`) is a package import
  // written the long way; check-boundaries already rejected deep package paths,
  // and apps are allowed to import packages. Nothing to add here.
  if (!targetRel.startsWith(`${app}/`) && !targetRel.startsWith('src/framework/')) {
    return undefined;
  }

  return undefined;
}

async function listSourceFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.gen.ts')) continue;
    files.push(join(entry.parentPath, entry.name));
  }
  return files;
}

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function collectSpecifiers(source: string): readonly string[] {
  const found = new Set<string>();
  for (const pattern of [IMPORT_PATTERN, DYNAMIC_IMPORT_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.add(specifier);
    }
  }
  return [...found];
}

/**
 * App roots that declare modules — an app with none is simply skipped.
 *
 * Discovery is by directory, not by a hard-coded list: any `src/modules/` inside
 * `src/apps/` is an app that has adopted modules, wherever it is nested
 * (`src/apps/examples/http/src/modules`, `src/apps/acme/src/modules`, …).
 */
export async function findAppsWithModules(): Promise<readonly string[]> {
  const entries = await readdir(APPS_DIR, { withFileTypes: true, recursive: true }).catch(() => []);
  const apps: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name !== 'modules') continue;
    const src = entry.parentPath;
    if (src.split(sep).at(-1) !== 'src') continue;
    const appRoot = dirname(src);
    if (!apps.includes(appRoot)) apps.push(appRoot);
  }
  return apps.sort();
}

async function checkApp(
  appRoot: string,
  violations: ModuleViolation[],
): Promise<readonly string[]> {
  const modulesDir = join(appRoot, 'src', 'modules');
  const modules = (await readdir(modulesDir, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  const dirs = [modulesDir, join(appRoot, 'src', 'shared')];

  for (const dir of dirs) {
    for (const file of await listSourceFiles(dir)) {
      const source = await Bun.file(file).text();
      for (const specifier of collectSpecifiers(source)) {
        const violation = checkModuleSpecifier(specifier, { file, appRoot });
        if (violation !== undefined) violations.push(violation);
      }
    }
  }

  return modules.map((entry) => entry.name).sort();
}

async function main(): Promise<void> {
  const json = Bun.argv.includes('--json');
  const apps = await findAppsWithModules();

  const violations: ModuleViolation[] = [];
  const report: { app: string; modules: readonly string[] }[] = [];

  for (const appRoot of apps) {
    const modules = await checkApp(appRoot, violations);
    report.push({ app: relative(ROOT, appRoot), modules });
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: violations.length === 0, apps: report, violations }, null, 2)}\n`,
    );
    process.exit(violations.length === 0 ? 0 : 1);
  }

  if (violations.length === 0) {
    const summary =
      report.length === 0
        ? 'no app declares modules yet'
        : report.map((entry) => `${entry.app}: ${entry.modules.join(', ') || '(none)'}`).join('; ');
    process.stdout.write(`✓ module boundaries clean (${summary})\n`);
    process.exit(0);
  }

  const red = Bun.enableANSIColors ? '\u001B[31m' : '';
  const dim = Bun.enableANSIColors ? '\u001B[2m' : '';
  const reset = Bun.enableANSIColors ? '\u001B[0m' : '';

  process.stderr.write(
    `${red}✗ ${String(violations.length)} module boundary violation(s)${reset}\n\n`,
  );
  for (const violation of violations) {
    process.stderr.write(`  ${violation.file}\n`);
    process.stderr.write(`    ${violation.rule}: ${violation.specifier}\n`);
    process.stderr.write(`    ${dim}${violation.detail}${reset}\n\n`);
  }
  process.exit(1);
}

if (import.meta.main) await main();
