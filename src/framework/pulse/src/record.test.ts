import { describe, expect, test } from 'bun:test';

import {
  fingerprintOf,
  LEVEL_SEVERITY,
  LOG_LEVELS,
  LOG_SCHEMA_VERSION,
  serializeError,
  summarize,
} from './record.ts';
import { assertFormat, formatRecord, LOG_FORMATS, toCloudwatch, toEcs, toOtlp } from './formats.ts';
import type { SafeRecord } from './record.ts';

const record: SafeRecord = {
  ts: '2026-10-29T00:00:00.000Z',
  level: 'info',
  event: 'invoice.paid',
  v: 1,
  msg: 'invoice paid',
  requestId: 'req_1',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  service: 'api',
  invoiceId: 'inv_123',
  amountCents: 4200,
};

describe('the schema', () => {
  test('the levels are ordered, and the severity numbers are OTel-shaped', () => {
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error', 'fatal']);
    expect(LEVEL_SEVERITY.debug).toBeLessThan(LEVEL_SEVERITY.info);
    expect(LEVEL_SEVERITY.info).toBeLessThan(LEVEL_SEVERITY.warn);
    expect(LEVEL_SEVERITY.warn).toBeLessThan(LEVEL_SEVERITY.error);
    expect(LEVEL_SEVERITY.error).toBeLessThan(LEVEL_SEVERITY.fatal);
    expect(LOG_SCHEMA_VERSION).toBe(1);
  });
});

describe('serializeError', () => {
  test('an Error keeps its type, message, code and stack frames — as an array', () => {
    const error = new TypeError('bad input');
    (error as { code?: string }).code = 'HTP_VALIDATION_FAILED';
    const serialized = serializeError(error);

    expect(serialized.type).toBe('TypeError');
    expect(serialized.message).toBe('bad input');
    expect(serialized.code).toBe('HTP_VALIDATION_FAILED');
    expect(Array.isArray(serialized.stack)).toBe(true);
    for (const frame of serialized.stack ?? [])
      expect(frame.startsWith('at ') || frame.startsWith('@')).toBe(true);
  });

  test('a stack is capped, and says that it was capped', () => {
    const error = new Error('deep');
    error.stack = [
      'Error: deep',
      ...Array.from({ length: 40 }, (_unused, index) => ` at frame${String(index)} (file.ts:1:1)`),
    ].join('\n');
    const serialized = serializeError(error, { maxStackFrames: 3 });
    expect(serialized.stack).toHaveLength(3);
    expect(serialized.truncated).toBe(true);
  });

  test('a cause chain is nested, and cut at the depth cap', () => {
    const root = new Error('root');
    const middle = new Error('middle', { cause: root });
    const top = new Error('top', { cause: middle });

    expect(serializeError(top).cause?.message).toBe('middle');
    expect(serializeError(top).cause?.cause?.message).toBe('root');
    expect(serializeError(top).cause?.cause?.cause).toBeUndefined();

    // The cap is reported on the record that was cut, which is the one whose cause chain stops.
    const capped = serializeError(top, { maxCauseDepth: 1 });
    expect(capped.cause?.message).toBe('middle');
    expect(capped.cause?.cause).toBeUndefined();
    expect(capped.cause?.truncated).toBe(true);
  });

  test('anything thrown becomes a record with a type — never `null`', () => {
    expect(serializeError('plain string')).toEqual({
      type: 'ThrownString',
      message: 'plain string',
    });
    expect(serializeError(null)).toEqual({ type: 'Unknown', message: 'nothing was thrown' });
    expect(serializeError(undefined).type).toBe('Unknown');
    expect(serializeError(42).type).toBe('Thrownnumber');
    expect(serializeError({ code: 'X', message: 'hand-thrown' }).message).toBe('hand-thrown');
    expect(serializeError({ code: 'X' }).message).toBe('a non-Error value was thrown');
    expect(serializeError(new Error('')).message).toBe('');
  });

  test('an error with no frames has no `stack` key at all', () => {
    const error = new Error('no stack');
    error.stack = 'Error: no stack';
    expect(serializeError(error)).not.toHaveProperty('stack');
  });
});

