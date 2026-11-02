/**
 * The deploy error set.
 *
 * Every code below is a **build** failure, not a runtime one, and that shapes the
 * messages: the reader is a developer looking at a terminal, and they need the unit, the
 * binding or the capability that caused it, plus the one-line fix. A deploy that fails at
 * `wrangler deploy` with a cryptic platform error has already cost more than this file.
 *
 * The `kind: 'deploy'` on every error is what lets the CLI print a plan-shaped failure
 * (`--json` emits `{ error: { code, message, context } }`) instead of a stack trace.
 */

import { TsirError, type TsirErrorInit } from '@tsir/core';

export type DeployErrorCode =
  | 'DPL_CAPABILITY_MISSING'
  | 'DPL_UNIT_EMPTY'
  | 'DPL_EVENT_UNRECOGNISED'
  | 'DPL_DUPLICATE_ROUTE'
  | 'DPL_BINDING_MISSING'
  | 'DPL_SECRET_LEAK'
  | 'DPL_SIZE_BUDGET'
  | 'DPL_GRAPH_DRIFT'
  | 'DPL_UNSUPPORTED_TARGET'
  | 'DPL_ENV_LIMIT'
  | 'DPL_PRIVATE_EXPOSED'
  | 'DPL_CLASS_MISSING'
  | 'DPL_CONFIG_INVALID'
  | 'DPL_QUEUE_TRIGGER_MISSING'
  | 'DPL_QUEUE_OUTBOX_MISSING'
  | 'DPL_EVENTS_OUTBOX_MISSING'
  | 'DPL_CRON_INVALID'
  | 'DPL_CRON_NOT_UTC'
  | 'DPL_LISTENER_NOT_FOUND'
  | 'DPL_PUBLISH_UNKNOWN'
  | 'DPL_INVOKE_UNKNOWN';

function deployError(
  code: DeployErrorCode,
  message: string,
  hint: string,
  context: TsirErrorInit['context'] = {},
): TsirError {
  return new TsirError(code, message, { kind: 'deploy', hint, context });
}

/**
 * A unit needs something the target does not have.
 *
 * The message names the matrix row — `cloudflare: raw-sockets` — because that is the
 * phrase the capability matrix and the deploy targets both use, and a reader who
 * sees the same words in the docs and the build output stops looking for a second source
 * of truth.
 */
export function capabilityMissing(input: {
  readonly unit: string;
  readonly target: string;
  readonly capability: string;
  readonly demandedBy: readonly string[];
}): TsirError {
  const by = input.demandedBy.length === 0 ? '' : ` (required by ${input.demandedBy.join(', ')})`;
  return deployError(
    'DPL_CAPABILITY_MISSING',
    `unit "${input.unit}" needs "${input.capability}"${by}, which target ${input.target} does not have`,
    `drop the module from this unit, choose a target that has the capability, or enable it in the target config`,
    { unit: input.unit, target: input.target, capability: input.capability },
  );
}

/** A unit resolved to no handlers: a typo in `deploy.units`, or a module that never landed. */
export function unitEmpty(unit: string, hint: string): TsirError {
  return deployError('DPL_UNIT_EMPTY', `unit "${unit}" resolved with no handlers`, hint, { unit });
}

/** Two units claim the same `METHOD /path`. */
export function duplicateRoute(input: {
  readonly method: string;
  readonly path: string;
  readonly units: readonly string[];
}): TsirError {
  return deployError(
    'DPL_DUPLICATE_ROUTE',
    `${input.method} ${input.path} is claimed by ${input.units.join(' and ')}`,
    'a route belongs to exactly one unit — set `unit` on one of the controllers, or move it',
    { path: input.path, method: input.method },
  );
}

/** A unit references a binding its target never declared. */
export function bindingMissing(input: {
  readonly unit: string;
  readonly target: string;
  readonly binding: string;
}): TsirError {
  return deployError(
    'DPL_BINDING_MISSING',
    `unit "${input.unit}" uses binding "${input.binding}", which ${input.target} does not declare`,
    `declare it under deploy.targets.${input.target}.bindings.${input.binding}, or stop using it in this unit`,
    { unit: input.unit, target: input.target, binding: input.binding },
  );
}

/** A unit's bundle exceeds its budget. */
export function sizeBudget(input: {
  readonly unit: string;
  readonly bytes: number;
  readonly budget: number;
}): TsirError {
  return deployError(
    'DPL_SIZE_BUDGET',
    `unit "${input.unit}" is ${String(input.bytes)} B, over the ${String(input.budget)} B budget`,
    'split the unit, drop a dependency, or raise deploy.targets.<target>.sizeBudget with a reason',
    { unit: input.unit, bytes: input.bytes, budget: input.budget },
  );
}

/** The committed graph snapshot and the resolved graph disagree. */
export function graphDrift(path: string, detail: string): TsirError {
  return deployError(
    'DPL_GRAPH_DRIFT',
    `unit graph differs from ${path}: ${detail}`,
    'review the change, then run `tsir deploy:plan --write` to accept it',
    { path },
  );
}

