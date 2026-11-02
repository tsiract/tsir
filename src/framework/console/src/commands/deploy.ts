/**
 * `tsir deploy:plan`, `deploy:diff` and `deploy:invoke` (`DPL-004`, `DPL-005`, `DPL-007`).
 *
 * `deploy:build` — the emitter — lives in `./deploy-build.ts`, because it bundles and this
 * file does not.
 *
 * The three commands here answer the same question from opposite directions:
 *
 *   · `deploy:plan` — *what will be deployed?* Resolve the declarations, validate them
 *     against the configured targets, print the graph (or `--explain`, or `--json`).
 *   · `deploy:diff` — *what changed?* Compare the resolved graph to the committed
 *     `unit-graph.json` and name the difference.
 *   · `deploy:invoke` — *does it work?* Call one unit through the entry's own `handler`,
 *     locally, and say which unit owns the matched route.
 *
 * `--write` is the only thing that mutates: it writes the snapshot `deploy:diff` and CI
 * compare against. Nothing here reads a cloud API, holds a credential, or touches the
 * network — a plan you cannot run offline is a plan nobody runs on a plane, and more
 * importantly the graph's inputs are all local declarations.
 *
 * Discovery is the same path `route:list` uses: load the project, import the app entry
 * (which registers the controllers), then read the registry. There is no second definition
 * of "what is a route".
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectRouteEntries, compileRoutes, routeModules } from '@tsir/router';
import {
  buildGraph,
  type checkGraph,
  describeDiff,
  diffGraphs,
  explainGraph,
  formatGraph,
  graphJson,
  GRAPH_FILE,
  parseGraph,
  serializeGraph,
  type DeploymentInput,
  type GraphOptions,
  type TargetConfig,
  type UnitGraph,
} from '@tsir/deploy';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { EXIT, fail, info, ok, style, UsageError, warn, jsonDocument } from '../output.ts';
import { loadProject, type LoadedProject, type ProjectConfig } from '../project.ts';
import { tasksFrom } from './schedule.ts';

/**
 * Turn a loaded project into the graph's input.
 *
 * The mapping is deliberately dumb: routes come from the compiled table (`meta.unit` is
 * `RTR-011`'s attribution), modules come from `app.modulesFor(...)` so a config-dependent
 * module set is resolved the same way boot resolves it, and everything this version cannot
 * discover yet — queue consumers, cron tasks — comes from `deploy.units` in `tsir.js`.
 */
/**
 * Is this the events registry, or just something named `events`?
 *
 * Shape, not brand — the same call the queue commands make about `queues` and `jobs`. Anything
 * else would make `export const events = { … }` satisfy a rule about a writer that does not exist,
 * and being lenient here is the difference between a build error and losing a delivery.
 */
function hasEventsRegistry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate['names']) && typeof candidate['jobs'] === 'function';
}

