/**
 * `tsir route:list` (RTR-010).
 *
 * The compiled route table is the only thing the runtime trusts, so being able
 * to print it is the cheapest possible debugging tool: is the prefix right, did
 * the class-level middleware merge, is this route actually registered, which
 * handler owns `/api/users/:id`.
 *
 * Two output shapes, both stable:
 *   - human: one aligned row per route, grouped by path, with the metadata that
 *     changes behaviour (status, middleware, guards, policies);
 *   - `--json`: `{ schemaVersion: 1, count, routes[] }` — consumed by the deploy
 *     planner later, so it is versioned from day one.
 *
 * Discovery is the same path the build uses: load the project, import the app
 * entry (which imports its controllers), then read the registry. No separate
 * glob, no second definition of "what is a route".
 */

import { collectRouteEntries, compileRoutes, type RouteTable } from '@tsir/router';

import { boolFlag, parseArgs } from '../args.ts';
import { loadProject } from '../project.ts';
import { EXIT, fail, info, jsonDocument } from '../output.ts';

/** One row as printed and as serialized. Deliberately flat and id-free. */
export interface RouteRow {
  readonly method: string;
  readonly path: string;
  /** Deploy unit (RTR-011). Consumed by the deploy planner, not by the runtime. */
  readonly unit: string;
  readonly controller: string;
  readonly handler: string;
  readonly status: number;
  readonly middleware: readonly string[];
  readonly guards: readonly string[];
  readonly policies: readonly string[];
  readonly tags: readonly string[];
}

/**
 * `TokenRef` is a plain string; `PolicyRef` is a resource/action pair. Both are
 * printed as one human token so a row stays on one line.
 */
function describePolicy(ref: { readonly resource: string; readonly action: string }): string {
  return `${ref.resource}:${ref.action}`;
}

export function describeRoutes(table: RouteTable): readonly RouteRow[] {
  return table.routes.map((route) => ({
    method: route.method,
    path: route.path,
    unit: route.meta.unit,
    controller: route.controller.name,
    handler: route.handler,
    status: route.meta.status ?? 200,
    middleware: [...route.middleware],
    guards: [...route.guards],
    policies: route.policies.map(describePolicy),
    tags: [...(route.meta.tags ?? [])],
  }));
}

/** Column-aligned plain text. No colour: this output gets pasted into issues. */
export function formatRoutes(rows: readonly RouteRow[]): string {
  if (rows.length === 0) return '  no routes registered\n';

  const width = (values: readonly string[]): number =>
    values.reduce((max, value) => Math.max(max, value.length), 0);

  const methodWidth = width(rows.map((row) => row.method));
  const pathWidth = width(rows.map((row) => row.path));
  const handlerWidth = width(rows.map((row) => `${row.controller}.${row.handler}`));

  const lines = rows.map((row) => {
    const notes: string[] = [];
    if (row.middleware.length > 0) notes.push(`mw:${row.middleware.join(',')}`);
    if (row.guards.length > 0) notes.push(`guard:${row.guards.join(',')}`);
    if (row.policies.length > 0) notes.push(`policy:${row.policies.join(',')}`);
    if (row.tags.length > 0) notes.push(`tags:${row.tags.join(',')}`);
    // Printed only when it is not the default: a column of `http` on every row
    // would push the interesting metadata off the right edge of a terminal.
    if (row.unit !== 'http') notes.push(`unit:${row.unit}`);

    return (
      `  ${row.method.padEnd(methodWidth)}  ${row.path.padEnd(pathWidth)}  ` +
      `${String(row.status).padStart(3)}  ` +
      `${`${row.controller}.${row.handler}`.padEnd(handlerWidth)}` +
      (notes.length === 0 ? '' : `  ${notes.join(' ')}`)
    );
  });

  return `${lines.join('\n')}\n`;
}

export function routesJson(rows: readonly RouteRow[]): string {
  return `${jsonDocument({ count: rows.length, routes: rows })}\n`;
}

export async function routeListCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });
  const json = boolFlag(args, '--json');

  try {
    // Loading the project imports the app entry, which imports the controllers;
    // that is what populates the registry. Nothing else is executed.
    await loadProject(process.cwd());
  } catch (error: unknown) {
    return fail(error, json);
  }

  let rows: readonly RouteRow[];
  try {
    rows = describeRoutes(compileRoutes(collectRouteEntries()));
  } catch (error: unknown) {
    // Duplicate/ambiguous/arity errors are compile diagnostics (RTR_DUPLICATE …);
    // reporting them here is the point of having a command at all.
    return fail(error, json);
  }

  if (json) {
    info(routesJson(rows).trimEnd());
  } else {
    info(`\n  ${String(rows.length)} route(s)\n`);
    info(formatRoutes(rows));
  }

  return rows.length === 0 ? EXIT.environment : EXIT.ok;
}
