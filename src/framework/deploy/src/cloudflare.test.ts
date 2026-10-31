/**
 * The Workers adapter (`DPL-008`).
 *
 * Three claims, in order of how much they matter:
 *
 *   1. **A unit exports only what it serves.** A queue unit has no `fetch`, so it has no
 *      public URL. That is the least-privilege half of `separate` topology, and it is a
 *      property of the returned object, not of a config file.
 *   2. **A failure becomes a decision.** An uncaught `fetch` error is a parseable 500; an
 *      uncaught `queue` error is `retryAll` or `ackAll` depending on whether a retry could
 *      help; a `scheduled` failure is reported and the tick is over.
 *   3. **The adapter is a seam.** Everything below is a plain object: no Miniflare, no
 *      `wrangler`, no Workers runtime.
 */

import { describe, expect, test } from 'bun:test';

import {
  isRetryable,
  toCloudflareHandler,
  triggersOf,
  type QueueBatchLike,
  type QueueMessageLike,
} from './cloudflare.ts';

function batch(messages: readonly string[] = ['m1', 'm2']): QueueBatchLike & {
  acked: boolean;
  retried: boolean;
  delay: number | undefined;
} {
  const state = {
    acked: false,
    retried: false,
    delay: undefined as number | undefined,
    queue: 'jobs',
    messages: messages.map((id): QueueMessageLike => ({ id, body: { id } })),
    ackAll() {
      state.acked = true;
    },
    retryAll(options?: { delaySeconds?: number }) {
      state.retried = true;
      state.delay = options?.delaySeconds;
    },
  };
  return state;
}

const execution = { waitUntil: () => undefined };

describe('the export shape (DPL-008)', () => {
  test('a unit exports exactly the triggers it declares', () => {
    const queueOnly = toCloudflareHandler({ unit: 'queue', queue: async () => undefined });

    expect(Object.keys(queueOnly)).toEqual(['queue']);
    expect(queueOnly.fetch).toBeUndefined();
  });

  test('an HTTP unit has fetch and nothing else', () => {
    const httpOnly = toCloudflareHandler({
      unit: 'http',
      fetch: async () => new Response('ok'),
    });

    expect(Object.keys(httpOnly)).toEqual(['fetch']);
    expect(httpOnly.queue).toBeUndefined();
    expect(triggersOf({ unit: 'http', fetch: async () => new Response('ok') })).toEqual(['fetch']);
  });

  test('all three triggers are describable, in a stable order', () => {
    expect(
      triggersOf({
        unit: 'everything',
        fetch: async () => new Response(''),
        queue: async () => undefined,
        scheduled: async () => undefined,
      }),
    ).toEqual(['fetch', 'queue', 'scheduled']);
  });
});

describe('fetch (DPL-008)', () => {
  test('the request, env and execution context pass straight through', async () => {
    const seen: unknown[] = [];
    const handler = toCloudflareHandler<{ REGION: string }>({
      unit: 'http',
      fetch: async (request, env, ctx) => {
        seen.push(request.url, env.REGION, typeof ctx.waitUntil);
        return new Response('ok');
      },
    });

    const response = await handler.fetch?.(
      new Request('https://api.test/health'),
      { REGION: 'syd' },
      execution,
    );

    expect(await response?.text()).toBe('ok');
    expect(seen).toEqual(['https://api.test/health', 'syd', 'function']);
  });

  test('an uncaught error is a problem+json 500, not a Worker error page', async () => {
    const handler = toCloudflareHandler({
      unit: 'http',
      fetch: async () => {
        throw new Error('database said no');
      },
    });

    const response = await handler.fetch?.(new Request('https://api.test/x'), {}, execution);

    expect(response?.status).toBe(500);
    expect(response?.headers.get('content-type')).toContain('application/problem+json');
    const body = (await response?.json()) as { code: string; detail: string };
    expect(body.code).toBe('HTP_HANDLER_ERROR');
    // The internal message stays out of the response; the observer still gets it.
    expect(body.detail).not.toContain('database said no');
  });

  test('the reporter sees the unit and the trigger', async () => {
    const errors: { error: unknown; unit: string; trigger: string }[] = [];
    const handler = toCloudflareHandler(
      {
        unit: 'http',
        fetch: async () => {
          throw new Error('boom');
        },
      },
      {
        onError: (error, info) => {
          errors.push({ error, unit: info.unit, trigger: info.trigger });
        },
      },
    );

    await handler.fetch?.(new Request('https://api.test/x'), {}, execution);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.unit).toBe('http');
    expect(errors[0]?.trigger).toBe('fetch');
    expect(errors[0]?.error).toBeInstanceOf(Error);
  });

  test('a caller may choose the problem code without losing the shape', async () => {
    const handler = toCloudflareHandler(
      {
        unit: 'http',
        fetch: async () => {
          throw new Error('nope');
        },
      },
      { problemFor: () => ({ code: 'HTP_TIMEOUT', options: { detail: 'took too long' } }) },
    );

    const response = await handler.fetch?.(new Request('https://api.test/x'), {}, execution);
    const body = (await response?.json()) as { code: string; detail: string; status: number };

    expect(body).toMatchObject({ code: 'HTP_TIMEOUT', detail: 'took too long', status: 504 });
  });
});