/** An artifact carries something that looks like a secret value. */
export function secretLeak(input: { readonly file: string; readonly pattern: string }): TsirError {
  return deployError(
    'DPL_SECRET_LEAK',
    `${input.file} contains a value matching ${input.pattern}`,
    'secrets are bindings, not strings: `wrangler secret put` on Workers, Secrets Manager on Lambda',
    { file: input.file, pattern: input.pattern },
  );
}

/** A target was named that the project does not configure. */
export function unsupportedTarget(target: string, configured: readonly string[]): TsirError {
  return deployError(
    'DPL_UNSUPPORTED_TARGET',
    `target "${target}" is not configured`,
    configured.length === 0
      ? 'add a deploy.targets block to tsir.js'
      : `configured targets: ${configured.join(', ')}`,
    { target, configured: configured.join(',') },
  );
}

/** Lambda caps environment size; Workers caps var count. */
export function envLimit(input: {
  readonly target: string;
  readonly count: number;
  readonly bytes: number;
  readonly maxCount: number;
  readonly maxBytes: number;
}): TsirError {
  return deployError(
    'DPL_ENV_LIMIT',
    `target ${input.target} would receive ${String(input.count)} env vars / ${String(input.bytes)} B` +
      ` (limit ${String(input.maxCount)} / ${String(input.maxBytes)} B)`,
    'move long values into a secret store and pass a reference; env is for configuration, not payloads',
    { target: input.target, count: input.count, bytes: input.bytes },
  );
}

/**
 * A Durable Object binding names a class the bundle does not export (`DPL-010`).
 *
 * `wrangler.toml` says `class_name = "Room"`; the runtime then looks for `Room` among the
 * bundle's exports at deploy time and fails with a message about a missing entrypoint.
 * Naming it here, at build time, is the difference between a one-line fix and a bisect.
 */
export function classMissing(input: {
  readonly unit: string;
  readonly className: string;
  readonly binding: string;
}): TsirError {
  return deployError(
    'DPL_CLASS_MISSING',
    `unit "${input.unit}" binds Durable Object "${input.binding}" to class "${input.className}", which the bundle does not export`,
    `export it from the application entry (\`export { ${input.className} } from …\`) — the binding only names a class; the bundle has to contain it`,
    { unit: input.unit, className: input.className, binding: input.binding },
  );
}

/**
 * A private unit's artifact is publicly routable (`DPL-022`).
 *
 * The graph said `private: true` and the generated config says otherwise, which means
 * either the artifacts are stale or somebody edited them. Both are the failure the flag
 * exists to prevent — health and metrics do not become public because a config file drifted.
 */
export function privateExposed(input: {
  readonly unit: string;
  readonly target: string;
  readonly detail: string;
}): TsirError {
  return deployError(
    'DPL_PRIVATE_EXPOSED',
    `unit "${input.unit}" is private, but its ${input.target} artifact ${input.detail}`,
    'regenerate with `tsir deploy:build`; a public health endpoint is a decision — set `private: false` on the unit in tsir.js',
    { unit: input.unit, target: input.target },
  );
}

/** `tsir.js` declared a deploy block this version cannot read. */
export function invalidDeployConfig(
  reason: string,
  context: TsirErrorInit['context'] = {},
): TsirError {
  return deployError(
    'DPL_CONFIG_INVALID',
    `invalid deploy config: ${reason}`,
    'see the `deploy` block in tsir.js for the accepted shape',
    context,
  );
}

/**
 * A queue connection with no way to run on the chosen target (`CAP-004`).
 *
 * The message names the **cell** of the § 4.2 table — connection, driver, target — because
 * "no trigger" is a fact and "`default` (cloudflare-queues) cannot run on `lambda`" is a
 * decision someone can make.
 */
export function queueTriggerMissing(input: {
  readonly connection: string;
  readonly driver: string;
  readonly target: string;
  readonly supported: readonly string[];
}): TsirError {
  const elsewhere =
    input.supported.length === 0
      ? 'the driver has no trigger on any deploy target'
      : `it runs on ${input.supported.join(', ')}`;
  return deployError(
    'DPL_QUEUE_TRIGGER_MISSING',
    `queue connection "${input.connection}" uses driver "${input.driver}", which ${input.target} cannot trigger — ${elsewhere}`,
    `declare the connection for a target that can run it, or switch the driver for ${input.target}`,
    { connection: input.connection, driver: input.driver, target: input.target },
  );
}

/**
 * A non-transactional driver with no outbox (`CAP-004`, `§ 4.2`).
 *
 * The failure this prevents is not a crash: it is an order that committed with no receipt job,
 * or a receipt job for an order that rolled back. Neither is recoverable after the fact, which
 * is why the build refuses instead of warning.
 */
export function queueOutboxMissing(input: {
  readonly connection: string;
  readonly driver: string;
}): TsirError {
  return deployError(
    'DPL_QUEUE_OUTBOX_MISSING',
    `queue connection "${input.connection}" uses driver "${input.driver}", which cannot enqueue inside your write, and declares no outbox`,
    `set \`queue.connections.${input.connection}.outbox: true\` and write the job to the outbox in the same \`batch()\` as the business row`,
    { connection: input.connection, driver: input.driver },
  );
}

