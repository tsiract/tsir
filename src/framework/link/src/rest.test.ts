/**
 * REST adapter (`LNK-009`, `LNK-010`, `LNK-011`).
 *
 * No socket is opened by this file: `fetch` is injected, so each case is a scripted
 * exchange and the assertions are about *policy* — did we retry, did we validate, did we
 * stop reading a body that was too large.
 */

import { describe, expect, test } from 'bun:test';

import { createRestClient, type CallEvent, type RestClientOptions } from './rest.ts';
import { bearerCredentialProvider } from './credentials.ts';
import { createCallContext, type CallContext } from './types.ts';
import type { RetryPolicy as Policy } from './retry.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const POLICY: Policy = { attempts: 3, backoffMs: 1, jitter: false };

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

function scripted(responses: readonly (() => Response | Promise<Response>)[]): {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;

  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next === undefined) throw new Error('no scripted response');
      return next();
    },
  };
}

function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function client(options: Partial<RestClientOptions> = {}): {
  rest: ReturnType<typeof createRestClient>;
  calls: Recorded[];
  events: CallEvent[];
  slept: number[];
} {
  const calls: Recorded[] = [];
  const events: CallEvent[] = [];
  const slept: number[] = [];
  const script = scripted([() => json({})]);

  const rest = createRestClient({
    baseUrl: 'https://billing.test',
    retry: POLICY,
    breaker: false,
    onCall: (event) => events.push(event),
    deps: {
      fetch: (url, init) => {
        calls.push({ url, init });
        return script.fetch(url, init);
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
      now: () => 1_000,
      random: () => 0.5,
    },
    ...options,
  });

  return { rest, calls, events, slept };
}

function ctx(overrides: Partial<CallContext> = {}): CallContext {
  return createCallContext({ traceId: TRACE, correlationId: 'invoice-import-7', ...overrides });
}

describe('a successful call (LNK-009)', () => {
  test('validates the response, fills meta, and propagates trace headers', async () => {
    const { rest, calls, events } = client();
    const fetchCalls: Recorded[] = [];
    const client2 = createRestClient({
      baseUrl: 'https://billing.test',
      breaker: false,
      onCall: (event) => events.push(event),
      deps: {
        fetch: async (url, init) => {
          fetchCalls.push({ url, init });
          return json({ id: 'inv_1', total: 1_200 });
        },
        now: () => 1_000,
        sleep: async () => undefined,
      },
    });

    const result = await client2.call({
      method: 'GET',
      path: '/invoices/inv_1',
      ctx: ctx(),
      query: { expand: 'lines', page: 2, skipped: undefined },
      response: {
        parse: (value: unknown) => value as { id: string; total: number },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({ id: 'inv_1', total: 1_200 });
    expect(result.meta).toMatchObject({
      protocol: 'rest',
      target: 'https://billing.test',
      attempts: 1,
      status: 200,
    });

    const [sent] = fetchCalls;
    expect(sent?.url).toBe('https://billing.test/invoices/inv_1?expand=lines&page=2');
    expect(sent?.init.redirect).toBe('manual');
    const headers = sent?.init.headers as Record<string, string>;
    expect(headers['traceparent']).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));
    expect(headers['x-correlation-id']).toBe('invoice-import-7');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'ok', status: 200, attempts: 1, traceId: TRACE });
    expect(calls).toHaveLength(0);
    expect(rest.target).toBe('https://billing.test');
  });

  test('the base URL path is preserved, and a text response skips JSON parsing', async () => {
    const seen: string[] = [];
    const rest = createRestClient({
      baseUrl: 'https://billing.test/api/v2',
      breaker: false,
      deps: {
        fetch: async (url) => {
          seen.push(url);
          return new Response('pong', { headers: { 'content-type': 'text/plain' } });
        },
        now: () => 1_000,
        sleep: async () => undefined,
      },
    });

    const result = await rest.call({
      method: 'GET',
      path: '/health',
      ctx: ctx(),
      responseType: 'text',
    });

    expect(seen).toEqual(['https://billing.test/api/v2/health']);
    expect(result.ok && result.value).toBe('pong');
    expect(rest.target).toBe('https://billing.test/api/v2');
  });
});

