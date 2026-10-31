/**
 * Sinks (`OBS-021`).
 *
 * A sink receives a **`SafeRecord`** — already redacted, already normalised. That is the contract
 * that keeps redaction in one place: a driver cannot be handed the raw fields even by accident,
 * because the type it is given has no way to carry them.
 *
 * Three shipped here, in the order a Cloudflare-first project should reach for them:
 *
 * · `stdout` — the default everywhere. Workers Logs collects it with no configuration, Lambda sends
 * it to CloudWatch, a container sends it to whatever is scraping. Zero dependencies, zero setup.
 * · `memory` — tests and benchmarks, and the sink the test suite asserts against.
 * · `fanout` — several sinks with **fail-open** semantics: a sink that throws is disabled for the
 * rest of the invocation, reported once, counted, and the request is unaffected. A telemetry bug
 * must never turn a 200 into a 500.
 *
 * `required: true` is the one way to invert fail-open, and it is deliberately not a request-path
 * decision: a required sink that fails marks readiness instead.
 */

import { sinkFailed } from './errors.ts';
import { assertFormat, formatRecord, type LogFormat } from './formats.ts';
import type { SafeRecord } from './record.ts';

export interface Sink {
  /** A stable name, used in the "sink failed" record and as a metric label. */
  readonly name: string;
  write(record: SafeRecord): void;
  /** Called at the end of an invocation, if the sink buffers. */
  flush?(): void | Promise<void>;
}

export interface StdoutSinkOptions {
  readonly name?: string | undefined;
  /** Default `tsir`. Chosen once at boot; a driver never re-maps the record. */
  readonly format?: LogFormat | undefined;
  /** The write function. Defaults to `process.stdout.write`, falling back to `console.log`. */
  readonly write?: ((line: string) => void) | undefined;
}

export function stdoutSink(options: StdoutSinkOptions = {}): Sink {
  const format = assertFormat(options.format ?? 'tsir');
  return {
    name: options.name ?? 'stdout',
    write(record) {
      const line = formatRecord(record, format);
      if (options.write !== undefined) {
        options.write(line);
        return;
      }
      const stdout = (globalThis as { process?: { stdout?: { write?: (text: string) => void } } })
        .process?.stdout;
      if (stdout?.write !== undefined) {
        stdout.write(`${line}\n`);
        return;
      }
      // Workers have no `process.stdout`; `console.log` lands in Workers Logs the same way. This is
      // the one `console` call in the framework, and it is the fallback, not a debugging aid.
      // eslint-disable-next-line no-console
      console.log(line);
    },
  };
}

export interface MemorySink extends Sink {
  /** Every record written, in order. Redacted, because that is all a sink is given. */
  readonly records: readonly SafeRecord[];
  /** Every line, if the sink was built with a format — for asserting the wire shape. */
  readonly lines: readonly string[];
  readonly count: number;
  clear(): void;
}

export function memorySink(
  options: { readonly name?: string | undefined; readonly format?: LogFormat | undefined } = {},
): MemorySink {
  const format = options.format === undefined ? undefined : assertFormat(options.format);
  const records: SafeRecord[] = [];
  const lines: string[] = [];

  return {
    name: options.name ?? 'memory',
    get records() {
      return records;
    },
    get lines() {
      return lines;
    },
    get count() {
      return records.length;
    },
    write(record) {
      records.push(record);
      if (format !== undefined) lines.push(formatRecord(record, format));
    },
    clear() {
      records.length = 0;
      lines.length = 0;
    },
  };
}

export interface FanoutOptions {
  /** Called once per failing sink. Default: nothing — the logger that owns the sink reports it. */
  readonly onError?:
    ((failure: { readonly sink: string; readonly error: unknown }) => void) | undefined;
  /** Sinks whose failure is fatal to the request path. Empty by default; see the docblock. */
  readonly required?: readonly string[] | undefined;
}

export interface FanoutSink extends Sink {
  /** Names of the sinks disabled by a failure, in the order they failed. */
  readonly disabled: readonly string[];
  readonly dropped: number;
}

/**
 * Several sinks, one `write`.
 *
 * Failure handling is per sink and latched: the first throw disables that sink for the life of the
 * process (a broken socket does not heal mid-invocation, and retrying it once per record is how a log
 * path becomes the outage). Every failure is counted, and the *first* one is reported to `onError` —
 * so an operator sees "the OTLP sink is down", once, rather than a silent gap.
 */
export function fanoutSink(sinks: readonly Sink[], options: FanoutOptions = {}): FanoutSink {
  const broken = new Set<string>();
  const requiredNames = new Set(options.required ?? []);
  let dropped = 0;

  return {
    name: 'fanout',

    get disabled() {
      return [...broken];
    },
    get dropped() {
      return dropped;
    },

    write(record) {
      for (const sink of sinks) {
        if (broken.has(sink.name)) {
          dropped += 1;
          continue;
        }
        try {
          sink.write(record);
        } catch (error: unknown) {
          if (requiredNames.has(sink.name)) throw sinkFailed(sink.name, describe(error));
          broken.add(sink.name);
          dropped += 1;
          options.onError?.({ sink: sink.name, error });
        }
      }
    },

    async flush() {
      for (const sink of sinks) {
        if (broken.has(sink.name) || sink.flush === undefined) continue;
        try {
          await sink.flush?.();
        } catch (error: unknown) {
          broken.add(sink.name);
          options.onError?.({ sink: sink.name, error });
        }
      }
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
