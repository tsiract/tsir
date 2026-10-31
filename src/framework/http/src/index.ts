/**
 * @tsir/http — the request pipeline.
 *
 * Public surface:
 *   createFetchHandler, HttpOptions, FetchHandler, Middleware, Guard, Policy,
 *   Principal, RequestContext, ResponsePlan, HandlerContext,
 *   contract, ok, created, accepted, noContent,
 *   problemResponse, problemBody, HttpErrorCode,
 *   readJsonBody, searchParamsToObject, headersToObject, mediaType
 *
 * Web-standard in, Web-standard out. `@tsir/http` core imports no `node:` and no
 * `bun:` module; the Bun server adapter lives at `@tsir/http/bun`.
 */

export { createFetchHandler } from './pipeline.ts';
export type {
  AuditEvent,
  CorsOptions,
  Decision,
  FetchHandler,
  Guard,
  HandlerContext,
  HttpOptions,
  InvalidResponse,
  Middleware,
  Next,
  Policy,
  ResponsePlan,
  ResponseValidationMode,
  RouteHandler,
} from './pipeline.ts';

export { accepted, contract, created, noContent, ok } from './contract.ts';
export type { ResponseContractOptions } from './contract.ts';

export { bindsPrincipal } from './route-args.ts';
export type { RouteArgs } from './route-args.ts';

export { createRequestContext } from './context.ts';
export type { Principal, RequestContext } from './context.ts';

export { PROBLEM_CONTENT_TYPE, problemBody, problemResponse, statusOf } from './problems.ts';
export type { HttpErrorCode, ProblemBody, ProblemOptions } from './problems.ts';

export { exceedsDepth, hasPollutionKey, readJsonBody, readWithin } from './body.ts';
export type { BodyLimits, BodyResult, ReadResult } from './body.ts';

export { bindRequest, headersToObject, mediaType, searchParamsToObject } from './bind.ts';
export type { BindFailure, BindResult, BoundRequest, MultipartParser } from './bind.ts';