describe('queue (DPL-008)', () => {
  test('a handled batch is left to the unit to acknowledge', async () => {
    const state = batch();
    const handler = toCloudflareHandler({
      unit: 'queue',
      queue: async (input) => {
        input.ackAll();
      },
    });

    await handler.queue?.(state, {});

    expect(state.acked).toBe(true);
    expect(state.retried).toBe(false);
  });

  test('a retryable failure retries the batch', async () => {
    const state = batch();
    const handler = toCloudflareHandler(
      {
        unit: 'queue',
        queue: async () => {
          throw Object.assign(new Error('upstream down'), { kind: 'unavailable' });
        },
      },
      { retryDelaySeconds: 30 },
    );

    await handler.queue?.(state, {});

    expect(state.retried).toBe(true);
    expect(state.delay).toBe(30);
    expect(state.acked).toBe(false);
  });

  test('a poison message is acknowledged, not retried forever', async () => {
    const state = batch();
    const errors: unknown[] = [];
    const handler = toCloudflareHandler(
      {
        unit: 'queue',
        queue: async () => {
          throw new Error('this message is not JSON and never will be');
        },
      },
      { onError: (error) => errors.push(error) },
    );

    await handler.queue?.(state, {});

    // Retrying an unparseable message is how one bad producer blocks a queue forever.
    expect(state.acked).toBe(true);
    expect(state.retried).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe('scheduled (DPL-008)', () => {
  test('a cron run gets the controller and finishes quietly', async () => {
    const handler = toCloudflareHandler({
      unit: 'schedule',
      scheduled: async (controller) => {
        expect(controller.cron).toBe('*/5 * * * *');
      },
    });

    await handler.scheduled?.({ cron: '*/5 * * * *', scheduledTime: 1_700_000_000_000 }, {});
  });

  test('a cron failure is reported and swallowed: there is no retry to trigger', async () => {
    const errors: unknown[] = [];
    const handler = toCloudflareHandler(
      {
        unit: 'schedule',
        scheduled: async () => {
          throw new Error('drain failed');
        },
      },
      { onError: (error) => errors.push(error) },
    );

    const scheduled = handler.scheduled;
    expect(scheduled).toBeDefined();
    await scheduled?.({ cron: '* * * * *', scheduledTime: 0 }, {});
    expect(errors).toHaveLength(1);
  });
});

describe('retry classification', () => {
  test('an explicit retryable wins in both directions', () => {
    expect(isRetryable({ retryable: true })).toBe(true);
    expect(isRetryable({ retryable: false, kind: 'unavailable' })).toBe(false);
  });

  test('a retryable kind counts, everything else does not', () => {
    expect(isRetryable({ kind: 'unavailable' })).toBe(true);
    expect(isRetryable({ kind: 'timeout' })).toBe(true);
    expect(isRetryable({ kind: 'invalid_argument' })).toBe(false);
    expect(isRetryable(new Error('plain'))).toBe(false);
    expect(isRetryable('a string')).toBe(false);
  });
});
