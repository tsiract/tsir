/**
 * The Lambda adapter (`DPL-013`, `DPL-015`).
 *
 * The claims worth testing are the ones that only show up in production:
 *
 *   · **A v2 event becomes a `Request` faithfully.** Base64 bodies, cookies in their own
 *     array, `rawQueryString` preserved — because a handler that sees a re-encoded query
 *     string cannot verify a signature.
 *   · **A `Response` becomes the envelope faithfully.** Binary bodies are base64, or the
 *     image comes out full of `\uFFFD`.
 *   · **SQS failures are partial.** One bad message returns by id; the good ones are not
 *     redelivered. Failing the whole invocation is the classic duplicate-processing bug.
 *   · **The deadline is real.** `getRemainingTimeInMillis()` becomes an `AbortSignal` that
 *     fires before the platform kills the function, not after.
 */

import { describe, expect, test } from 'bun:test';

import {
  deadlineSignal,
  decodeBase64,
  encodeBase64,
  isRetryable,
  requestFromApiGatewayV2,
  responseToApiGatewayV2,
  toLambdaHandler,
  type ApiGatewayV2Event,
  type LambdaContextLike,
  type SqsEvent,
} from './lambda.ts';

const context: LambdaContextLike = {
  functionName: 'acme-http',
  awsRequestId: 'req-1',
  getRemainingTimeInMillis: () => 30_000,
};

function apiEvent(overrides: Partial<ApiGatewayV2Event> = {}): ApiGatewayV2Event {
  return {
    version: '2.0',
    rawPath: '/api/users/7',
    rawQueryString: 'expand=profile&tag=a%20b',
    headers: { host: 'api.test', 'content-type': 'application/json' },
    requestContext: { http: { method: 'GET', sourceIp: '203.0.113.9' } },
    ...overrides,
  };
}

describe('API Gateway v2 → Request (DPL-013)', () => {
  test('the path and the raw query string survive intact', () => {
    const request = requestFromApiGatewayV2(apiEvent());

    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://lambda.test/api/users/7?expand=profile&tag=a%20b');
    expect(request.headers.get('host')).toBe('api.test');
  });

  test('cookies arrive as one Cookie header', () => {
    const request = requestFromApiGatewayV2(
      apiEvent({ cookies: ['session=abc', 'theme=dark'], rawQueryString: '' }),
    );

    expect(request.headers.get('cookie')).toBe('session=abc; theme=dark');
  });

  test('a base64 body is decoded before the handler sees it', async () => {
    const request = requestFromApiGatewayV2(
      apiEvent({
        requestContext: { http: { method: 'POST' } },
        body: encodeBase64(new TextEncoder().encode('{"name":"ada"}')),
        isBase64Encoded: true,
        rawQueryString: '',
      }),
    );

    expect(await request.text()).toBe('{"name":"ada"}');
  });

  test('a plain body is passed through as text', async () => {
    const request = requestFromApiGatewayV2(
      apiEvent({ requestContext: { http: { method: 'PUT' } }, body: 'a=1', rawQueryString: '' }),
    );

    expect(await request.text()).toBe('a=1');
  });
});

