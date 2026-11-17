/**
 * Loading and validating configuration.
 *
 * Precedence: explicit overrides > environment > schema default.
 * Failure behavior: *all* issues are collected before throwing, so a
 * misconfigured deployment reports every problem in one boot.
 */

import { validateSync } from '@tsir/validate';

import { Redacted } from './redacted.ts';
import { isSecretName } from './secrets.ts';
import { configError, configInvalid, formatConfigReport, type ConfigIssue } from './errors.ts';
import type { ConfigSpec, FieldSpec, InferConfig } from './define.ts';

export type EnvRecord = Readonly<Record<string, string | undefined>>;

export interface LoadOptions {
  /** Environment source. Defaults to `Bun.env` (falling back to `process.env`). */
  readonly env?: EnvRecord;
  /** Explicit overrides — tests and embedders only; they win over the environment. */
  readonly overrides?: Readonly<Record<string, string>>;
  /**
   * Root-level defaults, typically from the project file (`tsir.js` `modules.<name>`).
   * Lowest precedence: overrides > env > schema default > baseDefaults.
   */
  readonly baseDefaults?: Readonly<Record<string, unknown>>;
  /** Treat unknown keys with the `TSIR_` prefix as errors. Default false (warning). */
  readonly strictEnv?: boolean;
  /** App name used in reports. */
  readonly appName?: string;
  /** Reports unknown-key warnings. */
  readonly onWarning?: (message: string) => void;
}

export interface LoadedConfig<T> {
  readonly values: T;
  readonly appName: string;
  /** Masked view for logs and `tsir config:dump`. */
  readonly masked: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
}

export interface ConfigLifecycle {
  /** Reads configuration, throwing `CFG_INVALID` when anything fails. */
  load(): LoadedConfig<InferConfig<ConfigSpec>>;
}

const RESERVED_PREFIX = 'TSIR_';

/**
 * `TSIR_`-prefixed names the CLI sets for its own purposes rather than for the application.
 *
 * The prefix is reserved so a typo in an application key is caught (`TSIR_PORT` for `PORT` warns
 * instead of being silently ignored). These particular names are not application configuration at
 * all — they are how the toolchain tells itself where something lives — so reporting them as
 * unknown application keys is a false alarm in every app the toolchain itself creates. `TSIR_DIST`
 * is exported by the distribution's `tsir new`, and the warning appeared in a freshly scaffolded
 * application's `tsir doctor` before the developer had configured anything.
 */
const TOOLCHAIN_ENV = new Set([
  'TSIR_DIST',
  // `TSIR_TUI=ascii` switches the shared terminal layer to ASCII glyphs (`@tsir/tui`), and
  // `TSIR_NO_INTERACTIVE=1` forbids prompts. Both are read by the toolchain, never by the
  // application, so an application's `tsir doctor` must not report them as unknown keys.
  'TSIR_TUI',
  'TSIR_NO_INTERACTIVE',
]);

function defaultEnv(): EnvRecord {
  const bun = (globalThis as { Bun?: { env: EnvRecord } }).Bun;
  if (bun !== undefined && typeof bun.env === 'object') return bun.env;
  const process = (globalThis as { process?: { env?: EnvRecord } }).process;
  return process?.env ?? {};
}

function isRedactedField(spec: FieldSpec<unknown, boolean>): boolean {
  return spec.secret === true;
}

/**
 * Hashes a secret for correlation without revealing it.
 * Not used for storage or comparison — only for operator-facing reports.
 */
