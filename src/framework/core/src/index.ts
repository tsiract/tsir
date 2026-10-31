/**
 * @tsir/core — application lifecycle, modules, manifest, error surface.
 *
 * Public surface:
 *   bootstrap, defineModule, createManifest, probeCapabilities,
 *   systemClock, systemRandom, TsirError (re-exported from the container)
 *
 * There is deliberately no `get<T>()`, no `app.resolve()`, and no global app.
 */

export { bootstrap } from './bootstrap.ts';
export type {
  App,
  AppDiagnosticEvent,
  AppStage,
  AppState,
  BootstrapOptions,
  ShutdownReason,
} from './types.ts';

export { defineApp } from './define-app.ts';
export type {
  AppMode,
  CreateAppOptions,
  DefineAppOptions,
  ModuleFactory,
  TsirApp,
} from './define-app.ts';

export { defineModule, validateModules } from './module.ts';
export type { ModuleContext, ModuleDefinition } from './module.ts';

export {
  MANIFEST_FORMAT_VERSION,
  createManifest,
  diffManifest,
  hashModules,
  isManifestStale,
} from './manifest.ts';
export type { AppManifest, ManifestDrift } from './manifest.ts';

export { assertCapabilities, probeCapabilities, targetCapabilities } from './capabilities.ts';
export type {
  Capability,
  CapabilityRequirement,
  DeployTarget,
  RuntimeCapabilities,
} from './capabilities.ts';

export { systemClock, systemRandom } from './clock.ts';
export type { Clock, Random } from './clock.ts';

export { isTsirError, normalizeError, TsirError } from '@tsir/container';
export type { ErrorKind, TsirErrorInit } from '@tsir/container';
export type { Container, Provider, Scope, Token } from '@tsir/container';
export { contract, describeToken, token } from '@tsir/container';
