/**
 * The unit graph (`DPL-004`): resolution, validation, serialization and drift.
 *
 * A graph is a *committed artefact*. `unit-graph.json` lives in the repository, `deploy:plan
 * --write` updates it, and every other command compares against it — so a refactor that
 * quietly changes the deploy shape (a route moving from `http` to `admin`, a binding
 * appearing on the queue unit, a new migration unit) shows up as a diff in review instead of
 * as a surprise on the dashboard.
 *
 * Three checks run *before* a graph is considered valid, because each one is a failure that
 * only ever gets more expensive later:
 *
 *   · `DPL_DUPLICATE_ROUTE` — two units claiming `GET /x` means one of them will never
 *     serve it and nobody will notice until a user does.
 *   · `DPL_CAPABILITY_MISSING` — a unit needing `raw-sockets` on Workers fails at build with
 *     the matrix row, not at 3 a.m. with `http2 is not defined`.
 *   · `DPL_BINDING_MISSING` — a unit using `HYPERDRIVE` when the target never declared it is
 *     a runtime `undefined` in the best case and a missing-database incident in the worst.
 */

import { targetCapabilities, type DeployTarget } from '@tsir/core';

import {
  bindingMissing,
  capabilityMissing,
  duplicateRoute,
  invalidDeployConfig,
  invokeUnknown,
  publishUnknown,
  unsupportedTarget,
} from './errors.ts';
import { checkQueueConnections, type QueueConnectionInput } from './queue-triggers.ts';
import {
  applyTopology,
  checkSchedules,
  DEFAULT_TOPOLOGY,
  resolveUnits,
  type DeploymentInput,
  type Unit,
} from './units.ts';

export const GRAPH_SCHEMA_VERSION = 1 as const;
export const GRAPH_FILE = 'unit-graph.json';

export interface TargetConfig {
  readonly target: DeployTarget;
  /** Bindings this target declares, by name. A unit may only use these. */
  readonly bindings?: Readonly<
    Record<string, { readonly kind: string; readonly resource?: string | undefined }>
  >;
  /** Bytes, per unit. Default is the platform's limit, not a number we invented. */
  readonly sizeBudget?: number | undefined;
}

export interface GraphOptions {
  readonly topology?: 'separate' | 'single' | undefined;
  readonly targets?: readonly TargetConfig[] | undefined;
  /**
   * `queue.connections`, so the graph can refuse a connection with no trigger on a chosen
   * target and a non-transactional connection with no outbox (`CAP-004`). Absent means "this
   * project has no queue", which is the honest default for every application so far.
   */
  readonly queue?: readonly QueueConnectionInput[] | undefined;
  /**
   * Whether the app exports an events registry — the writer a declared outbox needs (`§ 4.5`).
   * Mirrored from `DeploymentInput` so `deploy:plan` checks the same thing `deploy:build` does.
   */
  readonly events?: boolean | undefined;
  /**
   * SNS topics this app publishes to (`DPL-030`). Each must have a matching `@OnSns({ topic })`
   * listener; a publish to a topic nobody subscribes to is a build failure.
   */
  readonly publishes?: readonly string[] | undefined;
  /**
   * Step Functions tasks this app invokes internally (`DPL-030`). Each must have a matching
   * `@OnStepTask({ name })` listener in the named unit.
   */
  readonly invokes?: readonly { readonly unit: string; readonly task: string }[] | undefined;
}

export interface UnitGraph {
  readonly schemaVersion: typeof GRAPH_SCHEMA_VERSION;
  readonly app: string;
  readonly topology: 'separate' | 'single';
  readonly merged: readonly string[];
  readonly targets: readonly string[];
  readonly units: readonly Unit[];
}

