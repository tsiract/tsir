/**
 * Redaction — three layers, defence in depth.
 *
 * Logs are the primary leak vector in a framework: the request body that a developer added "just to
 * debug", the connection string in a config dump, the session token in an error's `cause`. So the
 * default is that a secret is **never** written, and the three layers exist because each one alone
 * has a hole:
 *
 * 1. **Typed** — `Redacted<T>` cannot be serialized at all. `JSON.stringify` sees `"[redacted]"`,
 * template literals see `"[redacted]"`, and only `reveal` hands the value back — which is a
 * deliberate, greppable act that reports itself in development.
 * 2. **Path-based** — `redact.paths: ['body.password', 'user.email']` catches the fields a project
 * knows are sensitive, including ones whose keys look innocuous (`body.pin`, `payload.iban`).
 * 3. **Pattern-based** — key names matching `/(password|secret|token|authorization|cookie|api[-_]?key|…)/i`
 * are redacted by default, and a *value* that is shaped like a credential (a JWT, a PEM key, a
 * `tsk_…` API key, a long base64 blob) is redacted even under a harmless key such as `q`.
 *
 * The order matters: typed first (it cannot be inspected at all), then paths, then patterns. A field
 * matched by any layer is never written, and a layer that throws replaces the field with
 * `"[redaction-error]"` — refusing beats guessing.
 *
 * PII is a separate policy (`'omit'` by default) applied to person-shaped keys only. It is not part
 * of the secret rules because the two have different failure modes: a leaked secret is a breach, a
 * leaked email in a log is a GDPR finding, and an application may legitimately choose `'allow'` for
 * one and not the other.
 */

import { redactionFailed } from './errors.ts';
import { sha256Text } from './hash.ts';

/** What a redacted field becomes. One spelling, so a log query can filter on it. */
export const REDACTED = '[redacted]';
/** What an omitted PII field becomes, under `pii: 'omit'`. */
export const OMITTED = '[omitted]';
/** What a field becomes when the redactor itself failed. */
export const REDACTION_ERROR = '[redaction-error]';

export type PiiPolicy = 'omit' | 'hash' | 'allow';

/**
 * A value that must not be logged.
 *
 * The wrapper is the point: a `string` that happens to be a token is indistinguishable from a
 * `string` that happens to be a slug, so the type system carries the fact instead of a heuristic.
 * `Redacted` has no `toString`/`valueOf` escape hatch that leaks, and `toJSON` is the marker.
 */
export class Redacted<T> {
  readonly #value: T;
  readonly #label: string | undefined;

  constructor(value: T, label?: string) {
    this.#value = value;
    this.#label = label;
  }

  /** True, so `isRedacted` is a structural check as well as an `instanceof`. */
  readonly redacted = true as const;

  get label(): string | undefined {
    return this.#label;
  }

  /**
   * Hand the value back. This is the only way out, and it is loud on purpose.
   *
   * In development it calls the installed reveal handler (default: nothing) so a project can warn
   * on every use — a `reveal` in a log path is a bug, and a warning is how it gets noticed.
   */
  reveal(): T {
    Redacted.onReveal?.(this.#label ?? 'unnamed');
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Redacted(${this.#label ?? 'unnamed'})`;
  }

  /** Installed by an app (or by `@tsir/pulse`'s dev mode) to report every `reveal`. */
  static onReveal: ((label: string) => void) | undefined;
}

export function redacted<T>(value: T, label?: string): Redacted<T> {
  return new Redacted(value, label);
}

export function isRedacted(value: unknown): value is Redacted<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value instanceof Redacted || (value as { redacted?: unknown }).redacted === true)
  );
}

/** Unwrap a value that may or may not be redacted. Alias of `reveal`, for readability at call sites. */
export function reveal<T>(value: T | Redacted<T>): T {
  return isRedacted(value) ? value.reveal() : value;
}

// ── layer 3: what a secret looks like ───────────────────────────────────────

/** Key names that are always a secret, whatever their value looks like. */
export const SECRET_KEY =
  /(pass(word|phrase)?|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|credential|signature)/iu;

