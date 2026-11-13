/**
 * The unit model (`DPL-001`) and topology resolution (`DPL-002`).
 *
 * A **unit** is the atom of deployment, and it is derived from what the application
 * *declares* — routes, sockets, queue consumers, cron tasks, connections — never from how
 * the source tree happens to be laid out. That distinction is
 * the whole design: moving a controller between folders must not change the deploy shape,
 * while adding a route to the `admin` unit must.
 *
 * Two rules are worth stating before the code, because both are easy to get wrong in a way
 * that only shows up in production:
 *
 *   · **`separate` is the default and `single` is opt-in** (`DPL-002`). A framework that
 *     quietly merges everything into one function saves the developer a decision and costs
 *     them cold starts, blast radius and least-privilege bindings.
 *   · **Every unit carries its reason.** `Unit.reasons` records *which declaration* put a
 *     unit in the graph — a route, a socket path, an explicit `deploy.units` entry, a
 *     connection's journal. `deploy:plan --explain` prints them, so "why is there a
 *     `queue` unit?" is answered by the build rather than by archaeology.
 */

import type { Capability, TsirError } from '@tsir/core';
import { parseCron, toUtcCron } from '@tsir/schedule';

import { cronInvalid, cronNotUtc } from './errors.ts';
import { triggersForConnection, type QueueConnectionInput } from './queue-triggers.ts';

/** The six kinds, minus `console` (never deployed). */
export type UnitKind = 'http' | 'ws' | 'queue' | 'schedule' | 'admin' | 'migrate';

export const UNIT_KINDS: readonly UnitKind[] = [
  'http',
  'ws',
  'queue',
  'schedule',
  'admin',
  'migrate',
];

/** How a unit is reached. A unit may have more than one (an HTTP unit with a cron warm-up). */
export type TriggerKind =
  'http' | 'websocket' | 'queue' | 'cron' | 'sns' | 'eventbridge' | 'manual';

export interface UnitTrigger {
  readonly kind: TriggerKind;
  /** Route paths, socket paths, queue names, cron expressions — sorted, deduplicated. */
  readonly detail: readonly string[];
}

/**
 * Why a unit exists.
 *
 * `source` is the declaration that demanded it (`routes`, `sockets`, `connections`, …)
 * and `from` is the specific one (`GET /api/users`, `primary`, `deploy.units.warm`). The
 * identifiers are stable strings rather than object references so the reason survives
 * serialization into `unit-graph.json` — a reason you cannot commit is a comment.
 */
export interface UnitReason {
  readonly source:
    'routes' | 'sockets' | 'queues' | 'schedules' | 'listeners' | 'connections' | 'override';
  readonly from: string;
}

/**
 * A binding a unit needs, in target-neutral terms. The Workers and Lambda emitters
 * translate these (`hyperdrive` → `[[hyperdrive]]`, `queue` → `[[queues.producers]]`, …),
 * and `DPL_BINDING_MISSING` is raised when a unit needs one the target never declared.
 */
export interface BindingRef {
  readonly kind: BindingKind;
  /** The binding name the runtime sees: `HYPERDRIVE`, `JOBS`, `ORDERS_QUEUE`. */
  readonly name: string;
  /** What this binding is for — printed by `deploy:plan`, used by the emitters. */
  readonly resource?: string | undefined;
}

export type BindingKind =
  'hyperdrive' | 'queue' | 'kv' | 'r2' | 'd1' | 'durable-object' | 'secret' | 'var';

/** A deployable unit: everything the emitters and the checks need, and nothing else. */
export interface Unit {
  /** `http`, `ws`, `admin`, `migrate:<connection>` — unique within the graph. */
  readonly name: string;
  readonly kind: UnitKind;
  /** Modules whose code ships in this unit. Sorted; used for attribution and for `--explain`. */
  readonly modules: readonly string[];
  readonly reasons: readonly UnitReason[];
  readonly triggers: readonly UnitTrigger[];
  /** Union of the capability requirements of `modules`, sorted. */
  readonly requires: readonly Capability[];
  readonly bindings: readonly BindingRef[];
  /**
   * Whether the unit may be reached from the public internet. `admin` defaults to private
   * (`DPL-022`): health and metrics on a public route is how an internal dashboard becomes
   * a public one.
   */
  readonly private: boolean;
  /**
   * Per-unit memory in MiB. When set, overrides the shared `deploy.memoryMb`
   * default in the generated SAM template (`DPL-031`).
   */
  readonly memoryMb?: number | undefined;
  /**
   * Per-unit timeout in seconds. When set, overrides the shared
   * `deploy.timeoutSeconds` default in the generated SAM template (`DPL-031`).
   */
  readonly timeoutSeconds?: number | undefined;
}

