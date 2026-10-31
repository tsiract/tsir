/**
 * The validation entry points.
 *
 * Two shapes, deliberately:
 *
 * - `validate()` — async-safe, for request bodies and anything bound at a
 *   network boundary, where an async refinement is legitimate.
 * - `validateSync()` — refuses async validators with `VLD_ASYNC_SCHEMA`
 *   instead of returning a promise nobody awaited. Startup code and CLI
 *   commands use this so a boot can never silently continue on unvalidated
 *   input.
 *
 * Neither coerces. A schema that wants `"3"` → `3` must say so explicitly in
 * its own definition; Tsir never guesses (principle 6).
 */

import { TsirError } from '@tsir/container';

import { normalizeIssues, type ValidationIssue } from './issues.ts';

/**
 * A failed parse.
 *
 * `issues` is a first-class property rather than part of `context`, because
 * `context` is scalar-only by design — it is serialized to logs. Boundary
 * mappers (HTTP 422, gRPC INVALID_ARGUMENT, CLI exit 2) read `error.issues`.
 */
export class ValidationError extends TsirError {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[], label = 'input') {
    super('VLD_INVALID', `Invalid ${label}`, {
      kind: 'validation',
      hint: 'see `issues` for every rejected field; none of the input was accepted',
      context: { label, issues: issues.length },
    });
    this.name = 'ValidationError';
    this.issues = issues;
  }
}
import type { AnyStandardSchema, StandardSchemaV1 } from './standard.ts';

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/** Structural check — no dependency on, or import of, any validator package. */
export function isStandardSchema(value: unknown): value is AnyStandardSchema {
  if (typeof value !== 'object' || value === null || !('~standard' in value)) return false;
  const props: unknown = value['~standard'];
  return (
    typeof props === 'object' &&
    props !== null &&
    'version' in props &&
    props.version === 1 &&
    'validate' in props &&
    typeof props.validate === 'function'
  );
}

export function expectStandardSchema(value: unknown, label = 'schema'): AnyStandardSchema {
  if (!isStandardSchema(value)) {
    throw new TsirError(
      'VLD_NOT_STANDARD_SCHEMA',
      `${label} does not implement Standard Schema v1`,
      {
        kind: 'validation',
        hint: 'use Zod 4+, Valibot 1+, ArkType 2+, or wrap your validator with a `~standard` adapter',
      },
    );
  }
  return value;
}

export type InferOutput<S> = S extends StandardSchemaV1<unknown, infer Output> ? Output : never;

/**
 * Validates untrusted input. Never throws on invalid *input* — that decision
 * belongs to the caller — but throws `VLD_NOT_STANDARD_SCHEMA` on a programming
 * error.
 */
/**
 * Runs a Standard Schema validator and normalizes the outcome.
 *
 * A validator that *throws* is not caught here. That is deliberate: a throwing
 * validator is a bug in server code (ours or a third-party schema's), and
 * converting it into `{ ok: false }` would present it to the client as a 422
 * they cannot do anything about. The HTTP pipeline's error boundary answers 500
 * and logs it, which is where a server bug belongs.
 */
export async function validate<S extends AnyStandardSchema>(
  schema: S,
  input: unknown,
): Promise<ValidationResult<InferOutput<S>>> {
  const props = schema['~standard'];
  const result = props.validate(input);
  const settled = isPromiseLike(result) ? await result : result;

  if (succeeds(settled)) {
    return { ok: true, value: settled.value as InferOutput<S> };
  }
  return { ok: false, issues: normalizeIssues(settled.issues) };
}

function succeeds(
  result: StandardSchemaV1.Result<unknown>,
): result is StandardSchemaV1.SuccessResult<unknown> {
  return result.issues === undefined;
}

/**
 * Synchronous validation for code paths that must not await.
 *
 * Throws `VLD_ASYNC_SCHEMA` when the validator returns a promise, because the
 * alternative — returning a half-validated value — is exactly the class of bug
 * this package exists to prevent.
 */
export function validateSync<S extends AnyStandardSchema>(
  schema: S,
  input: unknown,
): ValidationResult<InferOutput<S>> {
  const props = schema['~standard'];
  const result: unknown = props.validate(input);

  if (isPromiseLike(result)) {
    throw new TsirError('VLD_ASYNC_SCHEMA', 'Schema validated asynchronously', {
      kind: 'validation',
      hint: 'use `validate()` (async) for schemas with async refinements',
    });
  }

  const settled = result as StandardSchemaV1.Result<unknown>;
  if (settled.issues === undefined) {
    return { ok: true, value: settled.value as InferOutput<S> };
  }
  return { ok: false, issues: normalizeIssues(settled.issues) };
}

/**
 * Validation that must succeed.
 *
 * The thrown error carries normalized issues as `context.issues`, so a boundary
 * mapper (HTTP, SOAP, gRPC, CLI) can render them without re-parsing a message.
 */
export async function parse<S extends AnyStandardSchema>(
  schema: S,
  input: unknown,
  label = 'input',
): Promise<InferOutput<S>> {
  const result = await validate(schema, input);
  if (result.ok) return result.value;
  throw new ValidationError(result.issues, label);
}