export async function fingerprint(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest).slice(0, 6)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function loadConfig<S extends ConfigSpec>(
  spec: S,
  options: LoadOptions = {},
): LoadedConfig<InferConfig<S>> {
  const env = options.env ?? defaultEnv();
  const overrides = options.overrides ?? {};
  const baseDefaults = options.baseDefaults ?? {};
  const appName = options.appName ?? 'tsir-app';
  const issues: ConfigIssue[] = [];
  const warnings: string[] = [];
  const values: Record<string, unknown> = {};
  const masked: Record<string, unknown> = {};

  for (const [key, field] of Object.entries<FieldSpec<unknown, boolean>>(spec)) {
    const override = overrides[key];
    const base = baseDefaults[key];
    const raw = override ?? env[key];
    const fromBase = raw === undefined && !field.hasDefault && base !== undefined;
    const source =
      override !== undefined
        ? 'override'
        : raw !== undefined
          ? 'env'
          : fromBase
            ? 'base-default'
            : 'default';

    const hasValue = raw !== undefined || field.hasDefault || base !== undefined;

    if (!hasValue) {
      issues.push({
        key,
        message: field.secret ? 'required (secret)' : 'required',
        source,
        code: 'missing',
      });
      continue;
    } else if (override !== undefined && !field.overridable) {
      issues.push({
        key,
        message: 'not overridable; set it in the environment instead',
        source,
        code: 'not-overridable',
      });
      continue;
    }

    // Precedence: override > env > schema default > base default.
    // Base defaults come from the project file (typed JS values) while env
    // schemas parse from strings, so non-string base defaults are stringified
    // to match the input form the schema expects.
    let baseInput: unknown;
    if (base === null || typeof base === 'string') {
      baseInput = base;
    } else if (typeof base === 'number' || typeof base === 'boolean') {
      baseInput = String(base);
    } else if (typeof base === 'object') {
      baseInput = JSON.stringify(base);
    } else {
      // symbol, bigint, undefined, or function — none use Object's default
      // toString, so String() is safe. The typed local satisfies no-base-to-string.
      const nonObjectBase = base as symbol | bigint | undefined | ((...args: never[]) => unknown);
      baseInput = String(nonObjectBase);
    }
    const input = raw !== undefined ? raw : field.hasDefault ? field.defaultInput : baseInput;

    // `validateSync` throws `VLD_ASYNC_SCHEMA` for async validators: boot must
    // never continue on a value nobody awaited.
    const parsed = validateSync(field.schema, input);
    if (!parsed.ok) {
      const first = parsed.issues[0];
      issues.push({
        key,
        message: first === undefined ? 'invalid value' : first.message,
        source,
        code: 'invalid',
      });
      continue;
    }

    // Secret fields are wrapped so they cannot be logged or serialized by accident.
    // A key named like a secret (`FOO_PASSWORD`) is redacted even without `.secret()` (`CFG-005`).
    const redacted = isRedactedField(field) || isSecretName(key);
    values[key] = redacted ? new Redacted(parsed.value, key) : parsed.value;
    masked[key] = redacted ? '[redacted]' : parsed.value;
  }

  for (const key of Object.keys(env)) {
    if (!(key in spec) && key.startsWith(RESERVED_PREFIX) && !TOOLCHAIN_ENV.has(key)) {
      const message = `unknown configuration key "${key}"`;
      if (options.strictEnv === true) {
        issues.push({ key, message, source: 'env', code: 'unknown' });
      } else {
        warnings.push(message);
      }
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in spec)) {
      issues.push({
        key,
        message: 'override for unknown key',
        source: 'override',
        code: 'unknown',
      });
      void value;
    }
  }

  if (issues.length > 0) {
    if (options.onWarning !== undefined) {
      for (const warning of warnings) options.onWarning(warning);
    }
    const error = configInvalid(issues);
    error.message = formatConfigReport(issues, appName);
    throw error;
  }

  for (const warning of warnings) options.onWarning?.(warning);

  const frozen = Object.freeze({ ...values }) as InferConfig<S>;
  const frozenMasked = Object.freeze({ ...masked });

  return { values: frozen, appName, masked: frozenMasked, warnings: [...warnings] };
}

/** Convenience wrapper used by modules that need a single required value. */
export function requireConfigValue<T>(config: LoadedConfig<Record<string, T>>, key: string): T {
  const value = config.values[key];
  if (value === undefined) {
    throw configError(
      'CFG_MISSING_KEY',
      `Configuration key "${key}" is not present`,
      'add it to the config schema',
    );
  }
  return value;
}
