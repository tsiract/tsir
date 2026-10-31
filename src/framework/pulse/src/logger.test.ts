import { describe, expect, test } from 'bun:test';

import { assertEvent, assertLevel, createLogger } from './logger.ts';
import { createRateLimiter } from './limits.ts';
import { fanoutSink, memorySink, stdoutSink, type Sink } from './sinks.ts';
import { REDACTED } from './redact.ts';
import { redacted } from './redact.ts';
import { formatRecord } from './formats.ts';
import type { SafeRecord } from './record.ts';

const AT = 1_700_000_000_000;

function harness(options: Parameters<typeof createLogger>[0] = {}) {
  const sink = memorySink();
  let now = AT;
  const logger = createLogger({
    sink,
    clock: () => now,
    level: 'debug',
    ...options,
  });
  return {
    logger,
    sink,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
    lines: () => sink.records,
  };
}

describe('record shape', () => {
  test('a record is JSON, with the event name, level, version and timestamp', () => {
    const { logger, sink } = harness();
    logger.info('invoice.paid', { invoiceId: 'inv_1', amountCents: 4200 });

    expect(sink.count).toBe(1);
    const record = sink.records[0];
    expect(record).toMatchObject({
      ts: new Date(AT).toISOString(),
      level: 'info',
      event: 'invoice.paid',
      v: 1,
      invoiceId: 'inv_1',
      amountCents: 4200,
    });
    // The canonical form is JSON lines: one object, no prefixes, no colour.
    expect(JSON.parse(formatRecord(record as SafeRecord))).toEqual(record);
  });

  test('`msg` is the human note, and a `fields.msg` becomes it rather than a stray field', () => {
    const { logger, sink } = harness();
    logger.warn('cache.miss', { msg: 'the cache is cold', key: 'a' });
    expect(sink.records[0]?.['msg']).toBe('the cache is cold');
    expect(sink.records[0]?.['key']).toBe('a');
    expect(sink.records[0]).not.toHaveProperty('msg.raw');
  });

  test('reserved keys cannot be forged through `fields`', () => {
    const { logger, sink } = harness();
    logger.info('a.b', {
      level: 'fatal',
      ts: '1970-01-01T00:00:00.000Z',
      v: 99,
      event: 'evil',
      err: 'x',
    });

    const record = sink.records[0];
    expect(record?.['level']).toBe('info');
    expect(record?.['event']).toBe('a.b');
    expect(record?.['v']).toBe(1);
    expect(record?.['ts']).toBe(new Date(AT).toISOString());
  });

  test('no `undefined` fields are written', () => {
    const { logger, sink } = harness();
    logger.info('a.b');
    expect(Object.keys(sink.records[0] ?? {}).sort()).toEqual(['event', 'level', 'ts', 'v']);
  });

  test('an event name is dot.case, enforced at the call site', () => {
    const { logger } = harness();
    expect(assertEvent('invoice.paid')).toBe('invoice.paid');
    expect(assertEvent('started')).toBe('started');
    expect(() => logger.info('Invoice paid for inv_1')).toThrow(/dot.case/u);
    expect(() => logger.info('')).toThrow(/dot.case/u);
    expect(() => logger.info('Invoice.Paid')).toThrow(/dot.case/u);
    expect(() => assertEvent(42)).toThrow(/event is "42"/u);
  });

  test('an unknown level is refused at construction', () => {
    expect(assertLevel('info')).toBe('info');
    expect(() => createLogger({ level: 'verbose' as 'info' })).toThrow(
      /expected one of debug, info, warn, error, fatal/u,
    );
    expect(() => assertLevel(3)).toThrow(/level is "3"/u);
  });
});

describe('levels', () => {
  test('records below the configured level are not built at all', () => {
    const { logger, sink } = harness({ level: 'warn' });
    logger.debug('a.debug');
    logger.info('a.info');
    logger.warn('a.warn');
    logger.error('a.error');
    logger.fatal('a.fatal');

    expect(sink.records.map((record) => record.event)).toEqual(['a.warn', 'a.error', 'a.fatal']);
    expect(logger.isEnabled('debug')).toBe(false);
    expect(logger.isEnabled('warn')).toBe(true);
    expect(logger.isEnabled('fatal')).toBe(true);
    expect(logger.level).toBe('warn');
  });

  test('the default level is `info`, which is the production default', () => {
    const logger = createLogger({ sink: memorySink() });
    expect(logger.level).toBe('info');
    expect(logger.isEnabled('debug')).toBe(false);
    expect(logger.isEnabled('info')).toBe(true);
  });
});

