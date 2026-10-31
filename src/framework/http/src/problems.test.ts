import { describe, expect, test } from 'bun:test';

import { type HttpErrorCode, problemBody, problemResponse, statusOf } from './problems.ts';

// ERR-006: one row per client-facing code. The `Record` type makes this exhaustive at compile
// time: a code added to `HttpErrorCode` without a row here is a type error, not a silent gap.
const TABLE: Record<HttpErrorCode, { status: number; slug: string }> = {
  HTP_ROUTE_NOT_FOUND: { status: 404, slug: 'not-found' },
  HTP_METHOD_NOT_ALLOWED: { status: 405, slug: 'method-not-allowed' },
  HTP_UNSUPPORTED_MEDIA_TYPE: { status: 415, slug: 'unsupported-media-type' },
  HTP_BODY_TOO_LARGE: { status: 413, slug: 'body-too-large' },
  HTP_MALFORMED_BODY: { status: 400, slug: 'malformed-body' },
  HTP_VALIDATION_FAILED: { status: 422, slug: 'validation' },
  HTP_UNAUTHENTICATED: { status: 401, slug: 'unauthenticated' },
  HTP_FORBIDDEN: { status: 403, slug: 'forbidden' },
  HTP_NOT_ACCEPTABLE: { status: 406, slug: 'not-acceptable' },
  HTP_TIMEOUT: { status: 504, slug: 'timeout' },
  HTP_HANDLER_ERROR: { status: 500, slug: 'internal' },
  HTP_BODY_NOT_ALLOWED: { status: 500, slug: 'body-not-allowed' },
  HTP_MIME_MISMATCH: { status: 422, slug: 'mime-mismatch' },
  HTP_RESPONSE_INVALID: { status: 500, slug: 'response-contract' },
  HTP_BAD_REQUEST: { status: 400, slug: 'bad-request' },
};

const CODES = Object.keys(TABLE) as HttpErrorCode[];

describe('problems: every HttpErrorCode', () => {
  test.each(CODES)('%s: statusOf matches the table', (code) => {
    expect(statusOf(code)).toBe(TABLE[code].status);
  });

  test.each(CODES)('%s: problemBody carries status, type slug and code', (code) => {
    const body = problemBody(code);
    expect(body.code).toBe(code);
    expect(body.status).toBe(TABLE[code].status);
    expect(body.type).toBe(`https://tsir.dev/errors/${TABLE[code].slug}`);
    expect(body.title.length).toBeGreaterThan(0);
  });

  test.each(CODES)('%s: problemResponse status and content type', (code) => {
    const response = problemResponse(code, { detail: 'd' });
    expect(response.status).toBe(TABLE[code].status);
    expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test.each(CODES)('%s: optional fields appear only when supplied', (code) => {
    const bare = problemBody(code);
    expect(bare).not.toHaveProperty('detail');
    expect(bare).not.toHaveProperty('requestId');
    const full = problemBody(code, { detail: 'x', instance: '/a', requestId: 'r1' });
    expect(full).toMatchObject({ detail: 'x', instance: '/a', requestId: 'r1' });
  });
});
