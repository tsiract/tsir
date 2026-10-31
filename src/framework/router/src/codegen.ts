/**
 * Emitting `routes.gen.ts` (RTR-007).
 *
 * The compiler is split in two on purpose:
 *
 *   - **this module** turns a fully-resolved route table into source text. It is
 *     pure, synchronous and runtime-neutral — no `node:fs`, no `bun:`, no clock;
 *   - **`tsir route:compile`** does the impure half: discover files, import them,
 *     resolve schema objects to exported names, write the file.
 *
 * The split is what makes determinism testable. "Same input → same bytes" is a
 * property of a pure function, so it is asserted directly instead of by running
 * a CLI twice and diffing a temp directory.
 *
 * Determinism is not cosmetic here: the generated file is committed, so a noisy
 * generator turns every build into a diff and trains people to ignore it.
 * Everything that could vary — timestamps, absolute paths, object key order,
 * import order — is therefore excluded or sorted.
 */

import type { ContentType, HttpMethod, PolicyRef, RouteStatus, TokenRef } from './types.ts';

/** A value imported by name from another module, e.g. `UsersController`. */
export interface ImportRef {
  /** As written in the generated file: relative, with extension (`./a/b.ts`). */
  readonly specifier: string;
  readonly name: string;
}

/** One route, with every schema already resolved to an imported identifier. */
export interface GeneratedRoute {
  readonly method: HttpMethod;
  /** Fully-qualified path, e.g. `/api/users/:id`. */
  readonly path: string;
  /** The path exactly as declared on the method, before the controller prefix. */
  readonly declaredPath: string;
  readonly segments: readonly string[];
  readonly controller: ImportRef;
  readonly handler: string;
  readonly status: RouteStatus;
  /** Resolved deploy unit (RTR-011). */
  readonly unit: string;
  readonly schemas: {
    readonly params?: ImportRef;
    readonly query?: ImportRef;
    readonly body?: ImportRef;
    readonly headers?: ImportRef;
    readonly response?: ImportRef;
  };
  /** `true` when the handler binds `principal`; always paired with a guard. */
  readonly principal?: true;
  readonly middleware: readonly TokenRef[];
  readonly guards: readonly TokenRef[];
  readonly policies: readonly PolicyRef[];
  readonly consumes?: readonly ContentType[];
  readonly multipart?: {
    readonly maxFileBytes?: number;
    readonly maxFiles?: number;
    readonly sniff?: boolean;
  };
  readonly produces?: readonly ContentType[];
  readonly timeoutMs?: number;
  readonly operationId?: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
}

export interface RoutesModuleInput {
  /** Application name, echoed in the header so a stray file is identifiable. */
  readonly app: string;
  /** In matcher order — the emitter never re-sorts, because order is precedence. */
  readonly routes: readonly GeneratedRoute[];
}

const INDENT = '  ';