describe('local mistakes throw, remote failures are values (LNK-001, LNK-009)', () => {
  test('a request body that fails its schema never reaches fetch', async () => {
    const { rest, calls } = client();
    const strict = {
      parse: (value: unknown) => {
        if (typeof value !== 'object' || value === null || !('amount' in value)) {
          throw new Error('amount is required');
        }
        return value;
      },
    };

    // Bun's `toThrow` also passes when a function *returns* an error, so the rejection is
    // captured explicitly instead of trusting the matcher alone.
    let thrown: unknown;
    try {
      await rest.call({
        method: 'POST',
        path: '/invoices',
        ctx: ctx(),
        body: {},
        bodySchema: strict,
      });
    } catch (caught) {
      thrown = caught;
    }

    expect((thrown as Error).message).toContain('amount is required');
    expect((thrown as { code: string }).code).toBe('LNK_SCHEMA');
    expect(calls).toHaveLength(0);
  });

  test('an absolute or protocol-relative path is a configuration error', async () => {
    const { rest, calls } = client();

    expect(() => rest.call({ method: 'GET', path: '//evil.test/steal', ctx: ctx() })).toThrow(
      /must be relative to baseUrl/,
    );
    expect(() => rest.call({ method: 'GET', path: 'invoices', ctx: ctx() })).toThrow(
      /must be relative to baseUrl/,
    );
    expect(calls).toHaveLength(0);
  });

  test('an expired context never opens a socket', async () => {
    const { rest, calls } = client();
    const expired = ctx({ deadline: new Date(999) });

    const result = await rest.call({ method: 'GET', path: '/invoices', ctx: expired });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatchObject({ kind: 'timeout', code: 'LNK_TIMEOUT' });
    expect(calls).toHaveLength(0);
  });
});

