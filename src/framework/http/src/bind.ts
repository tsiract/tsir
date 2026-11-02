/**
 * Binding request data to typed values.
 *
 * Every field a route declares is validated here, in one place, before the
 * handler runs. The handler never sees a raw string for something it declared as
 * a number, and never has to check `undefined` for something it declared as
 * required.
 *
 * No coercion happens unless the schema asks for it (principle 6). `IntParam` accepts `/^-?\d+$/` and nothing else: not `"1e3"`, not
 * `" 3"`, not `"0x10"`.
 */

import type { RouteEntry, RouteParams } from '@tsir/router';
import { type AnyStandardSchema, validate, type ValidationIssue } from '@tsir/validate';

import { readJsonBody, readWithin, streamBody, type BodyLimits } from './body.ts';
import type { MultipartResult } from './multipart.ts';

export interface BoundRequest {
  readonly params: unknown;
  readonly query: unknown;
  readonly body: unknown;
  readonly headers: unknown;
}

export type BindFailure =
  | {
      readonly kind: 'validation';
      readonly field: string;
      readonly issues: readonly ValidationIssue[];
    }
  | { readonly kind: 'too-large'; readonly bytes: number }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'unsupported-media-type'; readonly actual: string | null }
  | { readonly kind: 'not-acceptable'; readonly accept: string }
  | {
      readonly kind: 'mime-mismatch';
      readonly field: string;
      readonly declared: string;
      readonly sniffed: string;
    };

export type BindResult = { readonly kind: 'bound'; readonly value: BoundRequest } | BindFailure;

/**
 * A multipart parser, injected rather than imported.
 *
 * The real implementation lives at `@tsir/http/multipart`; a service that never
 * accepts an upload never bundles it (the `http-app` budget measures exactly
 * that). Without a parser, a multipart request is a `415` — not a crash and not
 * a silent empty body.
 */
export type MultipartParser = (
  request: Request,
  limits: {
    readonly maxBytes: number;
    readonly maxFileBytes?: number;
    readonly maxFiles?: number;
    readonly sniff?: boolean;
  },
) => Promise<MultipartResult>;

/**
 * Object-prototype names: refused as query keys (`bindRequest` answers 400), the same policy the
 * JSON body applies. Assigning `__proto__` to a repeated key rewrites the result's prototype.
 */
const POLLUTION_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Repeated query keys become arrays; single keys stay strings. Forbidden names are skipped. */
export function searchParamsToObject(search: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(search.keys())) {
    if (POLLUTION_NAMES.has(key)) continue;
    const all = search.getAll(key);
    if (all.length === 1) out[key] = all[0] as string;
    else out[key] = all;
  }
  return out;
}

export function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value.trim();
  });
  return out;
}

/** Media type without parameters: `application/json; charset=utf-8` → `application/json`. */
export function mediaType(value: string | null): string | null {
  if (value === null) return null;
  const [type] = value.split(';');
  return (type ?? '').trim().toLowerCase();
}

function accepts(accept: string | null, produces: readonly string[]): boolean {
  if (accept === null || accept.trim() === '') return true;
  if (produces.length === 0) return true;
  return accept.split(',').some((entry) => {
    const type = mediaType(entry) ?? '';
    if (type === '*/*') return true;
    return produces.some((produced) => produced === type);
  });
}

async function applySchema(
  schema: AnyStandardSchema | undefined,
  value: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; issues: readonly ValidationIssue[] }> {
  if (schema === undefined) return { ok: true, value };
  const result = await validate(schema, value);
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, issues: result.issues };
}

