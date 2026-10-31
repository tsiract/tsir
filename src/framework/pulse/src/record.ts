/**
 * The log record.
 *
 * One shape, produced here and nowhere else, for one reason: a log line is **data for a query
 * language**, not a sentence for a human. `invoice.paid` plus fields is searchable; `"Invoice paid for
 * inv_123"` is not, in any backend. The consequences:
 *
 * · **Event names, not sentences.** `dot.case`, `v: 1` for the schema version. Adding a field is
 * compatible; renaming one is not, which is why `v` exists.
 * · **An error is an object, never a multi-line string.** `type`, `message`, `stack[]`, `code`,
 * recursive `cause` — because CloudWatch Insights, Kibana and LogsQL all index fields, and none
 * of them index prose. A stack is an array of frames, capped, with a note that it was capped.
 * · **Non-serializable values are summarised, never `JSON.stringify`-ed blindly.** A `Map`, a
 * `Buffer`, a circular graph or a 40 MB payload each have a summary that costs a few bytes and
 * tells you what it was.
 * · **`fingerprint` is stable.** Error code plus origin plus route, no ids — so deduplication is
 * possible in every backend, not only in this one.
 */

/** Severity, ordered. `fatal` is for "the process is going down", which is not the same as `error`. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];

/** Numeric severities, matching OpenTelemetry's mapping closely enough to translate without a table. */
export const LEVEL_SEVERITY: Readonly<Record<LogLevel, number>> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

export const LOG_SCHEMA_VERSION = 1;

/** What a sink receives: already redacted, and typed so a sink cannot be handed raw fields. */
export interface SafeRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly v: number;
  readonly msg?: string | undefined;
  readonly [field: string]: unknown;
}

export interface SerializedError {
  readonly type: string;
  readonly message: string;
  readonly code?: string | undefined;
  readonly stack?: readonly string[] | undefined;
  readonly cause?: SerializedError | undefined;
  /** Set when the cause chain or the stack was cut short, so a reader knows it is incomplete. */
  readonly truncated?: boolean | undefined;
}

export interface SerializeOptions {
  /** Default 10. A 200-frame stack is a log line nobody can read and a bill nobody wants. */
  readonly maxStackFrames?: number | undefined;
  /** Default 3. `cause` chains in real applications are deep and mostly noise past three. */
  readonly maxCauseDepth?: number | undefined;
  /** Default 50 entries per object/array and 2 048 characters per string. */
  readonly maxEntries?: number | undefined;
  readonly maxStringLength?: number | undefined;
}

const DEFAULTS = {
  maxStackFrames: 10,
  maxCauseDepth: 3,
  maxEntries: 50,
  maxStringLength: 2_048,
} as const;

/**
 * Normalise anything thrown into `SerializedError`.
 *
 * A thrown string, a thrown object and a rejected promise with no reason all arrive here, and all
 * produce a record with a `type` — because "the error was an empty rejection" is a fact worth
 * logging, and `err: null` is not.
 */
export function serializeError(error: unknown, options: SerializeOptions = {}): SerializedError {
  const maxCauseDepth = options.maxCauseDepth ?? DEFAULTS.maxCauseDepth;
  return serialize(error, 0, maxCauseDepth, options);
}

function serialize(
  error: unknown,
  depth: number,
  maxCauseDepth: number,
  options: SerializeOptions,
): SerializedError {
  const maxStackFrames = options.maxStackFrames ?? DEFAULTS.maxStackFrames;

  if (error instanceof Error) {
    const frames = (error.stack ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('at ') || line.startsWith('@'));
    const stack = frames.slice(0, maxStackFrames);
    const code = (error as { code?: unknown }).code;
    const cause = (error as { cause?: unknown }).cause;

    return {
      type: error.name === '' ? 'Error' : error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
      ...(stack.length === 0 ? {} : { stack }),
      ...(cause === undefined
        ? {}
        : depth < maxCauseDepth
          ? { cause: serialize(cause, depth + 1, maxCauseDepth, options) }
          : { truncated: true }),
      ...(frames.length > stack.length ? { truncated: true } : {}),
    };
  }

  if (typeof error === 'string') {
    return { type: 'ThrownString', message: error };
  }
  if (error === null || error === undefined) {
    return { type: 'Unknown', message: 'nothing was thrown' };
  }

  // A plain object thrown by hand: keep its shape, but never its `stack` as a string.
  const summary = summarize(error, options);
  const message =
    typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : 'a non-Error value was thrown';
  return {
    type: typeof error === 'object' ? 'ThrownObject' : `Thrown${typeof error}`,
    message,
    cause: { type: 'Value', message: JSON.stringify(summary) ?? 'unserializable' },
  };
}