describe('HTTP failures map to kinds (LNK-008)', () => {
  test('404 is a value, not an exception, and names the status', async () => {
    const script = scripted([() => json({ error: 'missing' }, { status: 404 })]);
    const rest = createRestClient({
      baseUrl: 'https://billing.test',
      breaker: false,
      deps: { fetch: script.fetch, now: () => 1_000 },
    });

    const result = await rest.call({ method: 'GET', path: '/invoices/nope', ctx: ctx() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('not_found');
    expect(result.error.code).toBe('HTTP_404');
    expect(result.error.retryable).toBe(false);
    expect(result.meta.status).toBe(404);
  });

  test('a 503 with no retry policy fails after one attempt', async () => {
    const script = scripted([() => json({}, { status: 503 })]);
    const rest = createRestClient({
      baseUrl: 'https://billing.test',
      breaker: false,
      deps: { fetch: script.fetch, now: () => 1_000, sleep: async () => undefined },
    });

    const result = await rest.call({ method: 'GET', path: '/invoices', ctx: ctx() });

    expect(result.ok).toBe(false);
    expect(script.calls).toHaveLength(1);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatchObject({ kind: 'unavailable', code: 'HTTP_503', retryable: true });
  });
});

describe('retry honours idempotency (LNK-010)', () => {
  const failingThenOk = (): ReturnType<typeof scripted> =>
    scripted([() => json({}, { status: 503 }), () => json({ id: 'inv_1' })]);

  function withScript(
    script: ReturnType<typeof scripted>,
    retry: Policy = POLICY,
  ): { rest: ReturnType<typeof createRestClient>; slept: number[] } {
    const slept: number[] = [];
    const rest = createRestClient({
      baseUrl: 'https://billing.test',
      retry,
      breaker: false,
      deps: {
        fetch: script.fetch,
        now: () => 1_000,
        sleep: async (ms) => {
          slept.push(ms);
        },
        random: () => 0.5,
      },
    });
    return { rest, slept };
  }

  test('an unsafe POST without an idempotency key is tried exactly once', async () => {
    const script = failingThenOk();
    const { rest } = withScript(script);

    const result = await rest.call({
      method: 'POST',
      path: '/invoices',
      ctx: ctx(),
      body: { amount: 5 },
    });

    expect(script.calls).toHaveLength(1);
    expect(result.ok).toBe(false);
  });

  test('the same POST with a key retries, and the key is sent', async () => {
    const script = failingThenOk();
    const { rest, slept } = withScript(script);

    const result = await rest.call({
      method: 'POST',
      path: '/invoices',
      ctx: ctx(),
      body: { amount: 5 },
      idempotencyKey: 'inv-create-42',
    });

    expect(script.calls).toHaveLength(2);
    expect(slept).toEqual([1]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.meta.attempts).toBe(2);

    for (const call of script.calls) {
      expect((call.init.headers as Record<string, string>)['idempotency-key']).toBe(
        'inv-create-42',
      );
    }
  });

  test('a key on the context counts, and a safe method needs none', async () => {
    const fromContext = failingThenOk();
    const a = withScript(fromContext);
    await a.rest.call({
      method: 'PUT',
      path: '/invoices/1',
      ctx: ctx({ idempotencyKey: 'ctx-key' }),
    });
    expect(fromContext.calls).toHaveLength(2);

    const safe = failingThenOk();
    const b = withScript(safe);
    await b.rest.call({ method: 'GET', path: '/invoices/1', ctx: ctx() });
    expect(safe.calls).toHaveLength(2);
  });

  test('Retry-After is honoured as a floor, even when the backoff is smaller', async () => {
    const script = scripted([
      () => json({}, { status: 429, headers: { 'retry-after': '2' } }),
      () => json({ ok: true }),
    ]);
    const { rest, slept } = withScript(script);

    const result = await rest.call({ method: 'GET', path: '/invoices', ctx: ctx() });

    expect(slept).toEqual([2_000]);
    expect(result.ok).toBe(true);
  });
});

describe('response limits (LNK-011)', () => {
  test('a declared content-length over the cap is rejected before reading', async () => {
    const script = scripted([
      () => json({ big: true }, { headers: { 'content-length': '999999' } }),
    ]);
    const rest = createRestClient({
      baseUrl: 'https://billing.test',
      breaker: false,
      maxResponseBytes: 64,
      deps: { fetch: script.fetch, now: () => 1_000 },
    });

    const result = await rest.call({ method: 'GET', path: '/big', ctx: ctx() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatchObject({ kind: 'protocol', code: 'LNK_BODY_TOO_LARGE' });
  });

  test('a streamed body that grows past the cap is abandoned mid-read', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(32).fill(97);

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    const rest = createRestClient({
      baseUrl: 'https://billing.test',
      breaker: false,
      maxResponseBytes: 100,
      deps: {
        fetch: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
        now: () => 1_000,
      },
    });

    const result = await rest.call({ method: 'GET', path: '/flood', ctx: ctx() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('LNK_BODY_TOO_LARGE');
    expect(cancelled).toBe(true);
  });

  test('a non-JSON content type, invalid JSON, and a schema mismatch are protocol errors', async () => {
    const html = scripted([
      () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    ]);
    const broken = scripted([
      () => new Response('{nope', { headers: { 'content-type': 'application/json' } }),
    ]);
    const mismatched = scripted([() => json({ id: 1 })]);

    const make = (script: ReturnType<typeof scripted>) =>
      createRestClient({
        baseUrl: 'https://billing.test',
        breaker: false,
        deps: { fetch: script.fetch, now: () => 1_000 },
      });

    const codes: string[] = [];
    for (const [script, extra] of [
      [html, {}],
      [broken, {}],
      [
        mismatched,
        {
          response: {
            parse: (v: unknown): string => {
              if (typeof v !== 'string') throw new Error('expected a string');
              return v;
            },
          },
        },
      ],
    ] as const) {
      const result = await make(script).call({ method: 'GET', path: '/x', ctx: ctx(), ...extra });
      if (result.ok) throw new Error('expected a failure');
      expect(result.error.kind).toBe('protocol');
      codes.push(result.error.code);
    }

    expect(codes).toEqual(['LNK_CONTENT_TYPE', 'LNK_INVALID_JSON', 'LNK_SCHEMA']);
  });
});

describe('cancellation, breaker and observability (LNK-003, LNK-005, LNK-006)', () => {
  test('aborting the context mid-flight is reported as cancelled', async () => {
    const controller = new AbortController();
    const rest = createRestClient({
      baseUrl: 'https://billing.test',
      breaker: false,
      deps: {
        fetch: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
            controller.abort();
          }),
        now: () => 1_000,
      },
    });

    const result = await rest.call({
      method: 'GET',
      path: '/slow',
      ctx: ctx({ signal: controller.signal }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('cancelled');
  });

  test('a network error is a retryable unavailable, with the cause kept', async () => {
    const cause = new TypeError('fetch failed');
    const rest = createRestClient({
      baseUrl: 'https://billing.test',
      breaker: false,
      deps: {
        fetch: async () => {
          throw cause;
        },
        now: () => 1_000,
      },
    });

    const result = await rest.call({ method: 'GET', path: '/x', ctx: ctx() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatchObject({
      kind: 'unavailable',
      code: 'LNK_NETWORK',
      retryable: true,
    });
    expect(result.error.cause).toBe(cause);
  });

  test('the breaker opens after a failure and short-circuits the next call', async () => {
    const script = scripted([() => json({}, { status: 503 })]);
    const rest = createRestClient({
      baseUrl: 'https://billing.test',
      retry: POLICY,
      breaker: { threshold: 1, cooldownMs: 30_000 },
      deps: { fetch: script.fetch, now: () => 1_000, sleep: async () => undefined },
    });

    const first = await rest.call({ method: 'GET', path: '/x', ctx: ctx() });
    expect(first.ok).toBe(false);
    expect(script.calls.length).toBe(3); // retried three times, then the breaker opened
    expect(rest.breaker.state()).toBe('open');

    const second = await rest.call({ method: 'GET', path: '/x', ctx: ctx() });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.error.code).toBe('LNK_CIRCUIT_OPEN');
    expect(script.calls.length).toBe(3); // no fourth request
  });

  test('a sink that throws cannot fail a call that already succeeded', async () => {
    const script = scripted([() => json({ ok: true })]);
    const rest = createRestClient({
      baseUrl: 'https://billing.test',
      breaker: false,
      onCall: () => {
        throw new Error('sink exploded');
      },
      deps: { fetch: script.fetch, now: () => 1_000 },
    });

    const result = await rest.call({ method: 'GET', path: '/x', ctx: ctx() });
    expect(result.ok).toBe(true);
  });

  test('credentials are attached and only their id is recorded', async () => {
    const script = scripted([() => json({ ok: true })]);
    const rest = createRestClient({
      baseUrl: 'https://billing.test',
      breaker: false,
      credentials: bearerCredentialProvider({ id: 'svc-billing', token: () => 'tok_secret' }),
      deps: { fetch: script.fetch, now: () => 1_000 },
    });

    const result = await rest.call({ method: 'GET', path: '/x', ctx: ctx() });

    expect(result.meta.credentialId).toBe('svc-billing');
    const headers = script.calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok_secret');
    expect(JSON.stringify(result.meta)).not.toContain('tok_secret');
  });
});

describe('client construction is validated at boot', () => {
  test('a non-http base URL, a downgrade to http, and a host outside the allowlist', () => {
    expect(() => createRestClient({ baseUrl: 'billing.test' })).toThrow(/not an absolute URL/);
    expect(() => createRestClient({ baseUrl: 'ftp://billing.test' })).toThrow(
      /must use http or https/,
    );
    expect(() => createRestClient({ baseUrl: 'http://billing.test' })).toThrow(/must use https/);
    expect(() =>
      createRestClient({ baseUrl: 'https://billing.test', allowedHosts: ['inventory.test'] }),
    ).toThrow(/allowlist/);
    expect(() =>
      createRestClient({ baseUrl: 'https://billing.test', retry: { attempts: 0 } }),
    ).toThrow(/at least 1/);
  });

  test('loopback over http is allowed — that is every test and every sidecar', () => {
    expect(() => createRestClient({ baseUrl: 'http://localhost:8080' })).not.toThrow();
  });
});

describe('edges the adapters rely on', () => {
  test('a responseType of none drains and returns undefined without parsing', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        cancelled = true;
      },
    });

    const rest = createRestClient({
      baseUrl: 'https://billing.test',
      breaker: false,
      deps: {
        fetch: async () => new Response(body, { status: 204 }),
        now: () => 1_000,
      },
    });

    const result = await rest.call({
      method: 'DELETE',
      path: '/invoices/1',
      ctx: ctx(),
      responseType: 'none',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toBeUndefined();
    expect(cancelled).toBe(true);
  });

  test('a deadline that passes between attempts ends the call as a timeout', async () => {
    const slept: number[] = [];
    const rest = createRestClient({
      baseUrl: 'https://billing.test',
      retry: { attempts: 3, backoffMs: 1, jitter: false },
      breaker: false,
      deps: {
        fetch: async () => {
          await Bun.sleep(15);
          return json({}, { status: 503 });
        },
        now: () => 1_000,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    });

    const deadline = new Date(1_000 + 5);
    const result = await rest.call({ method: 'GET', path: '/x', ctx: ctx({ deadline }) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('timeout');
    expect(result.meta.attempts).toBe(1);
  });

  test('the default sleep honours an abort and a zero backoff resolves at once', async () => {
    const script = scripted([() => json({}, { status: 503 }), () => json({ ok: true })]);
    const controller = new AbortController();
    const rest = createRestClient({
      baseUrl: 'https://billing.test',
      retry: { attempts: 2, backoffMs: 0, jitter: false },
      breaker: false,
      // No `sleep` override: this exercises the default, including its `.unref()`.
      deps: { fetch: script.fetch, now: () => 1_000 },
    });

    const result = await rest.call({
      method: 'GET',
      path: '/x',
      ctx: ctx({ signal: controller.signal }),
    });

    expect(result.ok).toBe(true);
    expect(script.calls).toHaveLength(2);
  });
});
