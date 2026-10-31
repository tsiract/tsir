/**
 * Object schemas and the unknown-key policy (VLD-005).
 *
 * Three policies, and they are not interchangeable:
 *
 * | policy        | unknown key in the payload | correct when                                  |
 * | ------------- | -------------------------- | --------------------------------------------- |
 * | `strip`       | dropped, request succeeds  | default: clients legitimately send extra data |
 * | `strict`      | 422, request fails         | the payload is a closed contract              |
 * | `passthrough` | kept                       | the schema is a prefix of a larger document   |
 *
 * The default is `strip` because the alternative pessimises every caller: a
 * client that adds a field for its own purposes must not break a deployed
 * service. `strict` is per schema, never global, and is what makes a typo
 * (`"emial"`) a 422 instead of a silently missing value.
 *
 * The policy is *readable* — `unknownKeysPolicy()` — because OpenAPI has to
 * report it. A schema that silently drops fields while its published contract
 * says `additionalProperties: false` is worse than no contract at all.
 */

import { z } from 'zod';

export type UnknownKeysPolicy = 'strip' | 'strict' | 'passthrough';

export interface ObjectOptions {
  readonly unknownKeys?: UnknownKeysPolicy;
}

/** Zod's internals, narrowed to the one field this module reads. */
interface ZodInternals {
  readonly _zod?: { readonly def?: { readonly catchall?: unknown } };
}

function catchallOf(schema: unknown): unknown {
  return (schema as ZodInternals)._zod?.def?.catchall;
}

/**
 * Applies a policy to an existing Zod object, returning a new schema.
 *
 * Non-object schemas are returned unchanged: the policy is a property of an
 * object's shape, and asking for one on a string is a no-op rather than an
 * error, so a helper can be applied blindly to a mixed schema map.
 */
export function withUnknownKeys<T extends z.ZodType>(schema: T, policy: UnknownKeysPolicy): T {
  // Zod v4 only materialises `catchall` once a policy is set, so the *type* is
  // the reliable signal that this is an object schema at all.
  const def = (schema as ZodInternals)._zod?.def;
  if (def === undefined || (def as { type?: unknown }).type !== 'object') return schema;
  switch (policy) {
    case 'strict':
      return (schema as unknown as z.ZodObject).strict() as unknown as T;
    case 'passthrough':
      return (schema as unknown as z.ZodObject).loose() as unknown as T;
    case 'strip':
    default:
      return (schema as unknown as z.ZodObject).strip() as unknown as T;
  }
}

/**
 * `objectOf({...}, { unknownKeys: 'strict' })` — a named object schema whose
 * policy is explicit at the declaration site instead of implied by which Zod
 * method happened to be used.
 */
export function objectOf<Shape extends z.ZodRawShape>(
  shape: Shape,
  options: ObjectOptions = {},
): z.ZodObject<Shape> {
  const base = z.object(shape);
  switch (options.unknownKeys ?? 'strip') {
    case 'strict':
      return base.strict();
    case 'passthrough':
      return base.loose();
    case 'strip':
      return base;
  }
  // `options.unknownKeys ?? 'strip'` is total over the union; the fallthrough is
  // unreachable but keeps the return type honest without an assertion.
}

/**
 * The policy a schema actually enforces, or `undefined` when the schema is not
 * an object at all.
 *
 * Read from Zod's own definitions rather than a side table: a schema can be
 * built by any Zod API, and a marker we maintained ourselves would be missing
 * on every schema we did not construct.
 */
export function unknownKeysPolicy(schema: unknown): UnknownKeysPolicy | undefined {
  const catchall = catchallOf(schema);
  if (catchall === undefined) {
    const def = (schema as ZodInternals)._zod?.def;
    // An object without a catchall is Zod's `strip`; anything else has no policy.
    const isObject = def !== undefined && (def as { type?: unknown }).type === 'object';
    return isObject ? 'strip' : undefined;
  }
  if (catchall instanceof z.ZodNever) return 'strict';
  if (catchall instanceof z.ZodUnknown || catchall instanceof z.ZodAny) return 'passthrough';
  return 'strip';
}
