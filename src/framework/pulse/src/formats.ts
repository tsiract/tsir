/**
 * Wire formats.
 *
 * A log written for a Tsir dashboard is a log an operator cannot read in the tool they already have.
 * So the record shape is canonical, and the **format** is the one place a field is renamed:
 *
 * | format | what reads it |
 * | ----------- | ------------------------------------------------- |
 * | `tsir` | anything; the canonical JSON line |
 * | `ecs` | Kibana, OpenSearch, Elastic Agent |
 * | `cloudwatch`| CloudWatch Logs Insights, Lambda stdout |
 * | `otlp-json` | any OTel collector → Loki, Tempo, Datadog, … |
 *
 * The mapping happens here and only here. If a sink needs a different field name, the formatter
 * changes — not the driver — otherwise every new driver re-implements the mapping and one of them
 * gets `error.message` wrong, which is exactly the field someone needs during an incident.
 *
 * Nothing in this file consumes unredacted input: a `SafeRecord` is the only argument, so a format
 * cannot be the layer that forgets.
 */

import { configInvalid } from './errors.ts';
import { LEVEL_SEVERITY, type LogLevel, type SafeRecord, type SerializedError } from './record.ts';

export type LogFormat = 'tsir' | 'ecs' | 'cloudwatch' | 'otlp-json';

export const LOG_FORMATS: readonly LogFormat[] = ['tsir', 'ecs', 'cloudwatch', 'otlp-json'];

export function assertFormat(format: unknown): LogFormat {
  if (typeof format !== 'string' || !(LOG_FORMATS as readonly string[]).includes(format)) {
    throw configInvalid(`format is "${String(format)}"; expected one of ${LOG_FORMATS.join(', ')}`);
  }
  return format as LogFormat;
}

/** The keys a format owns; every other field is an "extra" and is passed through. */
const RESERVED = new Set(['ts', 'level', 'event', 'v', 'msg', 'err', 'fingerprint', 'occurrences']);

export function formatRecord(record: SafeRecord, format: LogFormat = 'tsir'): string {
  switch (format) {
    case 'tsir':
      return JSON.stringify(record);
    case 'ecs':
      return JSON.stringify(toEcs(record));
    case 'cloudwatch':
      return JSON.stringify(toCloudwatch(record));
    case 'otlp-json':
      return JSON.stringify(toOtlp(record));
    default: {
      // Unreachable with the union type, and a compile error if the union grows without a branch.
      throw configInvalid(`unknown format "${String(format)}"`);
    }
  }
}

function extras(record: SafeRecord): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!RESERVED.has(key)) output[key] = value;
  }
  return output;
}

/**
 * ECS 8: `@timestamp`, `log.level`, `message`, `error.*`, `trace.id`, `transaction.id`.
 *
 * `service.name` is passed through when the record carries it — ECS uses it heavily, and a
 * multi-service deployment filtered by `service.name` is the first query anybody writes.
 */
export function toEcs(record: SafeRecord): Record<string, unknown> {
  const { err, ...rest } = record;
  const error = err as SerializedError | undefined;
  const traceId = rest['traceId'];
  const requestId = rest['requestId'];
  const service = rest['service'];

  return {
    '@timestamp': record.ts,
    'log.level': record.level,
    message: typeof rest['msg'] === 'string' ? rest['msg'] : record.event,
    'event.action': record.event,
    'event.dataset': 'tsir',
    ...(typeof traceId === 'string' ? { 'trace.id': traceId } : {}),
    ...(typeof requestId === 'string' ? { 'transaction.id': requestId } : {}),
    ...(typeof service === 'string' ? { 'service.name': service } : {}),
    ...(error === undefined
      ? {}
      : {
          error: {
            type: error.type,
            message: error.message,
            ...(error.code === undefined ? {} : { code: error.code }),
            ...(error.stack === undefined ? {} : { stack_trace: error.stack.join('\n') }),
          },
        }),
    ...extras({ ...rest, v: record.v }),
    'ecs.version': '8.11.0',
    'log.schema_version': record.v,
  };
}

/** CloudWatch Logs JSON: a `timestamp` in **milliseconds**, a `message`, and flattened extras. */
export function toCloudwatch(record: SafeRecord): Record<string, unknown> {
  const { err, ...rest } = record;
  const error = err as SerializedError | undefined;
  return {
    timestamp: Date.parse(record.ts),
    level: record.level,
    message: typeof rest['msg'] === 'string' ? rest['msg'] : record.event,
    event: record.event,
    ...(error === undefined ? {} : { error: `${error.type}: ${error.message}` }),
    ...extras(rest),
    v: record.v,
  };
}

/** OTLP/JSON `LogRecord`: nanosecond time, `severityNumber`, `body`, `attributes`. */
export function toOtlp(record: SafeRecord): Record<string, unknown> {
  const { err, ...rest } = record;
  const error = err as SerializedError | undefined;
  const attributes: { key: string; value: { stringValue: string } }[] = [
    { key: 'event.name', value: { stringValue: record.event } },
    { key: 'log.schema_version', value: { stringValue: String(record.v) } },
  ];

  for (const [key, value] of Object.entries(extras(rest))) {
    attributes.push({ key, value: { stringValue: scalarToString(value) } });
  }
  if (error !== undefined) {
    attributes.push({ key: 'exception.type', value: { stringValue: error.type } });
    attributes.push({ key: 'exception.message', value: { stringValue: error.message } });
    if (error.stack !== undefined) {
      attributes.push({
        key: 'exception.stacktrace',
        value: { stringValue: error.stack.join('\n') },
      });
    }
  }

  return {
    timeUnixNano: `${String(Date.parse(record.ts))}000000`,
    severityNumber: severityNumber(record.level),
    severityText: record.level.toUpperCase(),
    body: { stringValue: record.event },
    attributes,
  };
}

/** OTLP's severity numbers, mapped from the five levels this package has. */
function severityNumber(level: LogLevel): number {
  switch (level) {
    case 'debug':
      return 5; // DEBUG
    case 'info':
      return 9; // INFO
    case 'warn':
      return 13; // WARN
    case 'error':
      return 17; // ERROR
    case 'fatal':
      return 21; // FATAL
  }
}

function scalarToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

/** Re-exported so a formatter test can assert the same table the record uses. */
export { LEVEL_SEVERITY };