export function deploymentOf(project: LoadedProject): DeploymentInput {
  const config = project.config;

  // Which module owns a controller is declaration-time state (`routeModules()`), not
  // something the compiled table carries: a route knows its *unit*, not its owner.
  const owner = new Map<unknown, string>();
  for (const declared of routeModules()) {
    for (const entry of declared.registry.entries())
      owner.set(entry.controller, declared.module.name);
  }

  const routes = compileRoutes(collectRouteEntries()).routes.map((route) => {
    const module = owner.get(route.controller);
    return {
      method: route.method,
      path: route.path,
      unit: route.meta.unit,
      ...(module === undefined ? {} : { module }),
    };
  });

  // AWS event-source listeners (`@OnSns`, `@OnEventBridge`, `@OnStepTask` — DPL-026).
  // Collected from the controller entries directly, not from the compiled route table,
  // because listeners are not routes: they have no method/path and the matcher never
  // sees them. The deploy planner turns each one into a unit with the right trigger.
  const listeners = collectRouteEntries().flatMap((entry) =>
    entry.listeners.map((listener) => {
      const module = owner.get(entry.controller);
      return {
        kind: listener.meta.kind,
        name:
          listener.meta.topic ?? listener.meta.eventBus ?? listener.meta.name ?? entry.controller.name,
        ...(listener.meta.detailType === undefined ? {} : { detailType: listener.meta.detailType }),
        unit: listener.meta.unit,
        ...(module === undefined ? {} : { module }),
      };
    }),
  );

  const loaded = project.app.load();
  const modules = project.app.modulesFor(loaded).map((module) => ({
    name: module.name,
    requires: module.requires?.flatMap((requirement) => [...requirement.capabilities]) ?? [],
  }));

  // A connection with a journal is a `migrate:<name>` unit (`DPL-021`). The journal flag is
  // the declaration — there is no second place that decides whether migrations run.
  const connections = Object.entries(config.database?.connections ?? {})
    .filter(([, connection]) => connection.journal !== false)
    .map(([name, connection]) => ({
      name,
      journal: true,
      ...(connection.binding === undefined
        ? {}
        : {
            // The binding kind follows the driver: D1 binds a database, and Postgres/MySQL
            // reach the runtime through Hyperdrive.
            bindings: [
              {
                kind: connection.driver === 'd1' ? ('d1' as const) : ('hyperdrive' as const),
                name: connection.binding,
              },
            ],
          }),
    }));

  // `queue.connections` (`CAP-004`): every declared connection is a unit with a trigger, and a
  // connection the target cannot run is a build failure rather than a Worker that never fires.
  const queue = Object.entries(config.queue?.connections ?? {}).map(([name, connection]) => ({
    name,
    driver: connection.driver,
    ...(connection.outbox === undefined ? {} : { outbox: connection.outbox }),
  }));

  // Tasks (`§ 4.6`): the entry's `tasks` export *is* the schedule. There is no `schedules` key
  // in `tsir.js` on purpose — a cron that exists in two files is a cron that disagrees with
  // itself, and the one the deployer reads is never the one the worker runs.
  const schedules = tasksFrom(project.exports).map((task) => ({
    name: task.name,
    cron: task.cron,
    ...(task.utcOffsetMinutes === 0 ? {} : { utcOffsetMinutes: task.utcOffsetMinutes }),
  }));

  return {
    appName: config.app.name,
    routes,
    modules,
    // `@tsir/events` (§ 4.5): an outbox needs a writer, and the app's `events` export is how the
    // registry says it has one. Read from the entry the loader already imported — not from a
    // config flag, which would be a second place to keep true.
    events: hasEventsRegistry(project.exports['events']),
    ...(connections.length === 0 ? {} : { connections }),
    ...(queue.length === 0 ? {} : { queue }),
    ...(schedules.length === 0 ? {} : { schedules }),
    ...(listeners.length === 0 ? {} : { listeners }),
    ...(config.deploy === undefined
      ? {}
      : {
          deploy: {
            ...(config.deploy.topology === undefined ? {} : { topology: config.deploy.topology }),
            ...(config.deploy.includeModules === undefined
              ? {}
              : { includeModules: config.deploy.includeModules }),
            ...(config.deploy.units === undefined ? {} : { units: config.deploy.units }),
            ...(config.deploy.publishes === undefined
              ? {}
              : { publishes: config.deploy.publishes }),
            ...(config.deploy.invokes === undefined ? {} : { invokes: config.deploy.invokes }),
          },
        }),
  };
}

type DeclaredTargets = NonNullable<NonNullable<ProjectConfig['deploy']>['targets']>;
type DeclaredTarget = DeclaredTargets[keyof DeclaredTargets];

/** `deploy.targets` → the graph's target list, preserving declaration order. */
export function targetsOf(project: LoadedProject): readonly TargetConfig[] {
  const targets = project.config.deploy?.targets ?? {};
  return (Object.entries(targets) as [string, DeclaredTarget][]).map(([target, config]) => ({
    target: target as TargetConfig['target'],
    ...(config?.bindings === undefined ? {} : { bindings: config.bindings }),
    ...(config?.sizeBudget === undefined ? {} : { sizeBudget: config.sizeBudget }),
  }));
}

/** Everything both commands need: the resolved graph, its problems, and the options used. */
/**
 * Load a project and describe it as graph input.
 *
 * The route view is **process-wide**, exactly like `tsir route:list`: discovery works by
 * importing the entry, which registers modules and controllers globally, and there is no
 * reliable way to attribute a registered controller to "the entry that imported it" after
 * the fact (a second import of the same entry reuses the cached controller modules, so the
 * registrations do not even happen twice). Rather than guess, the CLI keeps the convention
 * it already had — **one project per process** — and anything that needs a second project
 * in the same process spawns one.
 */
