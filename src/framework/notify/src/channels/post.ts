/**
 * The shared half of the two channels that speak HTTP.
 *
 * The `webhook` and `chat` channels differ in who they talk to and what body they send; everything
 * else about them is identical, and writing it twice is how two channels end up with two timeout
 * behaviours. The rules:
 *
 *   · **A timeout is a failure with a sentence**, not a request that hangs until the runtime kills
 *     the invocation.
 *   · **A non-2xx is a failure that carries the status**, because "the webhook failed" is not an
 *     address and `HTTP 401` is.
 *   · **The response body is never echoed into the error beyond a short line.** A webhook endpoint
 *     that answers with somebody's page must not end up in a log.
 */

export interface PostRequest {
  readonly url: string;
  /** The exact bytes to send — the signature is computed over them, so this is never re-encoded. */
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetcher?: typeof fetch | undefined;
}

export interface PostResponse {
  readonly status: number;
  /** The whole body. A provider's id lives in it (`twilio` reads `sid`), so it is not truncated. */
  readonly text: string;
}

export class PostFailed extends Error {
  readonly status: number | undefined;
  readonly timedOut: boolean;

  constructor(message: string, status: number | undefined, timedOut: boolean) {
    super(message);
    this.name = 'PostFailed';
    this.status = status;
    this.timedOut = timedOut;
  }
}

/** POST `body` and answer the status; throws `PostFailed` for anything but 2xx. */
export async function post(request: PostRequest): Promise<PostResponse> {
  const doFetch = request.fetcher ?? fetch;
  const timeoutMs = request.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await doFetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body: request.body,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    const timedOut = controller.signal.aborted;
    const detail = error instanceof Error ? error.message : String(error);
    throw new PostFailed(
      timedOut ? `the request timed out after ${String(timeoutMs)} ms` : detail,
      undefined,
      timedOut,
    );
  } finally {
    clearTimeout(timer);
  }

  const body = await response.text();
  if (!response.ok) {
    const snippet = body.slice(0, 200);
    throw new PostFailed(
      `HTTP ${String(response.status)}${snippet === '' ? '' : `: ${snippet}`}`,
      response.status,
      false,
    );
  }
  return { status: response.status, text: body };
}
