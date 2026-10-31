import { describe, expect, test } from 'bun:test';

import {
  createSampler,
  createTracer,
  formatTraceparent,
  parseTraceparent,
  SPAN_ATTRIBUTES,
  type SpanData,
  type SpanExporter,
  type TraceContext,
} from './tracing.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

describe('traceparent', () => {
  test('the W3C example parses, and formats back unchanged', () => {
    const parsed = parseTraceparent(`00-${TRACE}-${SPAN}-01`);
    expect(parsed).toEqual({ traceId: TRACE, spanId: SPAN, sampled: true });
    expect(formatTraceparent(parsed as TraceContext)).toBe(`00-${TRACE}-${SPAN}-01`);

    expect(parseTraceparent(`00-${TRACE}-${SPAN}-00`)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      sampled: false,
    });
  });

  test('the sampled flag is the low bit; other flag bits are ignored', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-03`)?.sampled).toBe(true);
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-02`)?.sampled).toBe(false);
  });

  test('a future version with the same layout is accepted; only `ff` is reserved', () => {
    // W3C says a receiver parses the first 55 characters of a higher version, so refusing `01` would
    // be refusing a valid trace from a newer service.
    expect(parseTraceparent(`01-${TRACE}-${SPAN}-01`)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      sampled: true,
    });
  });

  test('case and whitespace are tolerated, because proxies are sloppy', () => {
    expect(parseTraceparent(` 00-${TRACE.toUpperCase()}-${SPAN.toUpperCase()}-01 `)?.traceId).toBe(
      TRACE,
    );
  });

  test('every invalid form is `undefined` — never a best-effort trace id', () => {
    const invalid = [
      undefined,
      null,
      '',
      'garbage',
      `0-${TRACE}-${SPAN}-01`, // one hex digit is not a version
      `ff-${TRACE}-${SPAN}-01`, // reserved as invalid
      `00-${'0'.repeat(32)}-${SPAN}-01`, // all-zero trace id
      `00-${TRACE}-${'0'.repeat(16)}-01`, // all-zero span id
      `00-${TRACE.slice(1)}-${SPAN}-01`, // short trace id
      `00-${TRACE}-${SPAN.slice(1)}-01`, // short span id
      `00-${TRACE}-${SPAN}-1`, // short flags
      `00-${TRACE}-${SPAN}-zz`, // non-hex flags
      `00-${TRACE.replace('4', 'g')}-${SPAN}-01`, // non-hex trace id
      `00_${TRACE}_${SPAN}_01`, // wrong separators
    ];
    for (const header of invalid) expect(parseTraceparent(header)).toBeUndefined();
  });
});

describe('sampling', () => {
  test('`always` and `never` are absolute', () => {
    expect(createSampler({ kind: 'always' }).shouldSample(undefined)).toBe(true);
    expect(createSampler({ kind: 'never' }).shouldSample(true)).toBe(false);
  });

  test('`ratio` uses the injected source', () => {
    const low = createSampler({ kind: 'ratio', ratio: 0.1, random: () => 0.05 });
    const high = createSampler({ kind: 'ratio', ratio: 0.1, random: () => 0.5 });
    expect(low.shouldSample(undefined)).toBe(true);
    expect(high.shouldSample(undefined)).toBe(false);
  });

  test('`parent-based` is the default and obeys the parent in both directions', () => {
    const sampler = createSampler({ ratio: 0.1, random: () => 0.99 });
    expect(sampler.kind).toBe('parent-based');
    expect(sampler.shouldSample(true)).toBe(true); // not re-sampled: a trace stays whole
    expect(sampler.shouldSample(false)).toBe(false); // nor is a parent decision overridden upward
    expect(sampler.shouldSample(undefined)).toBe(false); // a root span uses the ratio
  });

  test('a ratio outside 0…1 is a configuration error', () => {
    expect(() => createSampler({ kind: 'ratio', ratio: 1.5 })).toThrow(/expected 0…1/u);
    expect(() => createSampler({ kind: 'ratio', ratio: -0.1 })).toThrow(/expected 0…1/u);
    expect(() => createSampler({ kind: 'sometimes' as 'always' })).toThrow(/unknown sampler/u);
  });
});