export async function loadDeployInput(
  cwd: string,
): Promise<{ project: LoadedProject; input: DeploymentInput }> {
  const project = await loadProject(cwd);
  return { project, input: deploymentOf(project) };
}

async function resolveFromProject(
  cwd: string,
  overrides: {
    readonly targets?: readonly TargetConfig[];
    readonly topology?: 'separate' | 'single';
  } = {},
): Promise<{ graph: UnitGraph; problems: ReturnType<typeof checkGraph>; root: string }> {
  const { project, input } = await loadDeployInput(cwd);
  const options: GraphOptions = {
    targets: overrides.targets ?? targetsOf(project),
    ...(overrides.topology === undefined ? {} : { topology: overrides.topology }),
  };

  const { graph, problems } = buildGraph(input, options);
  return { graph, problems, root: project.root };
}

export async function deployPlanCommand(argv: readonly string[]): Promise<number> {
  return plan(argv, process.cwd());
}

/**
 * The plan, at a project root.
 *
 * `cwd` is a parameter rather than `process.cwd()` so the command is testable against a
 * fixture application without mutating the process's working directory — a `chdir` in a
 * test is a race with every other test in the file.
 */
export async function plan(argv: readonly string[], cwd: string): Promise<number> {
  const args = parseArgs(argv, {
    '--json': { type: 'boolean', description: 'machine-readable graph' },
    '--explain': { type: 'boolean', description: 'show which declaration demanded each unit' },
    '--write': { type: 'boolean', description: `write ${GRAPH_FILE}` },
    '--strict': { type: 'boolean', description: 'treat an empty unit as an error' },
    '--check': { type: 'boolean', description: `fail when ${GRAPH_FILE} would change` },
    '--topology': { type: 'string', description: "'separate' (default) or 'single'" },
  });

  const json = boolFlag(args, '--json');
  const topology = stringFlag(args, '--topology');
  if (topology !== undefined && topology !== 'separate' && topology !== 'single') {
    throw new UsageError('--topology must be "separate" or "single"');
  }

  let resolved: Awaited<ReturnType<typeof resolveFromProject>>;
  try {
    resolved = await resolveFromProject(
      cwd,
      topology === 'separate' || topology === 'single' ? { topology } : {},
    );
  } catch (error: unknown) {
    return fail(error, json);
  }

  const { graph, problems } = resolved;
  const snapshotPath = join(resolved.root, GRAPH_FILE);

  const strays = problems.filter((problem) => problem.code !== 'DPL_UNIT_EMPTY');
  const emptyUnits = boolFlag(args, '--strict')
    ? graph.units.filter((unit) => unit.triggers.length === 0)
    : [];

  if (boolFlag(args, '--write')) {
    await writeFile(snapshotPath, serializeGraph(graph), 'utf8');
    info(`  ${style.green('✓')} wrote ${GRAPH_FILE} (${String(graph.units.length)} unit(s))`);
  }

  if (boolFlag(args, '--check')) {
    const committed = existsSync(snapshotPath)
      ? parseGraph(await readFile(snapshotPath, 'utf8'))
      : undefined;
    const diff = committed === undefined ? undefined : diffGraphs(committed, graph);
    if (committed === undefined) {
      info(`  ${style.red('✗')} ${GRAPH_FILE} is missing — run \`tsir deploy:plan --write\``);
      return EXIT.failure;
    }
    if (diff !== undefined && !diff.empty) {
      info(`  ${style.red('✗')} ${GRAPH_FILE} is stale:`);
      info(describeDiff(diff));
      return EXIT.failure;
    }
    info(`  ${style.green('✓')} ${GRAPH_FILE} matches the resolved graph`);
  }

  if (json) {
    info(graphJson(graph, problems).trimEnd());
  } else if (boolFlag(args, '--explain')) {
    info(formatGraph(graph, problems));
    info(explainGraph(graph));
  } else {
    info(formatGraph(graph, problems));
  }

  if (strays.length > 0) return EXIT.failure;
  if (emptyUnits.length > 0) {
    for (const unit of emptyUnits) {
      info(`  ${style.red('✗')} DPL_UNIT_EMPTY · unit "${unit.name}" has no triggers`);
    }
    return EXIT.failure;
  }

  return EXIT.ok;
}