/* ── inputs ─────────────────────────────────────────────────────────────────────── */

export interface RouteInput {
  readonly method: string;
  readonly path: string;
  /** From `route.meta.unit` (RTR-011); `http` when the controller did not say. */
  readonly unit?: string | undefined;
  /** Module that owns the route, when the app declares modules. */
  readonly module?: string | undefined;
}

export interface SocketInput {
  readonly path: string;
  readonly unit?: string | undefined;
  readonly module?: string | undefined;
}

export interface QueueInput {
  readonly name: string;
  readonly unit?: string | undefined;
  readonly module?: string | undefined;
}

export interface ScheduleInput {
  /** Cron expression, in the platform's five-field form — **local** when an offset is set. */
  readonly cron: string;
  readonly name: string;
  readonly unit?: string | undefined;
  readonly module?: string | undefined;
  /**
   * The task's fixed offset from UTC (`defineTask({ utcOffsetMinutes })`).
   *
   * Platform crons fire in UTC, so the declared expression is shifted before it becomes a
   * trigger (`toUtcCron`) — and a shift the platform cannot express is `DPL_CRON_NOT_UTC`
   * rather than a task that fires an hour off (`§ 4.6`).
   */
  readonly utcOffsetMinutes?: number | undefined;
}

export interface ConnectionInput {
  /** The connection name from ADR-0019 (`primary`, `analytics`, …). */
  readonly name: string;
  /** Whether migrations run for this connection — every journaled connection gets a unit. */
  readonly journal?: boolean | undefined;
  readonly bindings?: readonly BindingRef[] | undefined;
}

/**
 * An AWS event-source listener declared with `@OnSns`/`@OnEventBridge`/`@OnStepTask` (DPL-026). */
export interface ListenerInput {
  readonly kind: 'sns' | 'eventbridge' | 'steptask';
  /** SNS topic name, EventBridge event bus, or Step Functions task name. */
  readonly name: string;
  /** EventBridge detail-type filter (eventbridge only). */
  readonly detailType?: string | undefined;
  readonly unit?: string | undefined;
  readonly module?: string | undefined;
}

export interface ModuleInput {
  readonly name: string;
  /** From `defineModule({ requires })` (APP-010). */
  readonly requires?: readonly Capability[] | undefined;
  /** Bindings the module's code expects — checked per unit, not per module. */
  readonly bindings?: readonly BindingRef[] | undefined;
}

/** An explicit unit from `tsir.js` (`deploy.units`): the escape hatch, and the only way
 *  to declare a unit this version cannot discover yet (a queue consumer before phase 7). */
export interface UnitOverride {
  readonly name: string;
  readonly kind: UnitKind;
  readonly triggers?: readonly UnitTrigger[] | undefined;
  readonly modules?: readonly string[] | undefined;
  readonly requires?: readonly Capability[] | undefined;
  readonly bindings?: readonly BindingRef[] | undefined;
  readonly private?: boolean | undefined;
  readonly memoryMb?: number | undefined;
  readonly timeoutSeconds?: number | undefined;
}

export interface DeployOptions {
  readonly topology?: 'separate' | 'single' | undefined;
  readonly units?: readonly UnitOverride[] | undefined;
  /** Modules to load into the graph even though nothing references them (rare, explicit). */
  readonly includeModules?: readonly string[] | undefined;
  /**
   * SNS topics this app publishes to (`DPL-030`). Each must have a matching `@OnSns({ topic })`
   * listener in the graph; a publish to an undeclared topic is a build failure so the message never
   * disappears into a topic nobody reads.
   */
  readonly publishes?: readonly string[] | undefined;
  /**
   * Step Functions tasks this app invokes internally (`DPL-030`). Each must have a matching
   * `@OnStepTask({ name })` listener; an invoke to an unknown task is a build failure.
   */
  readonly invokes?: readonly { readonly unit: string; readonly task: string }[] | undefined;
}