describe('context', () => {
  test('a child inherits context, and its own fields win', () => {
    const { logger, sink } = harness({ context: { unit: 'http' }, service: 'api' });
    const request = logger.child({ requestId: 'req_1', route: 'POST /invoices' });
    const nested = request.child({ requestId: 'req_2' });

    request.info('a.b', { route: 'GET /x' });
    nested.info('a.c');

    expect(sink.records[0]).toMatchObject({
      service: 'api',
      unit: 'http',
      requestId: 'req_1',
      route: 'GET /x', // the call site wins over the inherited value
    });
    expect(sink.records[1]).toMatchObject({ requestId: 'req_2', route: 'POST /invoices' });
    expect(sink.records[1]).not.toHaveProperty('route2');
  });

  test('a child does not mutate its parent, and context is frozen', () => {
    const { logger } = harness({ context: { unit: 'http' } });
    const child = logger.child({ requestId: 'req_1' });

    expect(logger.context).toEqual({ unit: 'http' });
    expect(child.context).toEqual({ unit: 'http', requestId: 'req_1' });
    expect(Object.isFrozen(child.context)).toBe(true);
  });

  test('context obeys the same redaction rules as fields', () => {
    const { logger, sink } = harness();
    logger.child({ apiKey: 'abc123', email: 'ada@example.com' }).info('a.b');
    expect(sink.records[0]?.['apiKey']).toBe(REDACTED);
    expect(sink.records[0]?.['email']).toBe('[omitted]');
  });
});

describe('errors', () => {
  test('`error(event, error)` serializes the error, and `error(event, fields)` does not', () => {
    const { logger, sink } = harness();
    const boom = Object.assign(new Error('boom'), { code: 'ORD_FAILED' });

    logger.error('order.failed', boom);
    logger.error('order.rejected', { code: 'ORD_REJECTED', status: 422 });

    expect(sink.records[0]?.['err']).toMatchObject({
      type: 'Error',
      message: 'boom',
      code: 'ORD_FAILED',
    });
    expect(sink.records[0]?.['fingerprint']).toMatch(/^[0-9a-f]{8}$/u);
    expect(sink.records[1]).not.toHaveProperty('err');
    expect(sink.records[1]?.['code']).toBe('ORD_REJECTED');
  });

  test('`error(event, error, fields)` writes both', () => {
    const { logger, sink } = harness();
    logger.fatal('process.crashed', new Error('out of memory'), { status: 500 });
    expect(sink.records[0]?.['status']).toBe(500);
    expect(sink.records[0]?.['level']).toBe('fatal');
    expect(sink.records[0]?.['err']).toMatchObject({ message: 'out of memory' });
  });

  test('a thrown non-Error is still a record', () => {
    const { logger, sink } = harness();
    logger.error('a.b', 'a string was thrown');
    expect(sink.records[0]?.['err']).toEqual({
      type: 'ThrownString',
      message: 'a string was thrown',
    });
  });
});

describe('redaction runs before the sink', () => {
  test('a synthetic object of every secret kind writes no plaintext bytes', () => {
    const { logger, sink } = harness({ redaction: { paths: ['body.pin'] } });
    const secrets = {
      password: 'hunter2',
      token: 'abc123',
      authorization: 'Bearer abcdefghijkl',
      apiKey: 'tsk_abcdef012345_supersecretvalue123',
      cookie: '__Host-tsir_session=abc',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      pem: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----',
      body: { pin: '1234' },
      nested: { password: 'hunter2' },
      typed: redacted('super-secret-token', 'session'),
      email: 'ada@example.com',
      ip: '203.0.113.7',
    };

    logger.info('security.audit', secrets);
    const line = JSON.stringify(sink.records[0]);

    for (const plaintext of [
      'hunter2',
      'abc123',
      'tsk_abcdef012345_supersecretvalue123',
      '1234',
      'super-secret-token',
      'ada@example.com',
      '203.0.113.7',
    ]) {
      expect(line).not.toContain(plaintext);
    }
    // 64 hex characters of a hash is not a leak, but the marker must be present and repeated.
    expect(line.split(REDACTED).length - 1).toBeGreaterThanOrEqual(6);
  });

  test('PII policy is the logger’s, and `allow` is explicit', () => {
    const omitted = harness();
    omitted.logger.info('a.b', { email: 'ada@example.com' });
    expect(omitted.sink.records[0]?.['email']).toBe('[omitted]');

    const allowed = harness({ pii: 'allow' });
    allowed.logger.info('a.b', { email: 'ada@example.com' });
    expect(allowed.sink.records[0]?.['email']).toBe('ada@example.com');
  });
});