export async function deployDiffCommand(argv: readonly string[]): Promise<number> {
  return diff(argv, process.cwd());
}

/** The drift check, at a project root. */
export async function diff(argv: readonly string[], cwd: string): Promise<number> {
  const args = parseArgs(argv, {
    '--json': { type: 'boolean', description: 'machine-readable diff' },
  });
  const json = boolFlag(args, '--json');

  let resolved: Awaited<ReturnType<typeof resolveFromProject>>;
  try {
    resolved = await resolveFromProject(cwd);
  } catch (error: unknown) {
    return fail(error, json);
  }

  const snapshotPath = join(resolved.root, GRAPH_FILE);
  if (!existsSync(snapshotPath)) {
    const message = `${GRAPH_FILE} is missing — run \`tsir deploy:plan --write\` to create it`;
    if (json) info(jsonDocument({ ok: false, message }));
    else info(`  ${style.red('✗')} ${message}`);
    return EXIT.failure;
  }

  const committed = parseGraph(await readFile(snapshotPath, 'utf8'));
  const diff = diffGraphs(committed, resolved.graph);

  if (json) {
    info(
      jsonDocument({
        ok: diff.empty,
        added: diff.added,
        removed: diff.removed,
        changed: diff.changed,
        problems: resolved.problems,
      }),
    );
  } else if (diff.empty) {
    ok(`  ${style.green('✓')} ${GRAPH_FILE} matches the resolved graph`);
  } else {
    info(`  ${style.yellow('~')} ${GRAPH_FILE} drift:`);
    info(describeDiff(diff));
  }

  return diff.empty ? EXIT.ok : EXIT.failure;
}

/* ── deploy:invoke (`DPL-007`) ──────────────────────────────────────────────────── */

/** The handler the entry module must export for `deploy:invoke` to have something to run. */
export interface EntryHandlers {
  readonly handler?: (request: Request) => Promise<Response>;
  readonly unit?: string | undefined;
}

/** `:id` matches one segment; everything else is literal. */
export function matchesRoutePath(pattern: string, path: string): boolean {
  const patternSegments = pattern.split('/').filter((segment) => segment !== '');
  const pathSegments = path.split('/').filter((segment) => segment !== '');
  if (patternSegments.length !== pathSegments.length) return false;

  return patternSegments.every((segment, index) => {
    const actual = pathSegments[index];
    if (actual === undefined) return false;
    return segment.startsWith(':') ? actual !== '' : segment === actual;
  });
}

export interface InvokeOptions {
  readonly unit: string;
  readonly method?: string | undefined;
  readonly path?: string | undefined;
  readonly body?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export interface InvokeResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** The unit that owns the matched route, when the path matches one. */
  readonly routeUnit: string | undefined;
  readonly route: string | undefined;
}

/**
 * Invoke one unit locally (`DPL-007`).
 *
 * It calls the *entry's* `handler` — the same function a Worker or a Lambda would call —
 * rather than constructing a second, test-only pipeline. That is the whole value: an
 * invocation that ran through a different path would prove nothing about the deployed one.
 *
 * What it adds on top of "call a function" is attribution: the compiled route table says
 * which unit owns `GET /api/users`, so asking to invoke `media` and getting a `http` route
 * is reported instead of silently succeeding.
 */
export async function invokeUnit(
  project: LoadedProject,
  options: InvokeOptions,
  handlers: EntryHandlers,
): Promise<InvokeResult> {
  const handler = handlers.handler;
  if (handler === undefined) {
    throw new UsageError(
      `the application entry exports no handler — add \`export const handler = createFetchHandler(...)\``,
    );
  }

  const method = (options.method ?? 'GET').toUpperCase();
  const path = options.path ?? '/';
  const { graph } = buildGraph(deploymentOf(project), { targets: targetsOf(project) });
  const unit = graph.units.find((candidate) => candidate.name === options.unit);
  if (unit === undefined) {
    throw new UsageError(
      `unknown unit "${options.unit}" — this project resolves ${graph.units.map((candidate) => candidate.name).join(', ') || 'no units'}`,
    );
  }

  const route = compileRoutes(collectRouteEntries()).routes.find(
    (candidate) => candidate.method === method && matchesRoutePath(candidate.path, path),
  );

  const headers = new Headers(options.headers ?? {});
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    init.body = options.body;
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }

  const response = await handler(new Request(`http://localhost${path}`, init));
  const outHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    outHeaders[name] = value;
  });

  return {
    status: response.status,
    headers: outHeaders,
    body: await response.text(),
    routeUnit: route?.meta.unit,
    route: route === undefined ? undefined : `${route.method} ${route.path}`,
  };
}