/** Single-quoted string literal, escaped so any path or summary round-trips. */
function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`;
}

function stringArray(values: readonly string[]): string {
  return `[${values.map((value) => quote(value)).join(', ')}]`;
}

function policiesArray(policies: readonly PolicyRef[]): string {
  return `[${policies
    .map(
      (policy) =>
        `{ resource: ${quote(policy.resource)}, action: ${quote(policy.action)}` +
        `${policy.audit === true ? ', audit: true' : ''} }`,
    )
    .join(', ')}]`;
}

/**
 * Merges every import into one specifier → names map, sorted.
 *
 * Sorting both levels is what makes the output independent of the order in
 * which controllers and schemas happened to be discovered.
 */
function collectImports(routes: readonly GeneratedRoute[]): Map<string, string[]> {
  const bySpecifier = new Map<string, Set<string>>();
  const add = (ref: ImportRef): void => {
    const names = bySpecifier.get(ref.specifier) ?? new Set<string>();
    names.add(ref.name);
    bySpecifier.set(ref.specifier, names);
  };

  for (const route of routes) {
    add(route.controller);
    for (const schema of Object.values(route.schemas)) {
      if (schema !== undefined) add(schema);
    }
  }

  return new Map(
    [...bySpecifier.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([specifier, names]) => [specifier, [...names].sort()]),
  );
}

function emitRoute(route: GeneratedRoute): string {
  const lines: string[] = [`${INDENT}defineRoute({`];
  const field = (key: string, value: string): void => {
    lines.push(`${INDENT}${INDENT}${key}: ${value},`);
  };

  field('method', quote(route.method));
  field('path', quote(route.path));
  field('segments', stringArray(route.segments));
  field('controller', route.controller.name);
  field('handler', quote(route.handler));

  // `meta` mirrors what the decorator declared, so a generated table and a
  // registry-compiled one are the same value, not merely equivalent.
  const meta: string[] = [`${INDENT}${INDENT}meta: {`];
  const metaField = (key: string, value: string): void => {
    meta.push(`${INDENT}${INDENT}${INDENT}${key}: ${value},`);
  };
  metaField('method', quote(route.method));
  metaField('path', quote(route.declaredPath));
  if (route.schemas.params !== undefined) metaField('params', route.schemas.params.name);
  if (route.schemas.query !== undefined) metaField('query', route.schemas.query.name);
  if (route.schemas.body !== undefined) metaField('body', route.schemas.body.name);
  if (route.schemas.headers !== undefined) metaField('headers', route.schemas.headers.name);
  if (route.schemas.response !== undefined) metaField('response', route.schemas.response.name);
  metaField('status', String(route.status));
  metaField('unit', quote(route.unit));
  if (route.principal === true) metaField('principal', 'true');
  if (route.guards.length > 0) metaField('guards', stringArray(route.guards));
  if (route.policies.length > 0) metaField('policies', policiesArray(route.policies));
  if (route.middleware.length > 0) metaField('middleware', stringArray(route.middleware));
  if (route.consumes !== undefined) metaField('consumes', stringArray(route.consumes));
  if (route.multipart !== undefined) {
    const parts: string[] = [];
    if (route.multipart.maxFileBytes !== undefined) {
      parts.push(`maxFileBytes: ${String(route.multipart.maxFileBytes)}`);
    }
    if (route.multipart.maxFiles !== undefined)
      parts.push(`maxFiles: ${String(route.multipart.maxFiles)}`);
    if (route.multipart.sniff !== undefined) parts.push(`sniff: ${String(route.multipart.sniff)}`);
    metaField('multipart', `{ ${parts.join(', ')} }`);
  }
  if (route.produces !== undefined) metaField('produces', stringArray(route.produces));
  if (route.timeoutMs !== undefined) metaField('timeoutMs', String(route.timeoutMs));
  if (route.operationId !== undefined) metaField('operationId', quote(route.operationId));
  if (route.summary !== undefined) metaField('summary', quote(route.summary));
  if (route.tags !== undefined) metaField('tags', stringArray(route.tags));
  meta.push(`${INDENT}${INDENT}},`);
  lines.push(...meta);

  // Merged (class-level + route-level) tokens, exactly what compileRoutes produced.
  field('middleware', stringArray(route.middleware));
  field('guards', stringArray(route.guards));
  field('policies', policiesArray(route.policies));

  lines.push(`${INDENT}}),`);
  return lines.join('\n');
}

/**
 * Renders the whole module.
 *
 * Two source lines are stable by contract: the first says the file is
 * generated, the second says what generated it. Neither contains a date or an
 * absolute path — both would defeat byte-for-byte determinism.
 */
export function emitRoutesModule(input: RoutesModuleInput): string {
  const imports = collectImports(input.routes);
  const out: string[] = [
    '// AUTO-GENERATED by `tsir route:compile` — do not edit. Regenerate instead.',
    `// app: ${input.app} · routes: ${String(input.routes.length)}`,
    "import { defineRoute, type RouteEntry } from '@tsir/router';",
  ];

  for (const [specifier, names] of imports) {
    out.push(`import { ${names.join(', ')} } from '${specifier}';`);
  }

  if (input.routes.length === 0) {
    out.push('', 'export const routes: readonly RouteEntry[] = [];', '');
    return out.join('\n');
  }

  out.push('', 'export const routes: readonly RouteEntry[] = [');
  for (const route of input.routes) out.push(emitRoute(route));
  out.push('];', '');
  return out.join('\n');
}