/**
 * A value as it may appear in a record: JSON-safe, bounded, and self-describing when it is not.
 *
 * Cycles become `'[circular]'`; a `Buffer` becomes `{ type: 'bytes', bytes: n }` rather than 4 000
 * array entries; a function becomes its name. Nothing here is allowed to throw — a logger that
 * throws on a weird object is a logger that stops logging exactly when something weird happened.
 */
export function summarize(value: unknown, options: SerializeOptions = {}): unknown {
  const maxEntries = options.maxEntries ?? DEFAULTS.maxEntries;
  const maxStringLength = options.maxStringLength ?? DEFAULTS.maxStringLength;
  return visit(value, 0, new WeakSet<object>(), maxEntries, maxStringLength);
}

const MAX_DEPTH = 6;

function visit(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  maxEntries: number,
  maxStringLength: number,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}…[${String(value.length - maxStringLength)} chars]`
      : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function')
    return `[function ${value.name === '' ? 'anonymous' : value.name}]`;
  if (typeof value === 'symbol') return value.toString();

  const object = value;
  if (seen.has(object)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[depth]';
  seen.add(object);

  try {
    if (value instanceof Date)
      return Number.isNaN(value.getTime()) ? '[invalid date]' : value.toISOString();
    if (value instanceof Error) return serializeError(value, { maxEntries, maxStringLength });
    if (value instanceof ArrayBuffer) return { type: 'bytes', bytes: value.byteLength };
    if (ArrayBuffer.isView(value)) return { type: 'bytes', bytes: value.byteLength };
    if (value instanceof URL) return value.toString();
    if (value instanceof RegExp) return value.toString();
    if (value instanceof Map) {
      return visit(Object.fromEntries(value), depth, seen, maxEntries, maxStringLength);
    }
    if (value instanceof Set) {
      return visit([...value], depth + 1, seen, maxEntries, maxStringLength);
    }
    if (Array.isArray(value)) {
      const items = value
        .slice(0, maxEntries)
        .map((item) => visit(item, depth + 1, seen, maxEntries, maxStringLength));
      return items.length < value.length
        ? [...items, `… ${String(value.length - items.length)} more`]
        : items;
    }

    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    const keys = Object.keys(source);
    for (const [index, key] of keys.entries()) {
      if (index >= maxEntries) {
        output['…'] = `${String(keys.length - index)} more`;
        break;
      }
      output[key] = visit(source[key], depth + 1, seen, maxEntries, maxStringLength);
    }
    return output;
  } catch {
    // A getter that throws is still a value that was there.
    return '[unreadable]';
  }
}

/**
 * A stable identity for "this same error, from this same place".
 *
 * Code, origin and route — never an id, a timestamp or a message with a value interpolated into it,
 * because the whole point is that two occurrences look identical. Truncated to 16 hex characters:
 * the fingerprint is for grouping, not for security.
 */
export function fingerprintOf(input: {
  readonly error?: unknown;
  readonly origin?: string | undefined;
  readonly route?: string | undefined;
  readonly event?: string | undefined;
}): string {
  const serialized =
    input.error === undefined ? undefined : serializeError(input.error, { maxCauseDepth: 1 });
  const parts = [
    serialized?.code ?? serialized?.type ?? 'none',
    input.origin ?? '',
    input.route ?? '',
    input.event ?? '',
  ];
  // FNV-1a 64 is unnecessary here: this is a grouping key over a tiny string, and a 53-bit sum
  // collision in a 10-second window is not a failure mode anybody has to care about.
  let hash = 0xcbf2_9ce4;
  const text = parts.join('\u0000');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