describe('summarize', () => {
  test('values that JSON cannot hold get a shape that says what they were', () => {
    expect(summarize(new Uint8Array(4))).toEqual({ type: 'bytes', bytes: 4 });
    expect(summarize(new ArrayBuffer(8))).toEqual({ type: 'bytes', bytes: 8 });
    expect(summarize(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01T00:00:00.000Z');
    expect(summarize(new Date('nonsense'))).toBe('[invalid date]');
    expect(summarize(new URL('https://example.com/a'))).toBe('https://example.com/a');
    expect(summarize(/ab+c/iu)).toBe('/ab+c/iu');
    expect(summarize(10n)).toBe('10');
    expect(summarize(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(summarize(() => 1)).toBe('[function anonymous]');
    expect(summarize(Symbol('s'))).toBe('Symbol(s)');
    expect(summarize(new Map([['a', 1]]))).toEqual({ a: 1 });
    expect(summarize(new Set([1, 2]))).toEqual([1, 2]);
    expect(summarize(new Error('x'))).toMatchObject({ type: 'Error', message: 'x' });
  });

  test('cycles, depth and size are all bounded', () => {
    const cycle: Record<string, unknown> = { a: 1 };
    cycle['self'] = cycle;
    expect(summarize(cycle)).toEqual({ a: 1, self: '[circular]' });

    expect(JSON.stringify(summarize({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }))).toContain(
      '[depth]',
    );
    expect(summarize('x'.repeat(20), { maxStringLength: 5 })).toBe('xxxxx…[15 chars]');
    expect(summarize([1, 2, 3, 4], { maxEntries: 2 })).toEqual([1, 2, '… 2 more']);
    expect(summarize({ a: 1, b: 2, c: 3 }, { maxEntries: 2 })).toEqual({
      a: 1,
      b: 2,
      '…': '1 more',
    });
  });

  test('a getter that throws is `[unreadable]`, not an exception in the logger', () => {
    const hostile = {
      get boom(): string {
        throw new Error('nope');
      },
    };
    expect(summarize(hostile)).toBe('[unreadable]');
  });
});

describe('fingerprint', () => {
  test('the same error from the same place groups; a different place does not', () => {
    const first = new Error('boom');
    const second = new Error('boom');
    const withCode = (code: string): Error => Object.assign(new Error('boom'), { code });

    expect(fingerprintOf({ error: first, route: 'POST /x' })).toBe(
      fingerprintOf({ error: second, route: 'POST /x' }),
    );
    expect(fingerprintOf({ error: withCode('A'), route: 'POST /x' })).not.toBe(
      fingerprintOf({ error: withCode('B'), route: 'POST /x' }),
    );
    expect(fingerprintOf({ error: first, route: 'POST /x' })).not.toBe(
      fingerprintOf({ error: first, route: 'GET /y' }),
    );
  });

  test('ids and timestamps in the message do not split a group, because only the code is used', () => {
    const a = Object.assign(new Error('order inv_1 failed'), { code: 'ORD_FAILED' });
    const b = Object.assign(new Error('order inv_2 failed'), { code: 'ORD_FAILED' });
    expect(fingerprintOf({ error: a })).toBe(fingerprintOf({ error: b }));
  });

  test('the shape is a short hex string, and a missing error still fingerprints', () => {
    expect(fingerprintOf({ error: new Error('x') })).toMatch(/^[0-9a-f]{8}$/u);
    expect(fingerprintOf({})).toMatch(/^[0-9a-f]{8}$/u);
    expect(fingerprintOf({ event: 'a.b' })).not.toBe(fingerprintOf({ event: 'a.c' }));
  });
});

describe('formats', () => {
  test('`tsir` is the canonical record, unchanged', () => {
    expect(JSON.parse(formatRecord(record, 'tsir'))).toEqual(record);
  });

  test('`ecs` renames the fields Kibana and OpenSearch expect', () => {
    const ecs = toEcs({
      ...record,
      level: 'error',
      err: { type: 'TypeError', message: 'bad', stack: ['at a', 'at b'] },
    });

    expect(ecs['@timestamp']).toBe(record.ts);
    expect(ecs['log.level']).toBe('error');
    expect(ecs['event.action']).toBe('invoice.paid');
    expect(ecs['trace.id']).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(ecs['transaction.id']).toBe('req_1');
    expect(ecs['service.name']).toBe('api');
    expect(ecs['error']).toEqual({ type: 'TypeError', message: 'bad', stack_trace: 'at a\nat b' });
    expect(ecs['ecs.version']).toBe('8.11.0');
    // Extras pass through unchanged, so a project's own fields are still queryable.
    expect(ecs['invoiceId']).toBe('inv_123');
    expect(ecs['message']).toBe('invoice paid');
  });

  test('`ecs` falls back to the event name when there is no message', () => {
    // The same record minus `msg`, written out so nothing is destructured just to be discarded.
    const withoutMessage: SafeRecord = {
      ts: record.ts,
      level: record.level,
      event: record.event,
      v: record.v,
      requestId: record['requestId'],
      traceId: record['traceId'],
      service: record['service'],
      invoiceId: record['invoiceId'],
      amountCents: record['amountCents'],
    };
    const ecs = toEcs(withoutMessage);
    expect(ecs['message']).toBe('invoice.paid');
  });

  test('`cloudwatch` uses a millisecond timestamp and a flat error string', () => {
    const cloudwatch = toCloudwatch({
      ...record,
      level: 'error',
      err: { type: 'TypeError', message: 'bad' },
    });
    expect(cloudwatch['timestamp']).toBe(Date.parse(record.ts));
    expect(cloudwatch['level']).toBe('error');
    expect(cloudwatch['message']).toBe('invoice paid');
    expect(cloudwatch['event']).toBe('invoice.paid');
    expect(cloudwatch['error']).toBe('TypeError: bad');
    expect(cloudwatch['invoiceId']).toBe('inv_123');
    expect(cloudwatch['v']).toBe(1);
  });

  test('`otlp-json` is an OTLP LogRecord, with severity and attributes', () => {
    const otlp = toOtlp({
      ...record,
      level: 'fatal',
      err: { type: 'Error', message: 'dead', stack: ['at a'] },
    });

    expect(otlp['timeUnixNano']).toBe('1793232000000000000');
    expect(otlp['severityNumber']).toBe(21);
    expect(otlp['severityText']).toBe('FATAL');
    expect(otlp['body']).toEqual({ stringValue: 'invoice.paid' });

    const attributes = otlp['attributes'] as { key: string; value: { stringValue: string } }[];
    const byKey = new Map(attributes.map((entry) => [entry.key, entry.value.stringValue]));
    expect(byKey.get('event.name')).toBe('invoice.paid');
    expect(byKey.get('invoiceId')).toBe('inv_123');
    expect(byKey.get('amountCents')).toBe('4200');
    expect(byKey.get('exception.type')).toBe('Error');
    expect(byKey.get('exception.message')).toBe('dead');
    expect(byKey.get('exception.stacktrace')).toBe('at a');
    // A non-scalar extra is JSON in a string value, which is what OTLP's AnyValue allows.
    expect(byKey.get('service')).toBe('api');
  });

  test('every severity maps to a number OTel recognises', () => {
    const numbers = LOG_LEVELS.map((level) => toOtlp({ ...record, level })['severityNumber']);
    expect(numbers).toEqual([5, 9, 13, 17, 21]);
  });

  test('an unknown format is refused, and the list is the source of truth', () => {
    expect(LOG_FORMATS).toEqual(['tsir', 'ecs', 'cloudwatch', 'otlp-json']);
    expect(assertFormat('ecs')).toBe('ecs');
    expect(() => assertFormat('logfmt')).toThrow(
      /expected one of tsir, ecs, cloudwatch, otlp-json/u,
    );
    expect(() => assertFormat(undefined)).toThrow(/format is "undefined"/u);
  });
});