/** Values that are a credential whatever their key is called. */
const SECRET_VALUE: readonly {
  readonly kind: string;
  readonly matches: (value: string) => boolean;
}[] = [
  {
    kind: 'jwt',
    matches: (value) => /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u.test(value),
  },
  { kind: 'pem', matches: (value) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) },
  { kind: 'bearer', matches: (value) => /^Bearer\s+\S{8,}$/iu.test(value) },
  { kind: 'api-key', matches: (value) => /^(tsk|sk|pk|rk)_[A-Za-z0-9_-]{8,}/u.test(value) },
  {
    kind: 'provider-key',
    matches: (value) => /^(ghp|gho|github_pat|xox[baprs]|AKIA)[A-Za-z0-9_-]{8,}/u.test(value),
  },
  // A long base64 or hex blob is a key far more often than it is prose. 40 characters is above any
  // human-readable identifier and below a 256-bit secret in both alphabets.
  {
    kind: 'base64',
    matches: (value) =>
      value.length >= 40 && /^[A-Za-z0-9+/=_-]+$/u.test(value) && /[0-9]/u.test(value),
  },
];

/** Person-shaped keys. Bare `name` is deliberately absent: it is a route, a channel and a metric. */
const PII_KEY =
  /^(e?mail|phone|phoneNumber|mobile|ip|ipAddress|remoteAddress|address|street|fullName|firstName|lastName|dateOfBirth|dob|ssn|nationalId|taxId)$/iu;

export interface RedactionOptions {
  /** Exact or globbed paths: `body.password`, `user.email`, `items[*].card`, `secrets.**`. */
  readonly paths?: readonly string[] | undefined;
  /** Extra key patterns, added to `SECRET_KEY` rather than replacing it. */
  readonly keys?: readonly RegExp[] | undefined;
  readonly pii?: PiiPolicy | undefined;
  /** Salt for `pii: 'hash'`. A per-app value makes the pseudonym useless elsewhere. */
  readonly piiSalt?: string | undefined;
  /** Depth at which an object is summarised as `"[depth]"`. Default 6. */
  readonly maxDepth?: number | undefined;
  /** Entries kept per object/array before `"… n more"`. Default 50. */
  readonly maxEntries?: number | undefined;
  /** Strings longer than this are truncated with a marker. Default 2 048. */
  readonly maxStringLength?: number | undefined;
}

export interface Redactor {
  readonly pii: PiiPolicy;
  /** Redact one value, at one path. Never throws: a failure is `"[redaction-error]"`. */
  value(value: unknown, path?: string): unknown;
  /** Redact a whole record's fields, preserving the top-level shape. */
  fields(fields: Readonly<Record<string, unknown>>): Record<string, unknown>;
  /** True when this path is configured as sensitive (exposed for tests and for a `--dry-run`). */
  isSensitivePath(path: string): boolean;
}

const DEFAULTS = { maxDepth: 6, maxEntries: 50, maxStringLength: 2_048 } as const;

