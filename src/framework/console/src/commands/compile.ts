/**
 * `tsir route:compile` (RTR-007).
 *
 * Discovery → validation → `routes.gen.ts`. The three steps exist to remove one
 * runtime cost and one class of bug:
 *
 *   - the generated file is the route table, so boot reads data instead of
 *     reconstructing the table from decorator metadata;
 *   - the same validation that runs at boot (`compileRoutes`) runs here, at
 *     build time, where a duplicate or ambiguous path costs a build instead of
 *     a deployment;
 *   - `--check` compares would-be output with the file on disk, so a stale
 *     generated table fails CI instead of silently serving old routes.
 *
 * The awkward part is schemas. Route metadata holds Standard Schema *values* —
 * Zod objects, `zod/mini` objects — and those cannot be serialized. So the
 * compiler does not serialize them: it finds the exported binding that holds
 * the same object by identity and emits an import for it. A schema that is not
 * exported anywhere the compiler can reach is a hard error with a fix, not a
 * silently missing validator.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  compileRoutes,
  emitRoutesModule,
  type ControllerClass,
  type GeneratedRoute,
  type ImportRef,
  type RouteEntry,
  type RouteMeta,
  collectRouteEntries,
} from '@tsir/router';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { type LoadedProject, loadProject } from '../project.ts';
import { CliError, EXIT, fail, info, style, jsonDocument } from '../output.ts';

/** Default location, matching the default `paths.routes`. */
const DEFAULT_OUT = 'routes.gen.ts';
const DEFAULT_GLOBS = ['**/*.controller.ts'] as const;
const IGNORED = new Set(['node_modules', 'dist', 'build', 'out', '.git', '.verify', '.tsir']);

export interface CompileReport {
  readonly path: string;
  readonly count: number;
  readonly outcome: 'written' | 'unchanged' | 'drift';
  readonly drift?: readonly string[];
}

/**
 * The exported name that holds `target`, if any.
 *
 * Sorted keys make the choice deterministic when a module aliases the same
 * value twice (`export { A, A as Alias }`), which would otherwise depend on
 * property insertion order.
 */
export function findExportedName(
  namespace: Record<string, unknown>,
  target: unknown,
): string | undefined {
  for (const name of Object.keys(namespace).sort()) {
    if (namespace[name] === target) return name;
  }
  return undefined;
}

/** Module specifiers a source file imports or re-exports from, in source order. */
export function importSpecifiersOf(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[^;'"]*?from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined && specifier.startsWith('.')) found.push(specifier);
  }
  return found;
}

/** `./controllers/users.controller.ts` — always relative, always with extension. */
function toSpecifier(fromFile: string, toFile: string): string {
  const path = relative(dirname(fromFile), toFile).split(sep).join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

async function namespaceOf(file: string): Promise<Record<string, unknown>> {
  const module: unknown = await import(pathToFileURL(file).href);
  return module as Record<string, unknown>;
}

/** Every `*.controller.ts` under the project, minus generated and vendor trees. */
function discoverFiles(root: string, globs: readonly string[]): string[] {
  const found = new Set<string>();
  for (const pattern of globs) {
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) {
      const parts = path.split('/');
      if (parts.some((part) => IGNORED.has(part))) continue;
      found.add(join(root, path));
    }
  }
  return [...found].sort();
}

interface ControllerBinding {
  readonly ref: ImportRef;
  readonly file: string;
}

/**
 * Maps each registered controller class to the module that exports it.
 *
 * The registry only knows the class, and the generated file has to *import* it,
 * so the class has to be traceable back to an export. Controllers are therefore
 * required to be exported by name — the alternative is emitting the class body,
 * which nobody wants to debug at 3am.
 */
async function bindControllers(
  entries: readonly RouteEntry[],
  root: string,
  globs: readonly string[],
  outFile: string,
): Promise<Map<ControllerClass, ControllerBinding>> {
  const pending = new Set(entries.map((entry) => entry.controller));
  const bindings = new Map<ControllerClass, ControllerBinding>();

  for (const file of discoverFiles(root, globs)) {
    if (pending.size === 0) break;
    const namespace = await namespaceOf(file);
    for (const [name, value] of Object.entries(namespace)) {
      if (!pending.has(value as ControllerClass)) continue;
      pending.delete(value as ControllerClass);
      bindings.set(value as ControllerClass, {
        ref: { specifier: toSpecifier(outFile, file), name },
        file,
      });
    }
  }

  if (pending.size > 0) {
    const names = entries
      .filter((entry) => pending.has(entry.controller))
      .map((entry) => entry.controller.name);
    throw new CliError(
      `controller not exported from any file matching ${globs.join(', ')}: ${names.join(', ')}`,
      EXIT.environment,
      'export the controller class by name (`export class UsersController`) so routes.gen.ts can import it',
    );
  }

  return bindings;
}

/**
 * Finds the export holding `schema`, searching the owning module first and then
 * the modules it imports from.
 *
 * The second pass matters in practice: validators usually live in a shared
 * `schemas/` module and are imported into the controller, not re-exported from
 * it. One level of imports is deliberate — deeper search would make the
 * generated import list depend on module graph shape, and a shared module is
 * always one hop away.
 */
async function resolveSchema(
  schema: unknown,
  owner: ControllerBinding,
  outFile: string,
): Promise<ImportRef> {
  const direct = findExportedName(await namespaceOf(owner.file), schema);
  if (direct !== undefined) {
    return { specifier: owner.ref.specifier, name: direct };
  }

  const source = readFileSync(owner.file, 'utf8');
  for (const specifier of importSpecifiersOf(source)) {
    const file = resolve(dirname(owner.file), specifier);
    if (!existsSync(file)) continue;
    const name = findExportedName(await namespaceOf(file), schema);
    if (name !== undefined) return { specifier: toSpecifier(outFile, file), name };
  }

  throw new CliError(
    `route schema is not exported: ${owner.ref.name} uses a validator that no module exports`,
    EXIT.environment,
    'export it by name (`export const CreateUser = z.object(…)`) from the controller module or one it imports',
  );
}

