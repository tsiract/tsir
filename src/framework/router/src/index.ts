/**
 * @tsir/router — route declaration and matching.
 *
 * Public surface:
 *   Controller, Route, Get/Post/Put/Patch/Delete/Head/Options,
 *   Guards, Policies, UseMiddleware,
 *   routeRegistry, RouteRegistry, compileRoutes, defineRoute,
 *   RouteMatcher, createMatcher, joinPath, assertValidPath, pathShape,
 *   emitRoutesModule
 *
 * Runtime-neutral: no `node:` and no `bun:` imports. The same table compiles for
 * Bun, Workers and Lambda.
 *
 * No parameter decorators. Standard ECMAScript decorators only (ADR-0001), which
 * means argument binding is declared in route metadata and arrives at the handler
 * as one typed context object.
 */

export {
  assertValidPath,
  Controller,
  Delete,
  Get,
  Guards,
  Head,
  joinPath,
  OnEventBridge,
  OnSns,
  OnStepTask,
  Options,
  Patch,
  Policies,
  Post,
  Put,
  Route,
  UseMiddleware,
} from './decorators.ts';
export type {
  ControllerDecorator,
  OnEventBridgeOptions,
  OnSnsOptions,
  OnStepTaskOptions,
  RouteMethodDecorator,
  RouteOptions,
} from './decorators.ts';

export { RouteRegistry, routeRegistry } from './registry.ts';
export type { ControllerEntry, DeclaredRoute } from './registry.ts';
export type { DeclaredListener } from './types.ts';

export { compileRoutes, defineRoute, describeTable, METHOD_ORDER, pathShape } from './compile.ts';

export { emitRoutesModule } from './codegen.ts';
export type { GeneratedRoute, ImportRef, RoutesModuleInput } from './codegen.ts';

export {
  collectRouteEntries,
  listenerControllers,
  removeRouteModule,
  routeModule,
  routeModules,
} from './module.ts';
export type { ListenerControllerEntry, RouteModule, RouteModuleOptions } from './module.ts';

export { createMatcher, RouteMatcher } from './matcher.ts';
export type { MatchResult, RouteParams } from './matcher.ts';

export {
  ambiguousRoute,
  badHandler,
  badPath,
  badStatus,
  duplicateRoute,
  emptyController,
  notCompiled,
  principalWithoutGuard,
} from './errors.ts';
export type { RouterErrorCode } from './errors.ts';

export { BODYLESS_STATUSES } from './types.ts';
export type {
  AwsListenerKind,
  AwsListenerMeta,
  ContentType,
  ControllerClass,
  HttpMethod,
  PathShape,
  PolicyRef,
  RouteEntry,
  RouteMeta,
  RouteStatus,
  RouteTable,
  TokenRef,
} from './types.ts';