export function createRedactor(options: RedactionOptions = {}): Redactor {
  const pii = options.pii ?? 'omit';
  if (pii !== 'omit' && pii !== 'hash' && pii !== 'allow') {
    throw redactionFailed('pii', `unknown policy "${String(pii)}"`);
  }
  const maxDepth = options.maxDepth ?? DEFAULTS.maxDepth;
  const maxEntries = options.maxEntries ?? DEFAULTS.maxEntries;
  const maxStringLength = options.maxStringLength ?? DEFAULTS.maxStringLength;
  const patterns = [SECRET_KEY, ...(options.keys ?? [])];
  const paths = (options.paths ?? []).map((path) => expandPattern(path));

  const isSensitivePath = (path: string): boolean => {
    if (paths.length === 0) return false;
    const segments = path.split('.');
    for (const pattern of paths) {
      if (matchesGlob(pattern, segments)) return true;
    }
    return false;
  };

  const piiFor = (value: unknown): unknown => {
    if (pii === 'allow') return value;
    if (pii === 'omit') return OMITTED;
    const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
    // 16 hex characters of a salted digest: enough to correlate two records, useless as a lookup
    // table for a list of emails, and stable across processes because the salt is configured.
    return `h:${sha256Text(`${options.piiSalt ?? ''}\u0000${text}`).slice(0, 16)}`;
  };

  const visit = (value: unknown, path: string, depth: number, seen: WeakSet<object>): unknown => {
    try {
      if (value === null || value === undefined) return value;
      if (isRedacted(value)) return REDACTED;
      if (isSensitivePath(path)) return REDACTED;

      if (typeof value === 'string') {
        if (value.length === 0) return value;
        for (const rule of SECRET_VALUE) {
          if (rule.matches(value)) return REDACTED;
        }
        return value.length > maxStringLength
          ? `${value.slice(0, maxStringLength)}…[${String(value.length - maxStringLength)} chars]`
          : value;
      }
      if (typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'function')
        return `[function ${value.name === '' ? 'anonymous' : value.name}]`;
      if (typeof value === 'symbol') return value.toString();

      const object = value;
      if (seen.has(object)) return '[circular]';
      if (depth >= maxDepth) return '[depth]';
      seen.add(object);

      if (value instanceof Date)
        return Number.isNaN(value.getTime()) ? '[invalid date]' : value.toISOString();
      if (value instanceof Error) {
        return { type: value.name, message: value.message };
      }
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        const bytes = value instanceof ArrayBuffer ? value.byteLength : value.byteLength;
        return { type: 'bytes', bytes };
      }
      if (Array.isArray(value)) {
        const items = value
          .slice(0, maxEntries)
          .map((item, index) => visit(item, join(path, String(index)), depth + 1, seen));
        return items.length < value.length
          ? [...items, `… ${String(value.length - items.length)} more`]
          : items;
      }
      if (value instanceof Map) {
        return visit(Object.fromEntries(value), path, depth, seen);
      }
      if (value instanceof Set) {
        return visit([...value], path, depth + 1, seen);
      }

      const source = value as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      let kept = 0;
      for (const [key, entry] of Object.entries(source)) {
        if (kept >= maxEntries) {
          output['…'] = `${String(Object.keys(source).length - kept)} more`;
          break;
        }
        kept += 1;
        output[key] = field(key, entry, join(path, key), depth + 1, seen);
      }
      return output;
    } catch (error: unknown) {
      // A redaction bug must not become a leak: the field is replaced, not written.
      void redactionFailed(
        path === '' ? '(root)' : path,
        error instanceof Error ? error.message : String(error),
      );
      return REDACTION_ERROR;
    }
  };

  const field = (
    key: string,
    value: unknown,
    path: string,
    depth: number,
    seen: WeakSet<object>,
  ): unknown => {
    // Typed first: it cannot be inspected at all, so nothing below may see the value.
    if (isRedacted(value)) return REDACTED;
    if (isSensitivePath(path)) return REDACTED;
    if (patterns.some((pattern) => pattern.test(key))) return REDACTED;
    if (PII_KEY.test(key)) {
      const pseudonym = piiFor(value);
      return pseudonym;
    }
    return visit(value, path, depth, seen);
  };

  return {
    pii,
    isSensitivePath,
    value: (value, path = '') => visit(value, path, 0, new WeakSet<object>()),
    fields: (fields) => {
      const seen = new WeakSet<object>();
      const output: Record<string, unknown> = {};
      const entries = Object.entries(fields);
      for (const [index, [key, value]] of entries.entries()) {
        if (index >= maxEntries) {
          output['…'] = `${String(entries.length - index)} more`;
          break;
        }
        output[key] = field(key, value, key, 0, seen);
      }
      return output;
    },
  };
}

/**
 * `items[*].card` means two segments — `items`, then any index — because an array element is one
 * segment of the path a record is walked along.
 */
function expandPattern(path: string): string[] {
  const segments: string[] = [];
  for (const segment of path.split('.')) {
    const indexed = /^([^[\]]+)\[(\*|\d+)\]$/u.exec(segment);
    if (indexed === null) {
      segments.push(segment);
      continue;
    }
    segments.push(indexed[1] ?? '', indexed[2] ?? '*');
  }
  return segments;
}

/** `parent.child`, and `child` at the root — the empty string is not a path segment. */
function join(parent: string, child: string): string {
  return parent === '' ? child : `${parent}.${child}`;
}

/**
 * `*` matches exactly one path segment, `**` matches one or more.
 *
 * Enough for `items[*].card` and `secrets.**`, and deliberately not a regex engine: a redaction path
 * that is a program is a redaction path nobody can review.
 */
function matchesGlob(pattern: readonly string[], segments: readonly string[]): boolean {
  const walk = (patternIndex: number, segmentIndex: number): boolean => {
    if (patternIndex === pattern.length) return segmentIndex === segments.length;
    const part = pattern[patternIndex];

    if (part === '**') {
      // One segment or more: `secrets.**` covers `secrets.a` and `secrets.a.b`, not `secrets` itself,
      // because "redact the whole subtree" is written `secrets` and reads better that way.
      for (let skip = segmentIndex + 1; skip <= segments.length; skip += 1) {
        if (walk(patternIndex + 1, skip)) return true;
      }
      return false;
    }
    if (segmentIndex >= segments.length) return false;
    if (part !== '*' && part !== segments[segmentIndex]) return false;
    return walk(patternIndex + 1, segmentIndex + 1);
  };
  return walk(0, 0);
}
