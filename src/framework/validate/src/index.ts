/**
 * @tsir/validate — Standard Schema interop and issue normalization.
 *
 * Public surface:
 *   validate, validateSync, parse, isStandardSchema, expectStandardSchema,
 *   normalizeIssues, formatIssues, ValidationError,
 *   objectOf, withUnknownKeys, unknownKeysPolicy
 */

export {
  parse,
  validate,
  validateSync,
  isStandardSchema,
  expectStandardSchema,
  ValidationError,
} from './validate.ts';
export type { InferOutput, ValidationResult } from './validate.ts';

export { objectOf, unknownKeysPolicy, withUnknownKeys } from './objects.ts';
export type { ObjectOptions, UnknownKeysPolicy } from './objects.ts';

export { normalizeIssues, formatIssues } from './issues.ts';
export type { IssueCode, ValidationIssue } from './issues.ts';

export type { AnyStandardSchema, StandardSchemaV1 } from './standard.ts';

/**
 * `@tsir/validate` is built **on top of Zod 4** (ADR-0003, ADR-0011) and is the
 * only package in the workspace that names it as a dependency. Everything else
 * imports `z` from here — one zod instance, one version, one upgrade.
 *
 * Tsir's own code only ever uses the Standard Schema interface, so a Valibot or
 * ArkType schema passed by an application is equally supported; Zod is the
 * default, not a lock-in.
 */
export { z } from 'zod';
export type { ZodType, ZodError, ZodIssue } from 'zod';
