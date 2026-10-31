/**
 * An in-process HTTP client for tests (TST-002), and the problem-response assertion (TST-006).
 *
 * The client builds a `Request` and hands it straight to a fetch-shaped handler, so no socket is
 * opened and nothing leaves the process. The handler is whatever the application would serve:
 * `createFetchHandler(harness.routes())` in a test, or any `(request) => Response`.
 */

/** Anything that answers a `Request` with a `Response`. `createFetchHandler` has this shape. */
export type TestHandler = (request: Request) => Response | Promise<Response>;

export interface TestRequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
  /** Serialised as JSON, with `content-type: application/json` set unless the caller set one. */
  readonly json?: unknown;
  /** Raw body, used as given. Ignored when `json` is set. */
  readonly body?: RequestInit['body'];
}

export interface TestClient {
  request(method: string, path: string, options?: TestRequestOptions): Promise<Response>;
  get(path: string, options?: TestRequestOptions): Promise<Response>;
  post(path: string, options?: TestRequestOptions): Promise<Response>;
  put(path: string, options?: TestRequestOptions): Promise<Response>;
  patch(path: string, options?: TestRequestOptions): Promise<Response>;
  delete(path: string, options?: TestRequestOptions): Promise<Response>;
}

export interface TestClientOptions {
  /** The origin the paths are resolved against. Never contacted: it only forms the URL. */
  readonly origin?: string;
}

const DEFAULT_ORIGIN = 'http://tsir.test';

/** Builds a `Request` for `path`, with the JSON shortcut applied. */
function buildRequest(
  origin: string,
  method: string,
  path: string,
  options: TestRequestOptions,
): Request {
  const headers = new Headers(options.headers);
  let body: RequestInit['body'] = options.body;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  return new Request(new URL(path, origin).href, { method, headers, body: body ?? null });
}

/** A client bound to one handler. Each call is one `await handler(request)`. */
export function createTestClient(
  handler: TestHandler,
  options: TestClientOptions = {},
): TestClient {
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const request = async (
    method: string,
    path: string,
    requestOptions: TestRequestOptions = {},
  ): Promise<Response> => handler(buildRequest(origin, method, path, requestOptions));

  return {
    request,
    get: (path, requestOptions) => request('GET', path, requestOptions),
    post: (path, requestOptions) => request('POST', path, requestOptions),
    put: (path, requestOptions) => request('PUT', path, requestOptions),
    patch: (path, requestOptions) => request('PATCH', path, requestOptions),
    delete: (path, requestOptions) => request('DELETE', path, requestOptions),
  };
}

export interface ExpectedProblem {
  readonly status: number;
  /** The `code` member of the problem body, when the test cares which problem it is. */
  readonly code?: string;
}

/**
 * Asserts that a response is an RFC 9457 problem with the given status (and code, when given),
 * and returns the parsed body. It checks the content type too: a plain-text 500 is not a problem.
 *
 * It asserts on the code, not the title or detail, so a wording change does not break the test.
 */
export async function expectProblem(
  response: Response,
  expected: ExpectedProblem,
): Promise<Readonly<Record<string, unknown>>> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.startsWith('application/problem+json')) {
    throw new Error(`expected an application/problem+json response, got "${contentType}"`);
  }
  if (response.status !== expected.status) {
    throw new Error(`expected status ${String(expected.status)}, got ${String(response.status)}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (expected.code !== undefined && body['code'] !== expected.code) {
    throw new Error(`expected problem code "${expected.code}", got "${String(body['code'])}"`);
  }
  return body;
}
