/**
 * RFC 9457 problem responses.
 *
 * Every error a client can see is `application/problem+json` with a stable
 * `code`. The code is the contract; `title` and `detail` are for humans and may
 * be reworded. Machine clients switch on `code`, never on prose.
 *
 * Nothing here includes a stack, a `cause`, or an echoed input value: a problem
 * body is untrusted output.
 */

import type { ValidationIssue } from '@tsir/validate';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Stable catalogue. Append-only. */
export type HttpErrorCode =
  | 'HTP_ROUTE_NOT_FOUND'
  | 'HTP_METHOD_NOT_ALLOWED'
  | 'HTP_UNSUPPORTED_MEDIA_TYPE'
  | 'HTP_BODY_TOO_LARGE'
  | 'HTP_MALFORMED_BODY'
  | 'HTP_VALIDATION_FAILED'
  | 'HTP_UNAUTHENTICATED'
  | 'HTP_FORBIDDEN'
  | 'HTP_NOT_ACCEPTABLE'
  | 'HTP_TIMEOUT'
  | 'HTP_HANDLER_ERROR'
  | 'HTP_BODY_NOT_ALLOWED'
  | 'HTP_MIME_MISMATCH'
  | 'HTP_RESPONSE_INVALID'
  | 'HTP_BAD_REQUEST';

interface ProblemSpec {
  readonly status: number;
  readonly title: string;
  readonly slug: string;
}

const SPECS: Readonly<Record<HttpErrorCode, ProblemSpec>> = {
  HTP_ROUTE_NOT_FOUND: { status: 404, title: 'Not found', slug: 'not-found' },
  HTP_METHOD_NOT_ALLOWED: { status: 405, title: 'Method not allowed', slug: 'method-not-allowed' },
  HTP_UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    title: 'Unsupported media type',
    slug: 'unsupported-media-type',
  },
  HTP_BODY_TOO_LARGE: { status: 413, title: 'Request body too large', slug: 'body-too-large' },
  HTP_MALFORMED_BODY: { status: 400, title: 'Malformed request body', slug: 'malformed-body' },
  HTP_VALIDATION_FAILED: { status: 422, title: 'Request validation failed', slug: 'validation' },
  HTP_UNAUTHENTICATED: { status: 401, title: 'Authentication required', slug: 'unauthenticated' },
  HTP_FORBIDDEN: { status: 403, title: 'Forbidden', slug: 'forbidden' },
  HTP_NOT_ACCEPTABLE: { status: 406, title: 'Not acceptable', slug: 'not-acceptable' },
  HTP_TIMEOUT: { status: 504, title: 'Request timed out', slug: 'timeout' },
  HTP_HANDLER_ERROR: { status: 500, title: 'Internal server error', slug: 'internal' },
  HTP_MIME_MISMATCH: {
    status: 422,
    title: 'File type does not match its contents',
    slug: 'mime-mismatch',
  },
  HTP_RESPONSE_INVALID: {
    status: 500,
    title: 'Response did not match its schema',
    slug: 'response-contract',
  },
  HTP_BODY_NOT_ALLOWED: {
    status: 500,
    title: 'Response body not allowed',
    slug: 'body-not-allowed',
  },
  HTP_BAD_REQUEST: { status: 400, title: 'Bad request', slug: 'bad-request' },
};

export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: HttpErrorCode;
  readonly detail?: string;
  readonly instance?: string;
  readonly requestId?: string;
  readonly issues?: readonly ValidationIssue[];
  readonly [extension: string]: unknown;
}

export interface ProblemOptions {
  readonly detail?: string;
  readonly instance?: string;
  readonly requestId?: string;
  readonly issues?: readonly ValidationIssue[];
  readonly headers?: Readonly<Record<string, string>>;
}

/** Builds the JSON body without serializing it — useful in tests and CLI output. */
export function problemBody(code: HttpErrorCode, options: ProblemOptions = {}): ProblemBody {
  const spec = SPECS[code];
  return {
    type: `https://tsir.dev/errors/${spec.slug}`,
    title: spec.title,
    status: spec.status,
    code,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.instance === undefined ? {} : { instance: options.instance }),
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    ...(options.issues === undefined ? {} : { issues: options.issues }),
  };
}

/**
 * Serializes a problem into a `Response`.
 *
 * `headers` are applied last so a 405 can carry `Allow` and a 401 can carry
 * `WWW-Authenticate` without the caller hand-rolling the body again.
 */
export function problemResponse(code: HttpErrorCode, options: ProblemOptions = {}): Response {
  const spec = SPECS[code];
  return new Response(JSON.stringify(problemBody(code, options)), {
    status: spec.status,
    headers: {
      'content-type': `${PROBLEM_CONTENT_TYPE}; charset=utf-8`,
      'cache-control': 'no-store',
      ...options.headers,
    },
  });
}

export function statusOf(code: HttpErrorCode): number {
  return SPECS[code].status;
}