/** Serialize with sorted keys, so a graph diff is a *semantic* diff. */
export function serializeGraph(graph: UnitGraph): string {
  const ordered = {
    schemaVersion: graph.schemaVersion,
    app: graph.app,
    topology: graph.topology,
    targets: [...graph.targets].sort(),
    merged: [...graph.merged].sort(),
    units: graph.units.map((unit) => ({
      name: unit.name,
      kind: unit.kind,
      private: unit.private,
      modules: unit.modules,
      requires: unit.requires,
      triggers: unit.triggers.map((trigger) => ({ kind: trigger.kind, detail: trigger.detail })),
      bindings: unit.bindings.map((binding) => ({
        kind: binding.kind,
        name: binding.name,
        ...(binding.resource === undefined ? {} : { resource: binding.resource }),
      })),
      reasons: unit.reasons.map((reason) => ({ source: reason.source, from: reason.from })),
    })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export interface GraphChange {
  readonly unit: string;
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

export interface GraphDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly GraphChange[];
  readonly empty: boolean;
}

/** A field-by-field comparison, not a text diff: the point is to *name* what moved. */
export function diffGraphs(before: UnitGraph, after: UnitGraph): GraphDiff {
  const beforeUnits = new Map(before.units.map((unit) => [unit.name, unit]));
  const afterUnits = new Map(after.units.map((unit) => [unit.name, unit]));

  const added = [...afterUnits.keys()].filter((name) => !beforeUnits.has(name)).sort();
  const removed = [...beforeUnits.keys()].filter((name) => !afterUnits.has(name)).sort();
  const changed: GraphChange[] = [];

  const compare = (unit: string, field: string, a: string, b: string): void => {
    if (a !== b) changed.push({ unit, field, before: a, after: b });
  };

  for (const [name, beforeUnit] of beforeUnits) {
    const afterUnit = afterUnits.get(name);
    if (afterUnit === undefined) continue;

    compare(name, 'kind', beforeUnit.kind, afterUnit.kind);
    compare(name, 'visibility', visibility(beforeUnit), visibility(afterUnit));
    compare(name, 'modules', beforeUnit.modules.join(','), afterUnit.modules.join(','));
    compare(name, 'requires', beforeUnit.requires.join(','), afterUnit.requires.join(','));
    compare(
      name,
      'bindings',
      beforeUnit.bindings.map((binding) => binding.name).join(','),
      afterUnit.bindings.map((binding) => binding.name).join(','),
    );
    compare(name, 'triggers', describeTriggers(beforeUnit), describeTriggers(afterUnit));
  }

  if (before.topology !== after.topology) {
    compare('(graph)', 'topology', before.topology, after.topology);
  }

  return {
    added,
    removed,
    changed: changed.sort((a, b) => a.unit.localeCompare(b.unit) || a.field.localeCompare(b.field)),
    empty: added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}

function visibility(unit: Unit): string {
  return unit.private ? 'private' : 'public';
}

function describeTriggers(unit: Unit): string {
  return unit.triggers.map((trigger) => `${trigger.kind}:${trigger.detail.join('|')}`).join(';');
}

export function describeDiff(diff: GraphDiff): string {
  if (diff.empty) return '  no drift\n';
  const lines: string[] = [];
  for (const name of diff.added) lines.push(`  + unit ${name}`);
  for (const name of diff.removed) lines.push(`  - unit ${name}`);
  for (const change of diff.changed) {
    lines.push(`  ~ ${change.unit}.${change.field}: ${change.before} → ${change.after}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Validate a graph against the configured targets.
 *
 * Returns the problems rather than throwing, so `deploy:plan` can print all of them at
 * once — a build that reports one missing binding per run is a build nobody enjoys.
 */
export interface GraphProblem {
  readonly unit: string;
  readonly code: string;
  readonly message: string;
  readonly hint: string;
}

export function checkGraph(
  graph: UnitGraph,
  options: GraphOptions,
  /** From the input, so `deploy:plan` needs no second source for the queue connections. */
  inputQueue: readonly QueueConnectionInput[] = options.queue ?? [],
): readonly GraphProblem[] {
  const problems: GraphProblem[] = [];

  // Duplicate `METHOD /path` across units. The resolver groups by unit, so a duplicate can
  // only be *observed* here, from the trigger lists.
  const claims = new Map<string, string[]>();
  for (const unit of graph.units) {
    for (const trigger of unit.triggers) {
      if (trigger.kind !== 'http') continue;
      for (const route of trigger.detail) {
        claims.set(route, [...(claims.get(route) ?? []), unit.name]);
      }
    }
  }
  for (const [route, units] of claims) {
    if (units.length < 2) continue;
    const [method = 'GET', path = route] = route.split(' ');
    const error = duplicateRoute({ method, path, units });
    problems.push({
      unit: units[1] ?? units[0] ?? '',
      code: error.code,
      message: error.message,
      hint: error.hint ?? '',
    });
  }

  // Queue triggers (`CAP-004`): a connection that cannot run on a target is a graph with a
  // unit that will never be called, and a broker enqueue with no outbox is a message that can
  // be lost quietly. Both are build failures, not warnings.
  problems.push(
    ...checkQueueConnections({
      connections: inputQueue,
      ...(options.events === undefined ? {} : { events: options.events }),
      targets: (options.targets ?? []).map((target) => target.target),
    }),
  );

  for (const target of options.targets ?? []) {
    const capabilities = targetCapabilities(target.target);
    const declared = new Set(Object.keys(target.bindings ?? {}));

    for (const unit of graph.units) {
      for (const capability of unit.requires) {
        if (capabilities.has(capability)) continue;
        const error = capabilityMissing({
          unit: unit.name,
          target: target.target,
          capability,
          demandedBy: unit.modules,
        });
        problems.push({
          unit: unit.name,
          code: error.code,
          message: error.message,
          hint: error.hint ?? '',
        });
      }

      for (const binding of unit.bindings) {
        if (declared.has(binding.name)) continue;
        // A secret or a var is provided by `wrangler secret put` / the IaC template, not by
        // the target's binding map, so its absence there is not an error.
        if (binding.kind === 'secret' || binding.kind === 'var') continue;
        const error = bindingMissing({
          unit: unit.name,
          target: target.target,
          binding: binding.name,
        });
        problems.push({
          unit: unit.name,
          code: error.code,
          message: error.message,
          hint: error.hint ?? '',
        });
      }
    }
  }

  // Internal publish/invoke (`DPL-030`): a `publish(topic, …)` must reach a unit that has an
  // `@OnSns({ topic })` trigger, and an `invokeUnit(unit, task, …)` must reach a unit with an
  // `@OnStepTask({ name: task })` trigger. A typo here is a message that never arrives, which is
  // the worst kind of failure — silent. So it fails the build, not the runtime.
  const snsTopics = new Set<string>();
  const stepTasksByUnit = new Map<string, Set<string>>();
  for (const unit of graph.units) {
    for (const trigger of unit.triggers) {
      if (trigger.kind === 'sns') {
        for (const topic of trigger.detail) snsTopics.add(topic);
      }
      if (trigger.kind === 'manual') {
        const set = stepTasksByUnit.get(unit.name) ?? new Set<string>();
        for (const task of trigger.detail) set.add(task);
        stepTasksByUnit.set(unit.name, set);
      }
    }
  }
  for (const topic of options.publishes ?? []) {
    if (snsTopics.has(topic)) continue;
    const error = publishUnknown({ topic });
    problems.push({
      unit: '',
      code: error.code,
      message: error.message,
      hint: error.hint ?? '',
    });
  }
  for (const { unit, task } of options.invokes ?? []) {
    if (stepTasksByUnit.get(unit)?.has(task) === true) continue;
    const error = invokeUnknown({ unit, task });
    problems.push({
      unit,
      code: error.code,
      message: error.message,
      hint: error.hint ?? '',
    });
  }

  return problems;
}

/** Resolve and validate in one step: what `deploy:plan` and `deploy:build` both need. */
export interface BuildGraphResult {
  readonly graph: UnitGraph;
  readonly problems: readonly GraphProblem[];
}

export function buildGraph(input: DeploymentInput, options: GraphOptions = {}): BuildGraphResult {
  const events = input.events ?? options.events;
  const topology = options.topology ?? input.deploy?.topology ?? DEFAULT_TOPOLOGY;
  if (topology !== 'separate' && topology !== 'single') {
    throw invalidDeployConfig(
      `topology must be "separate" or "single" (got "${String(topology)}")`,
    );
  }

  // A schedule is validated before it is resolved: the trigger carries the *platform's* cron,
  // and a declaration that cannot be written in UTC has to be named as such. Collected here so
  // `deploy:plan` lists every bad schedule rather than throwing on the first.
  const scheduleProblems = checkSchedules(input.schedules ?? []);

  const resolved = applyTopology(resolveUnits(input), topology);
  const graph: UnitGraph = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    app: input.appName,
    topology: resolved.topology,
    merged: resolved.merged,
    targets: (options.targets ?? []).map((target) => target.target).sort(),
    units: resolved.units,
  };

  return {
    graph,
    problems: [
      ...scheduleProblems.map(({ unit, error }) => ({
        unit,
        code: error.code,
        message: error.message,
        hint: error.hint ?? '',
      })),
      ...checkGraph(
        graph,
        {
          ...options,
          topology,
          ...(events === undefined ? {} : { events }),
          ...(input.deploy?.publishes === undefined
            ? {}
            : { publishes: input.deploy.publishes }),
          ...(input.deploy?.invokes === undefined ? {} : { invokes: input.deploy.invokes }),
        },
        input.queue ?? options.queue ?? [],
      ),
    ],
  };
}

/** Parse a committed snapshot. A hand-edited file is a config error, not a crash. */
export function parseGraph(text: string): UnitGraph {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw invalidDeployConfig('unit-graph.json is not valid JSON', {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalidDeployConfig('unit-graph.json must contain an object');
  }
  const graph = raw as Partial<UnitGraph>;
  if (graph.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw invalidDeployConfig(
      `unit-graph.json is schemaVersion ${String(graph.schemaVersion)}; this build writes ${String(GRAPH_SCHEMA_VERSION)}`,
    );
  }
  if (!Array.isArray(graph.units)) {
    throw invalidDeployConfig('unit-graph.json has no units array');
  }

  return graph as UnitGraph;
}

/** `deploy:plan --json` — the graph plus the problems, one document. */
export function graphJson(graph: UnitGraph, problems: readonly GraphProblem[]): string {
  return `${JSON.stringify(
    {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      app: graph.app,
      topology: graph.topology,
      merged: graph.merged,
      targets: graph.targets,
      units: graph.units,
      problems,
    },
    null,
    2,
  )}\n`;
}

/** The human view. Column-aligned, no colour: this output is pasted into issues. */
export function formatGraph(graph: UnitGraph, problems: readonly GraphProblem[] = []): string {
  if (graph.units.length === 0) return '  no units — nothing to deploy\n';

  const nameWidth = Math.max(...graph.units.map((unit) => unit.name.length));
  const lines = graph.units.map((unit) => {
    const triggers = unit.triggers
      .map((trigger) => `${trigger.kind}:${String(trigger.detail.length)}`)
      .join(' ');
    const visibility = unit.private ? 'private' : 'public';
    return (
      `  ${unit.name.padEnd(nameWidth)}  ${unit.kind.padEnd(8)}  ${visibility.padEnd(7)}  ` +
      `${triggers.padEnd(18)}  ${unit.modules.length === 0 ? '-' : unit.modules.join(',')}`
    );
  });

  const header =
    `  ${'unit'.padEnd(nameWidth)}  ${'kind'.padEnd(8)}  ${'exposure'.padEnd(7)}  ` +
    `${'triggers'.padEnd(18)}  modules`;

  const summary =
    `\n  ${String(graph.units.length)} unit(s) · topology ${graph.topology}` +
    (graph.merged.length === 0 ? '' : ` · merged ${graph.merged.join(', ')}`) +
    (graph.targets.length === 0 ? '' : ` · targets ${graph.targets.join(', ')}`);

  const problemBlock =
    problems.length === 0
      ? ''
      : `\n\n${problems
          .map((problem) => `  ✗ ${problem.code} · ${problem.message}\n    ${problem.hint}`)
          .join('\n')}`;

  return `${header}\n${lines.join('\n')}\n${summary}${problemBlock}\n`;
}

/** `deploy:plan --explain` — one unit at a time, with the declarations that demanded it. */
export function explainGraph(graph: UnitGraph): string {
  if (graph.units.length === 0) return '  no units\n';

  const blocks = graph.units.map((unit) => {
    const reasonLines = unit.reasons.map((reason) => `    ${reason.source}: ${reason.from}`);
    const parts = [
      `  ${unit.name} (${unit.kind}${unit.private ? ', private' : ''})`,
      ...(reasonLines.length === 0
        ? ['    (no declaration — declared by deploy.units)']
        : reasonLines),
    ];
    if (unit.requires.length > 0) parts.push(`    requires: ${unit.requires.join(', ')}`);
    if (unit.bindings.length > 0) {
      parts.push(`    bindings: ${unit.bindings.map((b) => `${b.name} (${b.kind})`).join(', ')}`);
    }
    return parts.join('\n');
  });

  return `${blocks.join('\n\n')}\n`;
}

/** Throws when a named target is not configured: the CLI's `--target` path. */
export function assertTarget(configured: readonly TargetConfig[], target: string): TargetConfig {
  const found = configured.find((entry) => entry.target === target);
  if (found === undefined) {
    throw unsupportedTarget(
      target,
      configured.map((entry) => entry.target),
    );
  }
  return found;
}