describe('spans', () => {
  function tracer(options: Parameters<typeof createTracer>[0] = {}) {
    const exported: SpanData[] = [];
    const exporter: SpanExporter = {
      export(spans) {
        exported.push(...spans);
      },
    };
    let now = 1_000;
    let counter = 0;
    const instance = createTracer({
      exporter,
      clock: () => (now += 10),
      newTraceId: () => {
        counter += 1;
        return counter.toString(16).padStart(32, '0');
      },
      newSpanId: () => {
        counter += 1;
        return counter.toString(16).padStart(16, '0');
      },
      ...options,
    });
    return { tracer: instance, exported };
  }

  test('a root span has a fresh trace id, a duration, and is exported on end', async () => {
    const { tracer: instance, exported } = tracer();
    const span = instance.startSpan('http.request', {
      attributes: { [SPAN_ATTRIBUTES.httpMethod]: 'POST' },
    });
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/u);
    expect(span.sampled).toBe(true);

    const data = span.end();
    expect(data.endTime).toBeDefined();
    expect((data.endTime ?? 0) - data.startTime).toBeGreaterThan(0);
    expect(data.attributes[SPAN_ATTRIBUTES.httpMethod]).toBe('POST');

    // `end` is idempotent: a `finally` that runs twice does not export twice.
    expect(span.end()).toBe(data);

    await instance.flush();
    expect(exported).toHaveLength(1);
    expect(exported[0]?.name).toBe('http.request');
  });

  test('a child joins the parent trace and records the parent span id', async () => {
    const { tracer: instance, exported } = tracer();
    const root = instance.startSpan('http.request');
    const child = root.span('db.query', { [SPAN_ATTRIBUTES.dbSystem]: 'postgres' });

    expect(child.traceId).toBe(root.traceId);
    expect(child.spanId).not.toBe(root.spanId);
    expect(child.sampled).toBe(root.sampled);

    const data = child.end();
    expect(data.parentSpanId).toBe(root.spanId);

    root.end();
    await instance.flush();
    expect(exported.map((span) => span.name)).toEqual(['db.query', 'http.request']);
  });

  test('an inbound traceparent is continued, not replaced', () => {
    const { tracer: instance } = tracer();
    const parent = parseTraceparent(`00-${TRACE}-${SPAN}-01`);
    const span = instance.startSpan('http.request', { parent });

    expect(span.traceId).toBe(TRACE);
    expect(span.end().parentSpanId).toBe(SPAN);
  });

  test('an unsampled span is not exported, but still runs', async () => {
    const { tracer: instance, exported } = tracer({ sampler: createSampler({ kind: 'never' }) });
    const span = instance.startSpan('http.request');
    expect(span.sampled).toBe(false);
    span.setAttribute('k', 'v').addEvent('checkpoint');
    span.end();
    await instance.flush();
    expect(exported).toHaveLength(0);
  });

  test('attributes, events and status accumulate on the ended span', () => {
    const { tracer: instance } = tracer();
    const span = instance.startSpan('job.run');
    span.setAttribute('queue', 'mail').addEvent('retry', { attempt: 2 }).setStatus('ok');
    const data = span.end();

    expect(data.attributes).toEqual({ queue: 'mail' });
    expect(data.events).toHaveLength(1);
    expect(data.events[0]).toMatchObject({ name: 'retry', attributes: { attempt: 2 } });
    expect(data.status).toBe('ok');
  });

  test('a recorded exception is an OTel `exception` event, and sets the status', () => {
    const { tracer: instance } = tracer();
    const span = instance.startSpan('job.run');
    span.recordException(new TypeError('bad payload'));
    span.recordException('a string was thrown');
    const data = span.end();

    expect(data.status).toBe('error');
    // Two exceptions: the last one is what the span ends with, and both are events.
    expect(data.error).toEqual({ type: 'Error', message: 'a string was thrown' });
    expect(data.events.filter((event) => event.name === 'exception')).toHaveLength(2);
    expect(data.events[0]?.attributes).toEqual({
      'exception.type': 'TypeError',
      'exception.message': 'bad payload',
    });
  });

  test('`withSpan` returns the value, ends the span, and rethrows', async () => {
    const { tracer: instance, exported } = tracer();
    const value = await instance.withSpan('a.b', () => Promise.resolve(42));
    expect(value).toBe(42);

    const error = await instance
      .withSpan('a.c', () => Promise.reject(new Error('boom')))
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('boom');

    await instance.flush();
    expect(exported.map((span) => [span.name, span.status])).toEqual([
      ['a.b', 'ok'],
      ['a.c', 'error'],
    ]);
  });

  test('a synchronous `withSpan` body works too', async () => {
    const { tracer: instance } = tracer();
    expect(await instance.withSpan('a.b', () => 'sync')).toBe('sync');
  });

  test('an exporter that throws never breaks the request', async () => {
    const tracerInstance = createTracer({
      exporter: {
        export() {
          throw new Error('collector down');
        },
        flush() {
          throw new Error('collector down');
        },
      },
    });
    const span = tracerInstance.startSpan('a.b');
    span.end();
    await tracerInstance.flush(); // a rejection would fail the test on its own
    // A second flush with nothing buffered also survives a broken `flush`.
    await tracerInstance.flush();
  });

  test('the semantic-convention attribute names are the OTel ones', () => {
    expect(SPAN_ATTRIBUTES).toEqual({
      httpMethod: 'http.request.method',
      httpRoute: 'http.route',
      httpStatus: 'http.response.status_code',
      dbSystem: 'db.system',
      dbOperation: 'db.operation.name',
      messagingOperation: 'messaging.operation',
      messagingDestination: 'messaging.destination.name',
    });
  });
});