export interface DeploymentInput {
  readonly appName: string;
  /**
   * `queue.connections` (`CAP-004`): one unit per connection, named `queue:<name>`, with the
   * trigger its driver and target give it. Absent means "this project declares no queue".
   */
  readonly queue?: readonly QueueConnectionInput[] | undefined;
  /**
   * Whether the application exports an events registry (`@tsir/events`, `§ 4.5`). It is the
   * writer a declared outbox needs; without it `outbox: true` is a promise with no one behind it.
   */
  readonly events?: boolean | undefined;
  readonly routes?: readonly RouteInput[] | undefined;
  readonly sockets?: readonly SocketInput[] | undefined;
  readonly queues?: readonly QueueInput[] | undefined;
  readonly schedules?: readonly ScheduleInput[] | undefined;
  readonly listeners?: readonly ListenerInput[] | undefined;
  readonly connections?: readonly ConnectionInput[] | undefined;
  readonly modules?: readonly ModuleInput[] | undefined;
  readonly deploy?: DeployOptions | undefined;
}

/* ── resolution ─────────────────────────────────────────────────────────────────── */

/**
 * A declared schedule as the expression the platform can fire — or the reason it cannot.
 *
 * Returned rather than thrown so `resolveUnits` stays total (a graph is still describable when
 * one trigger is wrong) and `buildGraph` can report every bad schedule at once instead of dying
 * on the first. Every emitter downstream reads the trigger verbatim, so this is the one place
 * the translation happens.
 */
function platformCron(
  schedule: ScheduleInput,
): { readonly cron: string } | { readonly error: TsirError; readonly unit: string } {
  const unit = schedule.unit ?? 'schedule';
  try {
    return {
      cron: toUtcCron(
        parseCron(schedule.cron, {
          ...(schedule.utcOffsetMinutes === undefined
            ? {}
            : { utcOffsetMinutes: schedule.utcOffsetMinutes }),
          origin: `schedule "${schedule.name}"`,
        }),
      ),
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      unit,
      error:
        schedule.utcOffsetMinutes === undefined || schedule.utcOffsetMinutes === 0
          ? cronInvalid({ unit, expression: schedule.cron, detail })
          : cronNotUtc({
              name: schedule.name,
              expression: schedule.cron,
              utcOffsetMinutes: schedule.utcOffsetMinutes,
              detail,
            }),
    };
  }
}

/** The schedule triggers a build refuses, in declaration order. */
export function checkSchedules(
  schedules: readonly ScheduleInput[],
): readonly { readonly unit: string; readonly error: TsirError }[] {
  const problems: { readonly unit: string; readonly error: TsirError }[] = [];
  for (const schedule of schedules) {
    const resolved = platformCron(schedule);
    if ('error' in resolved) problems.push({ unit: resolved.unit, error: resolved.error });
  }
  return problems;
}

export const DEFAULT_TOPOLOGY = 'separate' as const;

/** The unit a declaration lands in when it does not say: by kind, `http` for routes. */
function unitNameFor(kind: UnitKind, requested: string | undefined): string {
  return requested ?? kind;
}

interface Draft {
  readonly name: string;
  readonly kind: UnitKind;
  readonly modules: Set<string>;
  readonly reasons: UnitReason[];
  readonly triggerDetails: Map<TriggerKind, Set<string>>;
  requires: Set<Capability>;
  bindings: Map<string, BindingRef>;
  private: boolean;
  memoryMb?: number;
  timeoutSeconds?: number;
}

function draftFor(drafts: Map<string, Draft>, name: string, kind: UnitKind): Draft {
  const existing = drafts.get(name);
  if (existing !== undefined) return existing;

  const draft: Draft = {
    name,
    kind,
    modules: new Set(),
    reasons: [],
    triggerDetails: new Map(),
    requires: new Set(),
    bindings: new Map(),
    // `admin` is private unless an override says otherwise (`DPL-022`). A `migrate` unit is
    // private for a stronger reason: it has no network surface at all — it is a script.
    private: kind === 'admin' || kind === 'migrate',
  };
  drafts.set(name, draft);
  return draft;
}