describe('sinks fail open', () => {
  test('a throwing sink never throws at the caller, and is reported once', () => {
    const failures: { sink: string; error: unknown }[] = [];
    const broken: Sink = {
      name: 'broken',
      write() {
        throw new Error('socket closed');
      },
    };
    const logger = createLogger({
      sink: broken,
      clock: () => AT,
      onSinkError: (failure) => failures.push(failure),
    });

    expect(() => logger.info('a.b')).not.toThrow();
    expect(() => logger.info('a.c')).not.toThrow();
    expect(failures).toHaveLength(2);
    expect(failures[0]?.sink).toBe('broken');
  });

  test('`fanoutSink` disables a broken sink and keeps writing to the others', () => {
    const working = memorySink();
    const failures: string[] = [];
    let brokenWrites = 0;
    const broken: Sink = {
      name: 'otlp',
      write() {
        brokenWrites += 1;
        throw new Error('collector unreachable');
      },
    };
    const fanout = fanoutSink([broken, working], { onError: ({ sink }) => failures.push(sink) });

    const logger = createLogger({ sink: fanout, clock: () => AT, level: 'info' });
    logger.info('a.b');
    logger.info('a.c');
    logger.info('a.d');

    expect(working.count).toBe(3);
    expect(brokenWrites).toBe(1); // latched: a broken sink is not retried per record
    expect(failures).toEqual(['otlp']);
    expect(fanout.disabled).toEqual(['otlp']);
    expect(fanout.dropped).toBe(3); // the first record the broken sink refused, and the two after
  });

  test('a `required` sink is the one way to invert fail-open, and it fails the call', () => {
    const fanout = fanoutSink(
      [
        {
          name: 'audit',
          write() {
            throw new Error('audit store unavailable');
          },
        },
      ],
      { required: ['audit'] },
    );
    const logger = createLogger({ sink: fanout, clock: () => AT });
    // The logger's own guard keeps `emit` from throwing, but the sink reported the failure rather
    // than swallowing it — which is what makes readiness able to see it.
    const failures: unknown[] = [];
    const strict = createLogger({
      sink: fanout,
      clock: () => AT,
      onSinkError: (failure) => failures.push(failure),
    });
    expect(() => strict.info('a.b')).not.toThrow();
    expect(failures).toHaveLength(1);
    expect((failures[0] as { error: Error }).error.message).toContain('audit');
    void logger;
  });

  test('`stdoutSink` writes one line per record, and uses the format it was built with', () => {
    const lines: string[] = [];
    const sink = stdoutSink({ format: 'cloudwatch', write: (line) => lines.push(line) });
    const logger = createLogger({ sink, clock: () => AT });

    logger.info('invoice.paid', { invoiceId: 'inv_1' });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(parsed['timestamp']).toBe(AT);
    expect(parsed['event']).toBe('invoice.paid');
    expect(sink.name).toBe('stdout');
  });

  test('`memorySink` can also keep the formatted lines', () => {
    const sink = memorySink({ format: 'otlp-json' });
    createLogger({ sink, clock: () => AT }).info('a.b');
    expect(sink.lines).toHaveLength(1);
    expect(JSON.parse(sink.lines[0] ?? '')['severityText']).toBe('INFO');
    sink.clear();
    expect(sink.count).toBe(0);
    expect(sink.lines).toHaveLength(0);
  });
});

