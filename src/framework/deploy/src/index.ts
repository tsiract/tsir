/**
 * @tsir/deploy — one application, compiled into deployable units.
 *
 * Public surface:
 *   resolveUnits, applyTopology, DEFAULT_TOPOLOGY, UNIT_KINDS,
 *   buildGraph, checkGraph, serializeGraph, parseGraph, diffGraphs, describeDiff,
 *   formatGraph, explainGraph, graphJson, assertTarget, GRAPH_FILE, GRAPH_SCHEMA_VERSION,
 *   Unit, UnitKind, UnitTrigger, UnitReason, BindingRef, BindingKind, UnitGraph,
 *   DeploymentInput, GraphOptions, TargetConfig, GraphProblem, GraphDiff, GraphChange,
 *   DeployErrorCode
 *
 * The rule that shapes the package: **the deploy shape is data, not a build script**. A
 * graph is resolved from declarations, validated against the targets, serialized
 * deterministically and committed, so a change in what will be deployed is a diff in
 * review.
 */

export {
  bindingMissing,
  capabilityMissing,
  classMissing,
  duplicateRoute,
  envLimit,
  graphDrift,
  invalidDeployConfig,
  listenerNotFound,
  privateExposed,
  queueOutboxMissing,
  queueTriggerMissing,
  secretLeak,
  sizeBudget,
  unitEmpty,
  unsupportedTarget,
} from './errors.ts';
export type { DeployErrorCode } from './errors.ts';

export { applyTopology, DEFAULT_TOPOLOGY, resolveUnits, UNIT_KINDS } from './units.ts';
export { compileListeners } from './listeners.ts';
export type { CompileListenersOptions, ListenerContext, ListenerController } from './listeners.ts';
export { invokeUnit, publish, setInternalTransport } from './internal.ts';
export type { InternalTransport } from './internal.ts';
export {
  checkQueueConnections,
  QUEUE_TRIGGER_MATRIX,
  queueUnitFor,
  triggerFor,
  triggersForConnection,
  type QueueConnectionInput,
  type QueueTriggerKind,
} from './queue-triggers.ts';
export type {
  BindingKind,
  BindingRef,
  ConnectionInput,
  DeployOptions,
  DeploymentInput,
  ModuleInput,
  QueueInput,
  RouteInput,
  ScheduleInput,
  SocketInput,
  TopologyResolution,
  TriggerKind,
  Unit,
  UnitKind,
  UnitOverride,
  UnitReason,
  UnitTrigger,
} from './units.ts';

export {
  DEFAULT_LAMBDA,
  envBytes,
  LAMBDA_ENV_LIMIT_BYTES,
  LAMBDA_ENV_LIMIT_COUNT,
  logicalName,
  samTemplate,
  samTemplates,
  toAwsSchedule,
} from './sam.ts';
export type { SamOptions } from './sam.ts';

export {
  describeFindings,
  findingContext,
  hasLeak,
  scanSources,
  scanText,
  secretPatterns,
  SECRET_SHAPES,
} from './secrets.ts';
export type { SecretFinding, SecretPattern, SourceFile } from './secrets.ts';

export {
  assertTarget,
  buildGraph,
  checkGraph,
  describeDiff,
  diffGraphs,
  explainGraph,
  formatGraph,
  graphJson,
  GRAPH_FILE,
  GRAPH_SCHEMA_VERSION,
  parseGraph,
  serializeGraph,
} from './graph.ts';
export type {
  BuildGraphResult,
  GraphChange,
  GraphDiff,
  GraphOptions,
  GraphProblem,
  TargetConfig,
  UnitGraph,
} from './graph.ts';