function noteTrigger(draft: Draft, kind: TriggerKind, detail: string): void {
  const set = draft.triggerDetails.get(kind) ?? new Set<string>();
  set.add(detail);
  draft.triggerDetails.set(kind, set);
}

function moduleOf(input: DeploymentInput, name: string | undefined): ModuleInput | undefined {
  if (name === undefined) return undefined;
  return input.modules?.find((module) => module.name === name);
}

function absorb(draft: Draft, input: DeploymentInput, moduleName: string | undefined): void {
  if (moduleName === undefined) return;
  draft.modules.add(moduleName);

  const module = moduleOf(input, moduleName);
  for (const capability of module?.requires ?? []) draft.requires.add(capability);
  for (const binding of module?.bindings ?? []) draft.bindings.set(binding.name, binding);
}

/** `migrate:<connection>` — one unit per journaled connection (ADR-0019). */
function migrationUnitName(connection: string): string {
  return `migrate:${connection}`;
}

/**
 * Resolve the graph's units from the declarations.
 *
 * Deterministic by construction: every collection is sorted before it leaves this
 * function, so two builds of the same input produce byte-identical JSON — which is what
 * makes the committed snapshot (`DPL-004`) and its drift check meaningful.
 */
export function resolveUnits(input: DeploymentInput): readonly Unit[] {
  const drafts = new Map<string, Draft>();

  for (const route of input.routes ?? []) {
    const name = unitNameFor('http', route.unit);
    const draft = draftFor(drafts, name, name === 'admin' ? 'admin' : 'http');
    noteTrigger(draft, 'http', `${route.method} ${route.path}`);
    draft.reasons.push({ source: 'routes', from: `${route.method} ${route.path}` });
    absorb(draft, input, route.module);
  }

  for (const socket of input.sockets ?? []) {
    const name = unitNameFor('ws', socket.unit);
    const draft = draftFor(drafts, name, 'ws');
    noteTrigger(draft, 'websocket', socket.path);
    draft.reasons.push({ source: 'sockets', from: socket.path });
    absorb(draft, input, socket.module);
  }

  for (const queue of input.queues ?? []) {
    const name = unitNameFor('queue', queue.unit);
    const draft = draftFor(drafts, name, 'queue');
    noteTrigger(draft, 'queue', queue.name);
    draft.reasons.push({ source: 'queues', from: queue.name });
    absorb(draft, input, queue.module);
  }

  for (const schedule of input.schedules ?? []) {
    const name = unitNameFor('schedule', schedule.unit);
    const draft = draftFor(drafts, name, 'schedule');
    // The trigger carries the cron the *platform* fires; the reason keeps the one that was
    // declared, so `deploy:plan` shows both and a shift is never invisible. A schedule that
    // cannot be shifted keeps its declared expression here — `checkSchedules` refuses it in
    // `buildGraph`, and a rejected graph is never emitted.
    const resolved = platformCron(schedule);
    const cron = 'cron' in resolved ? resolved.cron : schedule.cron;
    noteTrigger(draft, 'cron', cron);
    draft.reasons.push({
      source: 'schedules',
      from:
        schedule.utcOffsetMinutes === undefined || schedule.utcOffsetMinutes === 0
          ? `${schedule.name} (${schedule.cron})`
          : `${schedule.name} (${schedule.cron} at ${String(schedule.utcOffsetMinutes)} → ${cron})`,
    });
    absorb(draft, input, schedule.module);
  }

  for (const listener of input.listeners ?? []) {
    // SNS and EventBridge listeners are message consumers → `queue` unit kind.
    // Step Functions tasks are manual invokes → `admin` unit kind.
    const defaultUnit = listener.kind === 'steptask' ? 'admin' : 'queue';
    const name = unitNameFor(defaultUnit, listener.unit);
    // One unit per **name**, whatever kind it had. Two listeners on the same controller —
    // `@OnSns({ topic, unit: 'notify' })` and `@OnStepTask({ name, unit: 'notify' })` — are one
    // function with two handlers, which is what `toLambdaHandler` dispatches; resolving the
    // second under a `queue` kind because the first happened to be a `queue` unit is how a
    // single controller turned into three deployed functions with identical bundles.
    const existing = drafts.get(name);
    const kind =
      existing !== undefined
        ? existing.kind
        : name === 'admin' || listener.kind === 'steptask'
          ? 'admin'
          : 'queue';
    const draft = draftFor(drafts, name, kind);
    // The trigger detail carries the topic/bus/task name; `detailType` is folded in for
    // EventBridge so `deploy:plan` shows the full filter without a second source of truth.
    const detail =
      listener.kind === 'eventbridge' && listener.detailType !== undefined
        ? `${listener.name}:${listener.detailType}`
        : listener.name;
    const triggerKind = listener.kind === 'steptask' ? 'manual' : listener.kind;
    noteTrigger(draft, triggerKind, detail);
    draft.reasons.push({ source: 'listeners', from: `${listener.kind}:${listener.name}` });
    absorb(draft, input, listener.module);
  }

  for (const connection of input.connections ?? []) {
    if (connection.journal !== true) {
      // A connection without a journal has no migration unit. A replica that is briefly
      // unreachable must not block the primary's release (ADR-0019), and a unit with
      // nothing to run has no business existing.
      continue;
    }
    const name = migrationUnitName(connection.name);
    const draft = draftFor(drafts, name, 'migrate');
    noteTrigger(draft, 'manual', `migrate:${connection.name}`);
    draft.reasons.push({ source: 'connections', from: connection.name });
    for (const binding of connection.bindings ?? []) draft.bindings.set(binding.name, binding);
  }

  // `queue.connections` (`CAP-004`): a connection is a unit, not a line of configuration. Its
  // trigger is filled in per target later (`queueUnitFor`), because the same connection drains
  // by cron on one target and is handed a batch on another — which is the coupling `§ 4.2`
  // exists to make visible.
  for (const connection of input.queue ?? []) {
    const name = `queue:${connection.name}`;
    const draft = draftFor(drafts, name, 'queue');
    for (const trigger of triggersForConnection(connection)) {
      for (const detail of trigger.detail) noteTrigger(draft, trigger.kind, detail);
    }
    draft.reasons.push({ source: 'queues', from: `${connection.name} (${connection.driver})` });
    // Private by construction: a worker has no request surface to expose.
    draft.private = true;
    absorb(draft, input, connection.module);
  }

  for (const override of input.deploy?.units ?? []) {
    const draft = draftFor(drafts, override.name, override.kind);
    draft.reasons.push({ source: 'override', from: `deploy.units.${override.name}` });
    for (const trigger of override.triggers ?? []) {
      for (const detail of trigger.detail) noteTrigger(draft, trigger.kind, detail);
    }
    for (const moduleName of override.modules ?? []) {
      draft.modules.add(moduleName);
      const module = moduleOf(input, moduleName);
      for (const capability of module?.requires ?? []) draft.requires.add(capability);
      for (const binding of module?.bindings ?? []) draft.bindings.set(binding.name, binding);
    }
    for (const capability of override.requires ?? []) draft.requires.add(capability);
    for (const binding of override.bindings ?? []) draft.bindings.set(binding.name, binding);
    if (override.private !== undefined) draft.private = override.private;
    if (override.memoryMb !== undefined) draft.memoryMb = override.memoryMb;
    if (override.timeoutSeconds !== undefined) draft.timeoutSeconds = override.timeoutSeconds;
  }

  // `deploy.includeModules` is for the one honest case: a module that ships code into a
  // unit nothing else references yet. It is explicit precisely because the alternative —
  // inferring a unit from an unreferenced import — is how a graph grows units nobody meant.
  for (const moduleName of input.deploy?.includeModules ?? []) {
    const module = moduleOf(input, moduleName);
    if (module === undefined) continue;
    const name = moduleName;
    const draft = draftFor(drafts, name, 'http');
    draft.reasons.push({ source: 'override', from: `deploy.includeModules.${moduleName}` });
    draft.modules.add(moduleName);
    for (const capability of module.requires ?? []) draft.requires.add(capability);
    for (const binding of module.bindings ?? []) draft.bindings.set(binding.name, binding);
  }

  const units = [...drafts.values()].map((draft): Unit => ({
    name: draft.name,
    kind: draft.kind,
    modules: [...draft.modules].sort(),
    reasons: dedupeReasons(draft.reasons),
    triggers: [...draft.triggerDetails.entries()]
      .map(([kind, details]): UnitTrigger => ({ kind, detail: [...details].sort() }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),
    requires: [...draft.requires].sort(),
    bindings: [...draft.bindings.values()].sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    ),
    private: draft.private,
    ...(draft.memoryMb !== undefined ? { memoryMb: draft.memoryMb } : {}),
    ...(draft.timeoutSeconds !== undefined ? { timeoutSeconds: draft.timeoutSeconds } : {}),
  }));

  return units.sort((a, b) => a.name.localeCompare(b.name));
}

