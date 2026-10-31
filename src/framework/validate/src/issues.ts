/**
 * Issue normalization.
 *
 * Every validator reports issues differently; every Tsir boundary reports them
 * one way. This is the single translation point, so an HTTP 422, a SOAP fault,
 * a gRPC `INVALID_ARGUMENT`, and a CLI usage error all describe the same
 * failure with the same field names.
 */

import type { StandardSchemaV1 } from './standard.ts';

export type IssueCode =
  | 'invalid_type'
  | 'invalid_format'
  | 'too_small'
  | 'too_big'
  | 'invalid_value'
  | 'missing'
  | 'custom';

/** A validator-agnostic issue. Paths are string arrays — never symbols. */
export interface ValidationIssue {
  /** Dotted path from the root of the validated value, e.g. `['items', '0', 'sku']`. */
  readonly path: readonly string[];
  readonly message: string;
  /**
   * Coarse classification, inferred from the message when the validator does
   * not expose one. Used for status mapping and for i18n keys, never for
   * control flow that depends on exact wording.
   */
  readonly code: IssueCode;
}

const CODE_PATTERNS: readonly (readonly [RegExp, IssueCode])[] = [
  [/too small|at least|must be >=? ?\d/i, 'too_small'],
  [/too big|at most|must be <=? ?\d/i, 'too_big'],
  [/invalid (?:type|input)|expected (?:object|string|number|boolean|array)/i, 'invalid_type'],
  [/invalid (?:format|email|url|uuid|regex|date)/i, 'invalid_format'],
  [/invalid (?:value|option|enum)|\bexpected one of\b/i, 'invalid_value'],
  [/required|missing/i, 'missing'],
];

const MAX_MESSAGE = 500;

function classify(message: string): IssueCode {
  for (const [pattern, code] of CODE_PATTERNS) {
    if (pattern.test(message)) return code;
  }
  return 'custom';
}

/** Converts one Standard Schema path segment into a plain string. */
function segmentKey(segment: PropertyKey | StandardSchemaV1.PathSegment): string {
  if (typeof segment === 'object' && segment !== null && 'key' in segment) {
    const key = segment.key;
    return typeof key === 'symbol' ? (key.description ?? key.toString()) : String(key);
  }
  return typeof segment === 'symbol'
    ? (segment.description ?? segment.toString())
    : String(segment);
}

/**
 * Normalizes any Standard Schema failure into `ValidationIssue[]`.
 *
 * Messages are truncated, not dropped: a validator that embeds the offending
 * value in its message must not be able to grow a response body without bound.
 */
export function normalizeIssues(
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): readonly ValidationIssue[] {
  return issues.map((issue) => {
    const message =
      issue.message.length > MAX_MESSAGE
        ? `${issue.message.slice(0, MAX_MESSAGE)}…`
        : issue.message;
    return {
      path: (issue.path ?? []).map(segmentKey),
      message,
      code: classify(message),
    };
  });
}

/** Renders issues as `field: message` lines, for CLIs and logs. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  if (issues.length === 0) return 'no issues';
  return issues
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
    )
    .join('\n');
}