export async function bindRequest(
  route: RouteEntry,
  request: Request,
  url: URL,
  matchedParams: RouteParams,
  limits: BodyLimits,
  parseMultipart?: MultipartParser,
): Promise<BindResult> {
  const { meta } = route;

  // Content negotiation first: rejecting a request we could not have produced a
  // response for is cheaper than parsing it and failing later.
  if (!accepts(request.headers.get('accept'), meta.produces ?? [])) {
    return { kind: 'not-acceptable', accept: request.headers.get('accept') ?? '' };
  }

  // A declared `consumes` is a contract whether or not a body schema exists: a
  // route that says "JSON only" and accepts `text/plain` is lying in its own
  // OpenAPI document. The header is only checked when present — a bodyless GET
  // carries no Content-Type, and that is not a 415.
  if (meta.body !== undefined || meta.consumes !== undefined) {
    const actual = mediaType(request.headers.get('content-type'));
    const wanted: readonly string[] = meta.consumes ?? ['application/json'];
    if (actual !== null && !wanted.includes(actual)) {
      return { kind: 'unsupported-media-type', actual };
    }
  }

  const boundParams = await applySchema(meta.params, matchedParams);
  if (!boundParams.ok) return { kind: 'validation', field: 'params', issues: boundParams.issues };

  for (const key of new Set(url.searchParams.keys())) {
    if (POLLUTION_NAMES.has(key)) {
      return { kind: 'malformed', detail: `query parameter "${key}" is a forbidden name` };
    }
  }
  const boundQuery = await applySchema(meta.query, searchParamsToObject(url.searchParams));
  if (!boundQuery.ok) return { kind: 'validation', field: 'query', issues: boundQuery.issues };

  const boundHeaders = await applySchema(meta.headers, headersToObject(request.headers));
  if (!boundHeaders.ok)
    return { kind: 'validation', field: 'headers', issues: boundHeaders.issues };

  let body: unknown;
  if (meta.stream === true) {
    // Streaming body: hand the handler a size-limited stream instead of
    // buffering or parsing. No content-type restriction and no body schema —
    // the handler owns the bytes.
    const stream = streamBody(request, limits.maxBytes);
    if (stream.kind === 'too-large') return { kind: 'too-large', bytes: stream.bytes };
    body = stream.stream;
  } else if (meta.body === undefined) {
    // No body schema: still consume the body under the same cap. An unread body
    // is not a free body — it is an unauthenticated allocation, and trusting
    // `content-length` here would let a chunked request bypass the limit.
    const drained = await readWithin(request, limits.maxBytes);
    if (drained.kind === 'too-large') return { kind: 'too-large', bytes: drained.bytes };
    body = undefined;
  } else if ((mediaType(request.headers.get('content-type')) ?? '') === 'multipart/form-data') {
    if (parseMultipart === undefined) {
      // Declared a multipart body but the application never installed a parser.
      // Answering 415 is the honest response: this server does not accept what
      // the client sent.
      return { kind: 'unsupported-media-type', actual: 'multipart/form-data' };
    }

    // Multipart is chosen by the request, not by the schema: the same handler
    // can accept a file upload and a JSON document only if the route declares
    // both in `consumes`.
    const read = await parseMultipart(request, {
      maxBytes: limits.maxBytes,
      ...(route.meta.multipart?.maxFileBytes === undefined
        ? {}
        : { maxFileBytes: route.meta.multipart.maxFileBytes }),
      ...(route.meta.multipart?.maxFiles === undefined
        ? {}
        : { maxFiles: route.meta.multipart.maxFiles }),
      ...(route.meta.multipart?.sniff === undefined ? {} : { sniff: route.meta.multipart.sniff }),
    });

    if (read.kind === 'too-large') return { kind: 'too-large', bytes: read.bytes };
    if (read.kind === 'malformed') return { kind: 'malformed', detail: read.detail };
    if (read.kind === 'mime-mismatch') return read;

    const boundBody = await applySchema(meta.body, read.value);
    if (!boundBody.ok) return { kind: 'validation', field: 'body', issues: boundBody.issues };
    body = boundBody.value;
  } else {
    const read = await readJsonBody(request, limits);
    if (read.kind === 'too-large') return { kind: 'too-large', bytes: read.bytes };
    if (read.kind === 'malformed') return { kind: 'malformed', detail: read.detail };

    const value = read.kind === 'empty' ? undefined : read.value;
    const boundBody = await applySchema(meta.body, value);
    if (!boundBody.ok) return { kind: 'validation', field: 'body', issues: boundBody.issues };
    body = boundBody.value;
  }

  return {
    kind: 'bound',
    value: {
      params: boundParams.value,
      query: boundQuery.value,
      body,
      headers: boundHeaders.value,
    },
  };
}