function dedupeReasons(reasons: readonly UnitReason[]): readonly UnitReason[] {
  const seen = new Set<string>();
  const out: UnitReason[] = [];
  for (const reason of reasons) {
    const key = `${reason.source}\u0000${reason.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reason);
  }
  return out.sort((a, b) => a.source.localeCompare(b.source) || a.from.localeCompare(b.from));
}

/* ── topology (`DPL-002`) ───────────────────────────────────────────────────────── */

export interface TopologyResolution {
  readonly topology: 'separate' | 'single';
  /** The units that will actually be emitted, after the topology is applied. */
  readonly units: readonly Unit[];
  /** In `single` topology: the units that were merged, in the graph's order. */
  readonly merged: readonly string[];
}

/**
 * Apply the topology.
 *
 * `single` merges every non-`migrate` unit into one `app` unit, keeping the union of
 * triggers, bindings and capabilities. `migrate` stays separate on purpose: a migration
 * that runs inside a request-serving function is a migration that runs on cold start.
 *
 * The merge is *reported* (`merged`) rather than hidden, because `single` is the topology
 * whose cost — bigger bundle, coupled deploys, shared limits — is easiest to forget.
 */
export function applyTopology(
  units: readonly Unit[],
  topology: 'separate' | 'single' = DEFAULT_TOPOLOGY,
): TopologyResolution {
  if (topology === 'separate') {
    return { topology, units: [...units].sort((a, b) => a.name.localeCompare(b.name)), merged: [] };
  }

  const deployable = units.filter((unit) => unit.kind !== 'migrate');
  const migrations = units.filter((unit) => unit.kind === 'migrate');
  if (deployable.length === 0) {
    return { topology, units: [...migrations], merged: [] };
  }

  const merged: Unit = {
    name: 'app',
    kind: 'http',
    modules: [...new Set(deployable.flatMap((unit) => unit.modules))].sort(),
    reasons: dedupeReasons(deployable.flatMap((unit) => unit.reasons)),
    triggers: mergeTriggers(deployable),
    requires: [...new Set(deployable.flatMap((unit) => unit.requires))].sort(),
    bindings: [
      ...new Map(deployable.flatMap((unit) => unit.bindings).map((b) => [b.name, b])).values(),
    ].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    // One public route makes the merged unit public; `single` cannot keep `admin` private,
    // which is exactly the trade `DPL-022` documents.
    private: deployable.every((unit) => unit.private),
  };

  return {
    topology,
    units: [merged, ...migrations].sort((a, b) => a.name.localeCompare(b.name)),
    merged: deployable.map((unit) => unit.name).sort(),
  };
}

function mergeTriggers(units: readonly Unit[]): readonly UnitTrigger[] {
  const details = new Map<TriggerKind, Set<string>>();
  for (const unit of units) {
    for (const trigger of unit.triggers) {
      const set = details.get(trigger.kind) ?? new Set<string>();
      for (const detail of trigger.detail) set.add(detail);
      details.set(trigger.kind, set);
    }
  }
  return [...details.entries()]
    .map(([kind, values]): UnitTrigger => ({ kind, detail: [...values].sort() }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}