/**
 * An outbox nothing writes (`§ 4.2`, `§ 4.5`).
 *
 * `outbox: true` says "this connection's deliveries are written in the caller's batch". It does
 * not make that true: the writer is `@tsir/events`' publisher, and a project that declares the
 * outbox without exporting an events registry has declared a table nobody fills. The failure it
 * prevents is worse than a missing outbox — the declaration says the delivery is durable, and it is not.
 */
export function eventsOutboxMissing(input: {
  readonly connection: string;
  readonly driver: string;
}): TsirError {
  return deployError(
    'DPL_EVENTS_OUTBOX_MISSING',
    `queue connection "${input.connection}" (${input.driver}) declares an outbox, but this project exports no events registry to write it`,
    'export `events` from the app entry (createEvents(…) + createPublisher(…)) and publish through `publisher.record(…)` in the same `batch()` as the business row',
    { connection: input.connection, driver: input.driver },
  );
}

/**
 * A cron trigger the runtime would read differently from the platform (`§ 4.6`).
 *
 * The graph carries crons from two places — the tasks a project declares and `deploy.units` in
 * `tsir.js` — and only the first of them is parsed by `defineTask`. Validating both here is what
 * stops a hand-written `0 0 1 * 1` from reaching a Worker (where it means OR) and a Lambda (where
 * EventBridge keeps one day and drops the other).
 */
export function cronInvalid(input: {
  readonly unit: string;
  readonly expression: string;
  readonly detail: string;
}): TsirError {
  // The parser's own message already names the expression; keeping its second half keeps the
  // build error to one line instead of saying "invalid cron … invalid cron …".
  const reason = input.detail.replace(/^invalid cron "[^"]*"(\([^)]*\))?: /u, '');
  return deployError(
    'DPL_CRON_INVALID',
    `unit "${input.unit}" declares the cron "${input.expression}", which does not parse: ${reason}`,
    'fix the expression, or declare the task with `defineTask` so the error names it where it is written',
    { unit: input.unit, expression: input.expression },
  );
}

/**
 * A schedule whose local hour cannot be written as a platform cron (`§ 4.6`).
 *
 * `0 3 1 * *` at UTC+8 is the 1st of the month in Manila and the last day of the previous one in
 * UTC; a half-hour offset over a set of minutes is a rotation EventBridge cannot express. Both
 * are refusals rather than approximations, because the alternative is a billing run on the wrong
 * day — discovered a month later, by a customer.
 */
export function cronNotUtc(input: {
  readonly name: string;
  readonly expression: string;
  readonly utcOffsetMinutes: number;
  readonly detail: string;
}): TsirError {
  return deployError(
    'DPL_CRON_NOT_UTC',
    `schedule "${input.name}" fires at "${input.expression}" at utcOffsetMinutes ` +
      `${String(input.utcOffsetMinutes)}, which a platform cron cannot express: ${input.detail}`,
    'Workers and EventBridge fire cron triggers in UTC — write the UTC hour in the cron, or keep ' +
      'the offset for a worker that ticks itself (`tsir schedule:work`)',
    { name: input.name, expression: input.expression },
  );
}

/**
 * An AWS event arrived for which no `@OnSns` / `@OnEventBridge` / `@OnStepTask` listener was
 * declared (DPL-026). The platform delivered it but the application has no handler, so the
 * event is dropped rather than routed to a method that does not exist.
 */
export function listenerNotFound(input: {
  readonly kind: 'sns' | 'eventbridge' | 'steptask';
  readonly key: string;
}): TsirError {
  return deployError(
    'DPL_LISTENER_NOT_FOUND',
    `no @On${input.kind === 'sns' ? 'Sns' : input.kind === 'eventbridge' ? 'EventBridge' : 'StepTask'} listener for "${input.key}"`,
    'Add the matching decorator, or filter the source so this event is not delivered to this unit',
    { kind: input.kind, key: input.key },
  );
}

/**
 * `publish` was called for a topic no `@OnSns` listener is subscribed to (`DPL-030`).
 * The message would be sent to a topic nobody reads, which is the quietest way to lose work.
 */
export function publishUnknown(input: { readonly topic: string }): TsirError {
  return deployError(
    'DPL_PUBLISH_UNKNOWN',
    `no @OnSns listener for topic "${input.topic}"`,
    'Add an @OnSns({ topic }) decorator, or publish to a topic that already has one',
    { topic: input.topic },
  );
}

/**
 * `invokeUnit` was called for a unit/task no `@OnStepTask` listener handles (`DPL-030`).
 * The invoke would land on a function with no matching task name, which fails after a round trip
 * instead of at the call site.
 */
export function invokeUnknown(input: {
  readonly unit: string;
  readonly task: string;
}): TsirError {
  return deployError(
    'DPL_INVOKE_UNKNOWN',
    `no @OnStepTask listener for task "${input.task}" in unit "${input.unit}"`,
    'Add an @OnStepTask({ name }) decorator, or invoke a task that already has one',
    { unit: input.unit, task: input.task },
  );
}
