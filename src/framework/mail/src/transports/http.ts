/**
 * The shared half of every `fetch`-based transport.
 *
 * Three things are identical across Resend, Postmark, SES and a webhook, and writing them four
 * times is how they end up four different behaviours:
 *
 *   · **A failure is a coded error that never carries the credential.** The provider's own message
 *     is kept — it is the most useful thing in an incident — and the request is not.
 *   · **A JSON body that is not JSON is a failure, not an empty result.** A 200 with an HTML error
 *     page is what a proxy in front of a provider returns, and reading it as success is how a
 *     delivery is marked sent that never was.
 *   · **A timeout, if one is set, is a `MAIL_TRANSPORT_FAILED`** rather than a request that hangs
 *     until the runtime kills the invocation.
 */

import { transportFailed } from '../errors.ts';

export interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
  /**
   * Response headers, lower-cased.
   *
   * SendGrid returns its message id here rather than in the body, and a 202 has an empty body — so
   * without this the one provider whose id is a header hands the caller a delivery it cannot
   * track. Every other transport ignores it.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** POST JSON, and answer the parsed body — or a coded failure naming the provider. */
export async function postJson(input: {
  readonly transport: string;
  readonly operation: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}): Promise<JsonResponse> {
  const doFetch = input.fetch ?? fetch;
  const controller = input.timeoutMs === undefined ? undefined : new AbortController();
  const timer =
    controller === undefined || input.timeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(), input.timeoutMs);

  let response: Response;
  try {
    response = await doFetch(input.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...input.headers },
      body: JSON.stringify(input.body),
      ...(controller === undefined || controller.signal === undefined
        ? {}
        : { signal: controller.signal }),
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw transportFailed({
      transport: input.transport,
      operation: `${input.operation} (the request itself failed)`,
      detail:
        controller?.signal.aborted === true
          ? `timed out after ${String(input.timeoutMs)} ms`
          : detail,
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? {} : JSON.parse(text);
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    throw transportFailed({
      transport: input.transport,
      operation: input.operation,
      status: response.status,
      ...(body === undefined ? { detail: text.slice(0, 200) } : { detail: providerMessage(body) }),
    });
  }
  if (body === undefined) {
    throw transportFailed({
      transport: input.transport,
      operation: `${input.operation} (the provider answered ${String(response.status)} with something that is not JSON)`,
    });
  }

  return { status: response.status, body, headers };
}

/** The message a provider puts in its error body, under one of the names they all use. */
export function providerMessage(body: unknown): string {
  if (typeof body === 'string') return body;
  if (typeof body !== 'object' || body === null) return 'no message';
  const record = body as Record<string, unknown>;
  for (const key of ['message', 'Message', 'error', 'detail', 'Description', 'error_description']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'object' && value !== null) {
      const nested = providerMessage(value);
      if (nested !== 'no message') return nested;
    }
  }
  return 'no message';
}

/** A string field out of a provider's JSON body, or a failure saying which one was missing. */
export function requireString(
  body: unknown,
  keys: readonly string[],
  where: { readonly transport: string; readonly operation: string },
): string {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  throw transportFailed({
    transport: where.transport,
    operation: `${where.operation} (the answer has no ${keys.join(' / ')})`,
  });
}
