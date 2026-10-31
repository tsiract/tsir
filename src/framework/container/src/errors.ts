/**
 * The Tsir error base.
 *
 * Hosted by `@tsir/container` because it is the lowest-level package in the
 * dependency graph.
 * Application and framework code import it from `@tsir/core`, which re-exports
 * this exact class — there is one error type, not two.
 *
 * Rules:
 *   · codes are stable and append-only
 *   · messages are safe to log and never contain secrets
 *   · `cause` is preserved for debugging but never serialized to clients
 */

/**
 * Codes raised by `@tsir/container` (`CTN-*`), plus the fallback used when an unknown throw is
 * normalized at a boundary. The union is the registry checked by `check-error-codes`.
 */
export type ContainerErrorCode =
  | 'CTN_DUPLICATE'
  | 'CTN_OVERRIDE_UNKNOWN'
  | 'CTN_ASYNC_PROVIDER'
  | 'CTN_DISPOSED'
  | 'CTN_NO_PROVIDER'
  | 'CTN_CYCLE'
  | 'CTN_DEPTH'
  | 'CTN_NO_SCOPE'
  | 'CTN_FACTORY_FAILED'
  | 'CTN_DISPOSE_FAILED'
  | 'INTERNAL_UNEXPECTED';

export type ErrorKind =
  | 'config'
  | 'container'
  | 'http'
  | 'database'
  | 'vault'
  | 'link'
  | 'deploy'
  | 'capability'
  | 'validation'
  | 'internal';

export type ErrorContextValue = string | number | boolean;
export type ErrorContext = Readonly<Record<string, ErrorContextValue>>;

export interface TsirErrorInit {
  readonly kind: ErrorKind;
  readonly hint?: string;
  readonly cause?: unknown;
  readonly context?: ErrorContext;
}

export class TsirError extends Error {
  readonly code: string;
  readonly kind: ErrorKind;
  readonly hint: string | undefined;
  readonly context: ErrorContext | undefined;

  constructor(code: string, message: string, init: TsirErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'TsirError';
    this.code = code;
    this.kind = init.kind;
    this.hint = init.hint;
    this.context = init.context;

    if (Error.captureStackTrace !== undefined) {
      Error.captureStackTrace(this, TsirError);
    }
  }

  /** Shape used by logs and CLI output. Never includes `cause` or `stack`. */
  toLogObject(): Readonly<Record<string, unknown>> {
    return {
      code: this.code,
      kind: this.kind,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.context === undefined ? {} : { context: this.context }),
    };
  }

  /** One-line rendering for CLI and boot reports. */
  format(): string {
    const hint = this.hint === undefined ? '' : `\n  ↳ ${this.hint}`;
    return `[${this.code}] ${this.message}${hint}`;
  }

  /**
   * ERR-005: the two renderings a failure needs. `dev` is for a person at a terminal — the hint
   * and the stack are the point. `prod` is for a log pipeline — one line, machine-splittable, and
   * no stack, because a stack in a log line is the first thing a log search chokes on and the last
   * thing a caller should see. Neither mode prints `context` (it can hold request data) or `cause`.
   *
   * `colour` is opt-in: a library does not guess whether its output is a TTY.
   */
  formatFor(mode: 'dev' | 'prod', options: FormatOptions = {}): string {
    return mode === 'dev' ? this.#formatDev(options) : this.#formatProd(options);
  }

  #formatDev(options: FormatOptions): string {
    const mark = options.colour === true ? '\x1b[31m✗\x1b[0m' : '✗';
    const lines = [`${mark} ${this.message}`];
    if (this.hint !== undefined) lines.push(`  ↳ ${this.hint}`);
    lines.push(`  code: ${this.code} · kind: ${this.kind}`);
    if (this.stack !== undefined) {
      // The first line of `stack` repeats the message; the frames are what the stack adds.
      const frames = this.stack.split('\n').slice(1);
      for (const frame of frames) lines.push(frame.replace(/^\s*/u, '    '));
    }
    return lines.join('\n');
  }

  #formatProd(options: FormatOptions): string {
    // A message can carry user input (`unknown event "x"`), so its line breaks are collapsed:
    // one record must stay one line, or a newline in input becomes a forged log entry.
    const message = this.message.replace(/\s*[\r\n]+\s*/gu, ' ').replace(/"/gu, '\\"');
    const correlation = options.correlationId ?? '-';
    return `level=error code=${this.code} kind=${this.kind} correlation_id=${correlation} message="${message}"`;
  }
}

export interface FormatOptions {
  /** Colour the dev rendering. Off by default: the caller decides, not the library. */
  readonly colour?: boolean;
  /** Carried into the prod line so one request's failures can be found together. */
  readonly correlationId?: string;
}

export function isTsirError(value: unknown): value is TsirError {
  return value instanceof TsirError;
}

/**
 * Normalizes anything thrown into a `TsirError`. Used at boundaries so that
 * callers never have to reason about a mixed error surface.
 */
export function normalizeError(value: unknown, fallbackCode = 'INTERNAL_UNEXPECTED'): TsirError {
  if (value instanceof TsirError) return value;
  if (value instanceof Error) {
    return new TsirError(fallbackCode, value.message, { kind: 'internal', cause: value });
  }
  return new TsirError(fallbackCode, 'Unexpected non-error value thrown', {
    kind: 'internal',
    cause: value,
  });
}
