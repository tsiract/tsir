/**
 * The artifact secret scanner (`DPL-012`, `DPL-020`).
 *
 * A bundler is an opinion-free copier: whatever was in the module is in the artifact, and
 * whatever is in the artifact is in the upload, in the Worker, and in every log line that
 * ever prints the bundle's source. Secrets are therefore not "handled" by a policy — they
 * are either absent or they leaked, and only a scan can tell the difference.
 *
 * Three rules keep this honest:
 *
 *   · **It never prints a secret.** Findings carry the file, the line, the pattern's *name*
 *     and a redacted excerpt. A scanner that echoes what it found is a second leak.
 *   · **Names need an assignment.** `wrangler secret put APP_KEY` in a generated config is
 *     the *correct* shape and must not be flagged; `APP_KEY = "…"` is the leak. So a named
 *     pattern matches `NAME = <value>`, and a value that is itself a reference
 *     (`process.env.APP_KEY`) is a use, not a leak.
 *   · **It is pure.** Text in, findings out, no filesystem: the CLI decides which files are
 *     artifacts, and this module can be tested — and run — anywhere.
 */

/** One thing worth finding in an artifact. */
export interface SecretPattern {
  /** Stable identifier used in findings and in `--json`. Never the value. */
  readonly name: string;
  readonly pattern: RegExp;
}

export interface SecretFinding {
  /** Path as the caller named it — relative to the build directory in practice. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** The pattern's name (`aws-access-key-id`, `APP_KEY`, …), never what it matched. */
  readonly pattern: string;
  /** The offending line with the match replaced by `[redacted]`, trimmed to 160 chars. */
  readonly excerpt: string;
}

export interface SourceFile {
  readonly file: string;
  readonly contents: string;
}

/**
 * Shapes that are a secret wherever they appear.
 *
 * Deliberately a list of *formats*, not of words: an entropy heuristic would flag minified
 * bundles constantly, and a scanner people learn to ignore is worse than none. Every entry
 * here is something a real credential looks like on the wire.
 */
export const SECRET_SHAPES: readonly SecretPattern[] = [
  { name: 'private-key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b/ },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}/ },
  { name: 'stripe-live-key', pattern: /\bsk_live_[A-Za-z0-9]{16,}/ },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    // The user *and* a password in a URL: a connection string with neither is fine.
    name: 'url-with-password',
    pattern:
      /\b(?:postgres|postgresql|mysql|redis|rediss|mongodb(?:\+srv)?):\/\/[^\s:/'"@]+:[^\s/'"@]+@/,
  },
];

/** `NAME = value`, with the value required to be at least eight characters of substance. */
function namedShape(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`\\b${escaped}\\b\\s*[=:]\\s*["']?([^\\s"',;]{8,})`, 'u');
}

/**
 * A value that is a *reference* is the correct way to use a secret, not a leak.
 *
 * `process.env.APP_KEY`, `${APP_KEY}`, `env.APP_KEY` and friends read the value at runtime;
 * what a bundler ships is the name of the variable, which is exactly the design.
 */
const REFERENCE = /^(?:process\.env|import\.meta|globalThis|env\.|\$|\{|<)/u;

function isReference(value: string): boolean {
  return REFERENCE.test(value);
}

/** Patterns for the secret *names* a project declares, plus every shape. */
export function secretPatterns(names: readonly string[] = []): readonly SecretPattern[] {
  const named = [...new Set(names)]
    .sort()
    .map((name) => ({ name: `${name} (value assigned)`, pattern: namedShape(name) }));
  return [...named, ...SECRET_SHAPES];
}

function withGlobal(pattern: RegExp): RegExp {
  return pattern.flags.includes('g')
    ? new RegExp(pattern.source, pattern.flags)
    : new RegExp(pattern.source, `${pattern.flags}g`);
}

const EXCERPT = 160;

/**
 * The line with the secret removed — and the *name* kept.
 *
 * For a named pattern the match is `APP_KEY = "…"`, and masking all of it would throw away
 * the one part that tells the reader what to move into `wrangler secret put`. So when the
 * pattern captured a value, only the value is masked.
 *
 * A long line (minified bundles are one line) is windowed around the redaction rather than
 * truncated from the left: an excerpt that cuts the evidence off is a bug report that says
 * "somewhere in this file".
 */
function redact(line: string, match: RegExpExecArray): string {
  const value = match[1];
  const index = value === undefined ? match.index : match.index + match[0].lastIndexOf(value);
  const length = value === undefined ? match[0].length : value.length;
  const masked = `${line.slice(0, index)}[redacted]${line.slice(index + length)}`;

  if (masked.length <= EXCERPT) return masked.trim();
  // The two ellipses are part of the 160-character budget.
  const width = EXCERPT - 2;
  const start = Math.max(0, Math.min(index - 60, masked.length - width));
  return `…${masked.slice(start, start + width).trim()}…`;
}

/**
 * Scan one source for secrets.
 *
 * Line-oriented on purpose: a finding a developer cannot jump to is a finding they will
 * not fix, and bundles are the one place where "which line" is still answerable.
 */
export function scanText(
  contents: string,
  file: string,
  patterns: readonly SecretPattern[] = secretPatterns(),
): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  for (const { name, pattern } of patterns) {
    const global = withGlobal(pattern);
    // `String.prototype.matchAll` gives every line's every match without a stateful `lastIndex`.
    for (const [index, line] of contents.split('\n').entries()) {
      global.lastIndex = 0;
      for (const match of line.matchAll(global)) {
        const value = match[1];
        // A named pattern matched only because the assigned value is a reference: skip it,
        // and skip the whole shape family — `APP_KEY = process.env.APP_KEY` is not a leak.
        if (value !== undefined && isReference(value)) continue;

        const lineNumber = index + 1;
        const key = `${file}:${String(lineNumber)}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          file,
          line: lineNumber,
          pattern: name,
          excerpt: redact(line, match),
        });
      }
    }
  }

  return sorted(findings);
}

/** One ordering for every entry point: file, then line, then pattern. */
function sorted(findings: readonly SecretFinding[]): readonly SecretFinding[] {
  return [...findings].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.pattern.localeCompare(b.pattern),
  );
}

/** Scan a set of in-memory files — what the CLI hands over after reading the build directory. */
export function scanSources(
  sources: readonly SourceFile[],
  names: readonly string[] = [],
): readonly SecretFinding[] {
  const patterns = secretPatterns(names);
  return sorted(sources.flatMap((source) => scanText(source.contents, source.file, patterns)));
}

/** True when anything was found. Exists so callers do not re-implement `length > 0`. */
export function hasLeak(findings: readonly SecretFinding[]): boolean {
  return findings.length > 0;
}

/** The human report. Every line is safe to paste into an issue. */
export function describeFindings(findings: readonly SecretFinding[]): string {
  if (findings.length === 0) return '  no secret values in the artifacts\n';
  return `${findings
    .map(
      (finding) =>
        `  ✗ ${finding.file}:${String(finding.line)} matches ${finding.pattern}\n` +
        `    ${finding.excerpt}`,
    )
    .join('\n')}\n`;
}

/** The `DPL_SECRET_LEAK` context for one finding, for the error and `--json` paths. */
export function findingContext(finding: SecretFinding): {
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
} {
  return { file: finding.file, line: finding.line, pattern: finding.pattern };
}