describe('Response → envelope (DPL-013)', () => {
  test('a JSON response stays text and keeps its content type', async () => {
    const envelope = await responseToApiGatewayV2(
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(envelope.statusCode).toBe(201);
    expect(envelope.isBase64Encoded).toBe(false);
    expect(envelope.body).toBe('{"ok":true}');
    expect(envelope.headers['content-type']).toBe('application/json');
  });

  test('a binary response is base64, byte for byte', async () => {
    const bytes = new Uint8Array([0, 159, 146, 150, 255, 10]);
    const envelope = await responseToApiGatewayV2(
      new Response(bytes, { headers: { 'content-type': 'image/png' } }),
    );

    expect(envelope.isBase64Encoded).toBe(true);
    expect([...decodeBase64(envelope.body)]).toEqual([...bytes]);
  });

  test('content-length is not forwarded: API Gateway owns it', async () => {
    const envelope = await responseToApiGatewayV2(
      new Response('hi', { headers: { 'content-type': 'text/plain', 'content-length': '2' } }),
    );

    expect(envelope.headers['content-length']).toBeUndefined();
  });

  test('a configured non-standard type can be forced to text', async () => {
    const envelope = await responseToApiGatewayV2(
      new Response('a,b', { headers: { 'content-type': 'text/csv' } }),
    );
    expect(envelope.isBase64Encoded).toBe(false);
  });
});

describe('the handler (DPL-013)', () => {
  test('an HTTP event reaches the unit as a Request and comes back as an envelope', async () => {
    const handler = toLambdaHandler({
      unit: 'http',
      fetch: async (request) =>
        new Response(`saw ${request.method} ${new URL(request.url).pathname}`),
    });

    const envelope = await handler(apiEvent(), context);

    expect(envelope.statusCode).toBe(200);
    expect(envelope.body).toBe('saw GET /api/users/7');
  });

  test('an SQS batch reports only the messages worth retrying', async () => {
    const seen: string[] = [];
    const errors: unknown[] = [];
    const handler = toLambdaHandler(
      {
        unit: 'queue',
        queue: async (message) => {
          seen.push(message.id);
          if (message.id === 'bad-retry') {
            throw Object.assign(new Error('down'), { retryable: true });
          }
          if (message.id === 'bad-poison') throw new Error('never parses');
        },
      },
      { onError: (error) => errors.push(error) },
    );

    const event: SqsEvent = {
      Records: [
        { messageId: 'ok', body: '{"id":1}', eventSource: 'aws:sqs' },
        { messageId: 'bad-retry', body: '{"id":2}', eventSource: 'aws:sqs' },
        { messageId: 'bad-poison', body: 'not json', eventSource: 'aws:sqs' },
      ],
    };

    const envelope = await handler(event, context);

    expect(seen).toEqual(['ok', 'bad-retry', 'bad-poison']);
    expect(envelope.batchItemFailures).toEqual([{ itemIdentifier: 'bad-retry' }]);
    expect(errors).toHaveLength(2);
  });

  test('a JSON SQS body is parsed; anything else is handed over as the raw string', async () => {
    const bodies: unknown[] = [];
    const handler = toLambdaHandler({
      unit: 'queue',
      queue: async (message) => {
        bodies.push(message.body);
      },
    });

    await handler(
      {
        Records: [
          { messageId: 'a', body: '{"id":1}', eventSource: 'aws:sqs' },
          { messageId: 'b', body: 'plain text', eventSource: 'aws:sqs' },
        ],
      },
      context,
    );

    expect(bodies).toEqual([{ id: 1 }, 'plain text']);
  });

  test('an EventBridge event runs the unit with a deadline signal', async () => {
    let aborted: boolean | undefined;
    const handler = toLambdaHandler({
      unit: 'schedule',
      scheduled: async (event) => {
        aborted = event.signal.aborted;
        expect(event.source).toBe('aws.events');
      },
    });

    const envelope = await handler(
      {
        source: 'aws.events',
        'detail-type': 'Scheduled Event',
        time: '2026-10-28T00:00:00Z',
        detail: {},
      },
      context,
    );

    expect(aborted).toBe(false);
    expect(envelope.statusCode).toBe(200);
  });

  test('an EventBridge Scheduler event (aws.scheduler) also runs the scheduled handler', async () => {
    let ran = false;
    const handler = toLambdaHandler({
      unit: 'schedule',
      scheduled: async () => {
        ran = true;
      },
    });

    const envelope = await handler(
      {
        source: 'aws.scheduler',
        'detail-type': 'Scheduler Event',
        time: '2026-10-28T00:00:00Z',
        detail: {},
      },
      context,
    );

    expect(ran).toBe(true);
    expect(envelope.statusCode).toBe(200);
  });

  test('a custom-bus EventBridge event routes to the eventbridge handler', async () => {
    let received: unknown;
    const handler = toLambdaHandler({
      unit: 'schedule',
      eventbridge: async (event) => {
        received = event;
      },
    });

    const envelope = await handler(
      {
        source: 'com.example.orders',
        'detail-type': 'OrderPlaced',
        time: '2026-10-28T00:00:00Z',
        detail: { orderId: 'o_1' },
      },
      context,
    );

    expect(envelope.statusCode).toBe(200);
    expect(received).toMatchObject({
      source: 'com.example.orders',
      'detail-type': 'OrderPlaced',
      detail: { orderId: 'o_1' },
    });
  });

  test('a custom-bus EventBridge event fails loudly when the unit has no eventbridge handler', async () => {
    const handler = toLambdaHandler({
      unit: 'schedule',
      scheduled: async () => {},
    });

    return expect(
      handler(
        {
          source: 'com.example.orders',
          'detail-type': 'OrderPlaced',
          time: '2026-10-28T00:00:00Z',
          detail: { orderId: 'o_1' },
        },
        context,
      ),
    ).rejects.toThrow(/no eventbridge handler/);
  });

  test('a unit that does not serve the trigger fails loudly instead of returning 200', async () => {
    const handler = toLambdaHandler({ unit: 'http', fetch: async () => new Response('') });

    expect(
      handler({ Records: [{ messageId: 'a', body: '{}', eventSource: 'aws:sqs' }] }, context),
    ).rejects.toThrow(/no queue handler/);
  });

  test('an SNS notification delivers the parsed message, topic and subject', async () => {
    let received: { id: string; topicArn: string; subject?: string; body: unknown } | undefined;
    const handler = toLambdaHandler({
      unit: 'notify',
      sns: async (message) => {
        received = {
          id: message.id,
          topicArn: message.topicArn,
          ...(message.subject !== undefined ? { subject: message.subject } : {}),
          body: message.body,
        };
      },
    });

    const envelope = await handler(
      {
        Records: [
          {
            EventSource: 'aws:sns',
            Sns: {
              TopicArn: 'arn:aws:sns:us-east-1:123:orders',
              MessageId: 'msg-1',
              Subject: 'New order',
              Message: JSON.stringify({ orderId: 'o_42' }),
              Timestamp: '2026-11-01T00:00:00Z',
            },
          },
        ],
      },
      context,
    );

    expect(received).toEqual({
      id: 'msg-1',
      topicArn: 'arn:aws:sns:us-east-1:123:orders',
      subject: 'New order',
      body: { orderId: 'o_42' },
    });
    expect(envelope.statusCode).toBe(200);
  });

  test('an SNS message that is not JSON is handed over as the raw string', async () => {
    let body: unknown;
    const handler = toLambdaHandler({
      unit: 'notify',
      sns: async (message) => {
        body = message.body;
      },
    });

    await handler(
      {
        Records: [
          {
            EventSource: 'aws:sns',
            Sns: {
              TopicArn: 'arn:aws:sns:us-east-1:123:orders',
              MessageId: 'msg-2',
              Message: 'plain text',
            },
          },
        ],
      },
      context,
    );

    expect(body).toBe('plain text');
  });

  test('an SNS failure is reported and rethrown so SNS retries', async () => {
    let reported: unknown;
    const handler = toLambdaHandler(
      {
        unit: 'notify',
        sns: async () => {
          throw new Error('boom');
        },
      },
      {
        onError: (error) => {
          reported = error;
        },
      },
    );

    expect(
      handler(
        {
          Records: [
            {
              EventSource: 'aws:sns',
              Sns: {
                TopicArn: 'arn:aws:sns:us-east-1:123:orders',
                MessageId: 'msg-3',
                Message: '{}',
              },
            },
          ],
        },
        context,
      ),
    ).rejects.toThrow('boom');
    expect(reported).toBeInstanceOf(Error);
  });

  test('a unit with no sns handler rejects an SNS event loudly', async () => {
    const handler = toLambdaHandler({ unit: 'http', fetch: async () => new Response('') });

    expect(
      handler(
        {
          Records: [
            {
              EventSource: 'aws:sns',
              Sns: { TopicArn: 'arn:aws:sns:us-east-1:123:orders', MessageId: 'm', Message: '{}' },
            },
          ],
        },
        context,
      ),
    ).rejects.toThrow(/no sns handler/);
  });

  test('an unrecognised event names the shapes it accepts', async () => {
    const handler = toLambdaHandler({ unit: 'http', fetch: async () => new Response('') });

    expect(handler({ hello: 'world' }, context)).rejects.toThrow(/API Gateway v2/);
  });
});

describe('the deadline (DPL-015)', () => {
  test('a signal is created per invocation and disposed without firing', () => {
    const deadline = deadlineSignal({ getRemainingTimeInMillis: () => 10_000 }, 500);

    expect(deadline.remainingMs).toBe(9_500);
    expect(deadline.signal.aborted).toBe(false);
    deadline.dispose();
  });

  test('without a remaining-time function there is no timer and no abort', () => {
    const deadline = deadlineSignal({}, 500);

    expect(deadline.remainingMs).toBe(Number.POSITIVE_INFINITY);
    expect(deadline.signal.aborted).toBe(false);
    deadline.dispose();
  });

  test('the signal aborts before the platform would kill the function', async () => {
    const deadline = deadlineSignal({ getRemainingTimeInMillis: () => 120 }, 100);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });
});

describe('base64 without a runtime', () => {
  test('round-trips every byte value', () => {
    const bytes = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) bytes[index] = index;

    expect([...decodeBase64(encodeBase64(bytes))]).toEqual([...bytes]);
  });

  test('pads to a multiple of four and ignores whitespace on the way in', () => {
    expect(encodeBase64(new TextEncoder().encode('a'))).toBe('YQ==');
    expect(encodeBase64(new TextEncoder().encode('ab'))).toBe('YWI=');
    expect(new TextDecoder().decode(decodeBase64('Y Q = ='))).toBe('a');
  });
});

describe('retry classification', () => {
  test('matches the Workers adapter', () => {
    expect(isRetryable({ retryable: true })).toBe(true);
    expect(isRetryable({ kind: 'rate_limited' })).toBe(true);
    expect(isRetryable({ kind: 'conflict' })).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});