export async function deployInvokeCommand(argv: readonly string[]): Promise<number> {
  return invoke(argv, process.cwd());
}

/** `deploy:invoke --unit http --method GET --path /api/users` (`DPL-007`). */
export async function invoke(argv: readonly string[], cwd: string): Promise<number> {
  const args = parseArgs(argv, {
    '--unit': { type: 'string', description: 'unit to invoke' },
    '--method': { type: 'string', description: 'HTTP method (default GET)' },
    '--path': { type: 'string', description: 'request path (default /)' },
    '--body': { type: 'string', description: 'request body' },
    '--header': { type: 'string', description: 'repeatable "Name: value"' },
    '--json': { type: 'boolean', description: 'machine-readable result' },
    '--explain': { type: 'boolean', description: 'also print which unit owns the route' },
  });

  const unit = stringFlag(args, '--unit');
  if (unit === undefined) throw new UsageError('deploy:invoke needs --unit <name>');

  const json = boolFlag(args, '--json');

  let result: InvokeResult;
  try {
    const { project, input } = await loadDeployInput(cwd);
    const graph = buildGraph(input, { targets: targetsOf(project) }).graph;
    if (!graph.units.some((candidate) => candidate.name === unit)) {
      return fail(
        new UsageError(
          `unknown unit "${unit}" — this project resolves ${graph.units.map((c) => c.name).join(', ') || 'no units'}`,
        ),
        json,
      );
    }

    // The entry's own handler: the same function a Worker or a Lambda calls.
    const entry = (await import(
      `${pathToFileURL(join(project.root, project.config.app.entry)).href}?t=${String(Date.now())}`
    )) as { handler?: (request: Request) => Promise<Response> };
    if (typeof entry.handler !== 'function') {
      throw new UsageError(
        'the application entry exports no `handler` — export one (`createFetchHandler({ routes })`) so a deploy can call what the platform calls',
      );
    }

    result = await invokeUnit(
      project,
      {
        unit,
        ...(stringFlag(args, '--method') === undefined
          ? {}
          : { method: stringFlag(args, '--method') }),
        ...(stringFlag(args, '--path') === undefined ? {} : { path: stringFlag(args, '--path') }),
        ...(stringFlag(args, '--body') === undefined ? {} : { body: stringFlag(args, '--body') }),
        headers: parseHeaders(argv),
      },
      { handler: entry.handler },
    );
  } catch (error: unknown) {
    return fail(error, json);
  }

  if (json) {
    info(jsonDocument({ unit, ...result }));
    return result.status >= 500 ? EXIT.failure : EXIT.ok;
  }

  info(`  ${style.bold(`${String(result.status)}`)} ${result.headers['content-type'] ?? ''}`);
  info(result.body === '' ? '  (empty body)' : result.body);
  if (boolFlag(args, '--explain')) {
    info(
      result.route === undefined
        ? `  ${style.dim('no compiled route matches this request')}`
        : `  ${style.dim(`route ${result.route} belongs to unit "${result.routeUnit ?? 'http'}"`)}`,
    );
    if (result.routeUnit !== undefined && result.routeUnit !== unit) {
      warn(`asked for unit "${unit}" but this route belongs to "${result.routeUnit}"`);
    }
  }

  return result.status >= 500 ? EXIT.failure : EXIT.ok;
}

/** `--header "Authorization: Bearer x"`, repeatable. */
function parseHeaders(argv: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== '--header') continue;
    const raw = argv[index + 1];
    if (raw === undefined) continue;
    const separator = raw.indexOf(':');
    if (separator <= 0) continue;
    headers[raw.slice(0, separator).trim().toLowerCase()] = raw.slice(separator + 1).trim();
  }
  return headers;
}