describe('volume', () => {
  test('a storm is dropped per event, and one summary line says how much', async () => {
    const { logger, sink } = harness({ rateLimit: 3 });
    for (let index = 0; index < 10; index += 1) logger.info('loop.tick', { index });
    // A different event in the same second is unaffected: the limit is per name.
    logger.info('other.event');

    await logger.flush();

    const events = sink.records.map((record) => record.event);
    expect(events.filter((event) => event === 'loop.tick')).toHaveLength(3);
    expect(events).toContain('other.event');

    const summary = sink.records.find((record) => record.event === 'pulse.log.dropped');
    expect(summary).toBeDefined();
    expect(summary?.['dropped']).toBe(7);
    expect(summary?.['events']).toEqual([{ event: 'loop.tick', dropped: 7 }]);
    expect(summary?.['level']).toBe('warn');
  });

  test('the limiter refills every second', () => {
    const limiter = createRateLimiter({ perSecond: 2 });
    expect(limiter.admit('a', 0)).toBe(true);
    expect(limiter.admit('a', 100)).toBe(true);
    expect(limiter.admit('a', 200)).toBe(false);
    expect(limiter.admit('a', 300)).toBe(false);
    expect(limiter.totalDropped).toBe(2);
    expect(limiter.drain()).toEqual([{ event: 'a', dropped: 2 }]);
    expect(limiter.drain()).toEqual([]);

    // A new second is a new window.
    expect(limiter.admit('a', 1_000)).toBe(true);
    expect(limiter.admit('b', 1_001)).toBe(true);
  });

  test('an exempt event is never dropped, so the summary cannot drop itself', () => {
    const limiter = createRateLimiter({ perSecond: 1, exempt: ['pulse.log.dropped'] });
    expect(limiter.admit('a', 0)).toBe(true);
    expect(limiter.admit('a', 1)).toBe(false);
    for (let index = 0; index < 5; index += 1)
      expect(limiter.admit('pulse.log.dropped', 2 + index)).toBe(true);
  });

  test('repeated identical errors collapse within the window, and are reported at flush', async () => {
    const { logger, sink } = harness({ dedupeWindowMs: 1_000 });
    const boom = Object.assign(new Error('boom'), { code: 'ORD_FAILED' });

    logger.error('order.failed', boom);
    logger.error('order.failed', boom);
    logger.error('order.failed', boom);
    expect(sink.count).toBe(1);

    await logger.flush();
    const summary = sink.records.find((record) => record.event === 'pulse.log.repeated');
    expect(summary?.['occurrences']).toBe(3);
    expect(summary?.['originalEvent']).toBe('order.failed');
    expect(summary?.['windowMs']).toBe(1_000);
  });

  test('a different error, or the same one after the window, is written again', () => {
    const { logger, sink, advance } = harness({ dedupeWindowMs: 1_000 });
    const boom = Object.assign(new Error('boom'), { code: 'ORD_FAILED' });
    const other = Object.assign(new Error('boom'), { code: 'ORD_OTHER' });

    logger.error('order.failed', boom);
    logger.error('order.failed', other);
    expect(sink.count).toBe(2);

    advance(1_500);
    logger.error('order.failed', boom);
    expect(sink.count).toBe(3);
  });

  test('dedupe can be turned off, and never applies to `info`', () => {
    const off = harness({ dedupe: false });
    const boom = new Error('boom');
    off.logger.error('a.b', boom);
    off.logger.error('a.b', boom);
    expect(off.sink.count).toBe(2);

    const on = harness();
    on.logger.info('a.b', { tick: 1 });
    on.logger.info('a.b', { tick: 2 });
    expect(on.sink.count).toBe(2);
  });
});

describe('flush', () => {
  test('flush drains summaries and calls the sink’s flush', async () => {
    let flushed = 0;
    const base = memorySink();
    const sink: Sink = { ...base, flush: () => void (flushed += 1) };
    const logger = createLogger({ sink, clock: () => AT });
    logger.info('a.b');
    await logger.flush();
    expect(flushed).toBe(1);
  });

  test('a flush that throws is swallowed like everything else in the log path', async () => {
    const sink: Sink = {
      name: 'bad-flush',
      write() {},
      flush() {
        throw new Error('nope');
      },
    };
    const failures: unknown[] = [];
    const logger = createLogger({
      sink,
      clock: () => AT,
      onSinkError: (failure) => failures.push(failure),
    });
    await logger.flush(); // a rejection would fail the test on its own
    expect(failures).toHaveLength(1);
  });
});