async function toGeneratedRoute(
  entry: RouteEntry,
  binding: ControllerBinding,
  outFile: string,
): Promise<GeneratedRoute> {
  const meta = entry.meta;
  const schemaFor = async (schema: RouteMeta['params']): Promise<ImportRef | undefined> =>
    schema === undefined ? undefined : resolveSchema(schema, binding, outFile);

  const params = await schemaFor(meta.params);
  const query = await schemaFor(meta.query);
  const body = await schemaFor(meta.body);
  const headers = await schemaFor(meta.headers);
  const response = await schemaFor(meta.response);

  return {
    method: entry.method,
    path: entry.path,
    declaredPath: meta.path,
    segments: entry.segments,
    controller: binding.ref,
    handler: entry.handler,
    status: meta.status ?? 200,
    unit: meta.unit,
    schemas: {
      ...(params === undefined ? {} : { params }),
      ...(query === undefined ? {} : { query }),
      ...(body === undefined ? {} : { body }),
      ...(headers === undefined ? {} : { headers }),
      ...(response === undefined ? {} : { response }),
    },
    middleware: entry.middleware,
    guards: entry.guards,
    policies: entry.policies,
    ...(meta.consumes === undefined ? {} : { consumes: meta.consumes }),
    ...(meta.multipart === undefined ? {} : { multipart: meta.multipart }),
    ...(meta.produces === undefined ? {} : { produces: meta.produces }),
    ...(meta.timeoutMs === undefined ? {} : { timeoutMs: meta.timeoutMs }),
    ...(meta.operationId === undefined ? {} : { operationId: meta.operationId }),
    ...(meta.summary === undefined ? {} : { summary: meta.summary }),
    ...(meta.tags === undefined ? {} : { tags: meta.tags }),
    ...(meta.principal === true ? { principal: true } : {}),
  };
}

/** Line-level diff summary — enough to find the drift, short enough to read. */
function summarizeDrift(expected: string, actual: string): readonly string[] {
  const want = expected.split('\n');
  const have = actual.split('\n');
  const added = want.filter((line) => !have.includes(line));
  const removed = have.filter((line) => !want.includes(line));
  return [
    ...added.slice(0, 6).map((line) => `+ ${line.trim()}`),
    ...removed.slice(0, 6).map((line) => `- ${line.trim()}`),
  ];
}

export async function compileProject(
  project: LoadedProject,
  options: { readonly out?: string; readonly check?: boolean },
): Promise<CompileReport> {
  const outFile = resolve(project.root, options.out ?? DEFAULT_OUT);
  const globs = DEFAULT_GLOBS;

  // Importing the entry is what registers controllers: one definition of "what
  // is a route", shared with `dev`, `build` and `route:list`.
  await import(pathToFileURL(project.entryPath).href);

  const table = compileRoutes(collectRouteEntries());
  const bindings = await bindControllers(table.routes, project.root, globs, outFile);

  const routes: GeneratedRoute[] = [];
  for (const entry of table.routes) {
    const binding = bindings.get(entry.controller);
    if (binding === undefined) {
      throw new CliError(`no module binding for ${entry.controller.name}`, EXIT.environment);
    }
    routes.push(await toGeneratedRoute(entry, binding, outFile));
  }

  const source = emitRoutesModule({ app: project.config.app.name, routes });
  const exists = existsSync(outFile);
  const current = exists ? readFileSync(outFile, 'utf8') : '';

  if (options.check === true) {
    if (!exists || current !== source) {
      return {
        path: outFile,
        count: routes.length,
        outcome: 'drift',
        drift: exists ? summarizeDrift(source, current) : ['(file does not exist)'],
      };
    }
    return { path: outFile, count: routes.length, outcome: 'unchanged' };
  }

  if (exists && current === source) {
    return { path: outFile, count: routes.length, outcome: 'unchanged' };
  }

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, source, 'utf8');
  return { path: outFile, count: routes.length, outcome: 'written' };
}

export async function routeCompileCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--json': { type: 'boolean', description: 'machine-readable output' },
    '--check': {
      type: 'boolean',
      description: 'fail if routes.gen.ts is stale instead of writing',
    },
    '--out': {
      type: 'string',
      description: 'output path (default: paths.routes or routes.gen.ts)',
    },
  });
  const json = boolFlag(args, '--json');
  const check = boolFlag(args, '--check');
  const out = stringFlag(args, '--out');

  try {
    const project = await loadProject(process.cwd());
    const report = await compileProject(project, { check, ...(out === undefined ? {} : { out }) });
    const shown = report.path.startsWith(project.root)
      ? report.path.slice(project.root.length + 1)
      : report.path;

    if (report.outcome === 'drift') {
      if (json) {
        info(jsonDocument({ ok: false, path: shown, count: report.count, drift: report.drift }));
      } else {
        info(`${style.red('stale')} ${shown} — ${String(report.count)} route(s) would differ`);
        for (const line of report.drift ?? []) info(`  ${line}`);
        info('run `tsir route:compile` to regenerate');
      }
      return EXIT.failure;
    }

    if (json) {
      info(jsonDocument({ ok: true, path: shown, count: report.count, outcome: report.outcome }));
    } else {
      const verb = report.outcome === 'written' ? 'wrote' : 'unchanged';
      info(`${style.green(verb)} ${shown} · ${String(report.count)} route(s)`);
    }
    return EXIT.ok;
  } catch (error: unknown) {
    return fail(error, json);
  }
}
