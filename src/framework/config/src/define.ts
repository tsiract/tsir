/**
 * Configuration schema declaration.
 *
 * A config spec maps *environment variable names* to field descriptors. Nothing
 * is inferred from the environment's shape, nothing is coerced implicitly, and
 * secrets are declared as secrets — so redaction is a property of the schema,
 * not something a call site has to remember.
 *
 *   export const spec = defineConfig({
 *     APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
 *     DATABASE_URL: env.secret(),                       // → Redacted<string>
 *     DATABASE_POOL_MAX: env.int({ min: 1, max: 50, default: 10 }),
 *   });
 *
 * ### Why this builds on Zod *mini* (ADR-0013)
 *
 * Environment parsing is a few dozen small schemas, and it runs on every cold
 * start — Workers and Lambda included. Building them with the full Zod API cost
 * ~75 KiB in every application that used typed config; the mini build costs a
 * fraction of that for the same guarantees. `env.custom()` still accepts any
 * Standard Schema validator (full Zod, Valibot, ArkType), so the smaller
 * internal validator is not a constraint on applications.
 *
 * ### Defaults are data, not closures
 *
 * A declared default is validated **once, at declaration time**, and stored on
 * the field. Zod's `.default()` does not validate the value it returns, which
 * would let `env.string({ minLength: 3, default: 'ab' })` boot silently; a schema
 * that cannot satisfy itself now fails the moment it is written.
 */

import * as m from '@tsir/validate/mini';
import { validateSync, type AnyStandardSchema } from '@tsir/validate';

import { configError } from './errors.ts';
import type { Redacted } from './redacted.ts';

export interface FieldOptions {
  /** Human description surfaced in boot reports and `tsir config:dump`. */
  readonly description?: string;
}

export interface FieldSpec<T, Secret extends boolean = false> {
  /**
   * The validator, as a Standard Schema. Typed structurally — not as
   * `z.ZodType` — so a field can be built from Zod, Zod mini, Valibot or
   * ArkType without Tsir importing any of them.
   */
  readonly schema: AnyStandardSchema;
  readonly secret: Secret;
  readonly hasDefault: boolean;
  /**
   * The declared default **in the schema's input form** (a string for env fields),
   * already validated against `schema` at declaration time. Storing the input form
   * rather than the parsed value means the value that boots is produced by exactly
   * the same code path as one that came from the environment.
   */
  readonly defaultInput: unknown;
  readonly description: string | undefined;
  readonly overridable: boolean;
  /** Phantom: keeps `T` (and therefore inference) attached without using `any`. */
  readonly _value?: T;
}

export type ConfigSpec = Readonly<Record<string, FieldSpec<unknown, boolean>>>;

export type InferField<F> =
  F extends FieldSpec<infer T, infer Secret> ? (Secret extends true ? Redacted<T> : T) : never;

export type InferConfig<S extends ConfigSpec> = {
  readonly [K in keyof S]: InferField<S[K]>;
};

/**
 * Validates a declared default through the field's own schema.
 *
 * A default is a value the environment could have produced, so it is parsed
 * exactly like one — at declaration time, not at the first production boot.
 */
function checkedDefault(schema: AnyStandardSchema, raw: string): unknown {
  const parsed = validateSync(schema, raw);
  if (!parsed.ok) {
    throw configError(
      'CFG_INVALID_DEFAULT',
      `A configuration default does not satisfy its own schema: ${parsed.issues[0]?.message ?? 'invalid'}`,
      'fix the schema declaration; defaults are validated exactly like environment values',
    );
  }
  return parsed.value;
}

function field<T, Secret extends boolean = false>(
  schema: AnyStandardSchema,
  secret: Secret,
  options: { readonly description?: string; readonly overridable?: boolean } = {},
  defaultInput?: unknown,
): FieldSpec<T, Secret> {
  return Object.freeze({
    schema,
    secret,
    // A field has a default when one was declared (already validated), or when
    // the schema itself accepts `undefined` (e.g. a custom `z.string().default()`).
    hasDefault: defaultInput !== undefined || validateSync(schema, undefined).ok,
    defaultInput,
    description: options.description,
    overridable: options.overridable ?? true,
  });
}

export interface IntOptions extends FieldOptions {
  readonly default?: number;
  readonly min?: number;
  readonly max?: number;
  readonly overridable?: boolean;
}

export interface StringOptions extends FieldOptions {
  readonly default?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly overridable?: boolean;
}

export interface BoolOptions extends FieldOptions {
  readonly default?: boolean;
  readonly overridable?: boolean;
}

export interface EnumOptions<T extends string> extends FieldOptions {
  readonly default?: T;
  readonly overridable?: boolean;
}

/**
 * Field builders.
 *
 * Conversion rules are explicit and narrow on purpose: `"1e3"`, `" 3"`, `"3 "`,
 * `"0x10"`, `"1,000"`, and `""` are not integers; `"1"` is not a boolean. Every
 * rejection carries a message a human can act on, which is why the mini checks
 * are given explicit text instead of relying on defaults.
 */
export const env = {
  string(options: StringOptions = {}): FieldSpec<string> {
    let schema = m.string();
    if (options.minLength !== undefined) {
      schema = schema.check(
        m.minLength(options.minLength, `must be at least ${String(options.minLength)} characters`),
      );
    }
    if (options.maxLength !== undefined) {
      schema = schema.check(
        m.maxLength(options.maxLength, `must be at most ${String(options.maxLength)} characters`),
      );
    }
    if (options.pattern !== undefined) {
      schema = schema.check(m.regex(options.pattern, 'must match the required pattern'));
    }

    if (options.default !== undefined) checkedDefault(schema, options.default);
    return field<string>(schema, false, options, options.default);
  },

  /** A required non-empty string with no default. */
  required(options: FieldOptions & { readonly overridable?: boolean } = {}): FieldSpec<string> {
    const schema = m.string().check(m.minLength(1, 'must not be empty'));
    return field<string>(schema, false, options);
  },

  /** A required secret. Loads as `Redacted<string>`. */
  secret(
    options: FieldOptions & { readonly overridable?: boolean; readonly minLength?: number } = {},
  ): FieldSpec<string, true> {
    const min = options.minLength ?? 1;
    const schema = m.string().check(m.minLength(min, `must be at least ${String(min)} characters`));
    return field<string, true>(schema, true, options);
  },

  int(options: IntOptions = {}): FieldSpec<number> {
    const { min, max } = options;

    const integer = m.pipe(
      m.string().check(m.regex(/^-?\d+$/, 'must be a base-10 integer')),
      m.transform((raw: string) => Number.parseInt(raw, 10)), // coercion-ok: regex-guarded above
    );

    let numeric = m.number();
    if (min !== undefined) numeric = numeric.check(m.gte(min, `must be >= ${String(min)}`));
    if (max !== undefined) numeric = numeric.check(m.lte(max, `must be <= ${String(max)}`));

    const schema = m.pipe(integer, numeric);
    if (options.default === undefined) return field<number>(schema, false, options);
    const input = String(options.default);
    checkedDefault(schema, input);
    return field<number>(schema, false, options, input);
  },

  bool(options: BoolOptions = {}): FieldSpec<boolean> {
    const schema = m.pipe(
      m
        .string()
        .check(
          m.refine((raw: string) => raw === 'true' || raw === 'false', 'must be "true" or "false"'),
        ),
      m.transform((raw: string) => raw === 'true'),
    );

    if (options.default === undefined) return field<boolean>(schema, false, options);
    const input = String(options.default);
    checkedDefault(schema, input);
    return field<boolean>(schema, false, options, input);
  },

  /**
   * A `const` type parameter keeps the literal union instead of widening it to
   * `string` — otherwise `env.enum(['a', 'b'])` would infer `string`, and the
   * whole point of a typed config is lost.
   */
  enum<const T extends readonly [string, ...string[]]>(
    values: T,
    options: EnumOptions<T[number]> = {},
  ): FieldSpec<T[number]> {
    const schema = m.enum(values);
    if (options.default !== undefined) checkedDefault(schema, options.default);
    return field<T[number]>(schema, false, options, options.default);
  },

  /**
   * Escape hatch for a schema this module does not model. Still runtime-validated,
   * and validator-agnostic: anything implementing Standard Schema v1 works —
   * full Zod, Zod mini, Valibot, ArkType.
   */
  custom<T>(
    schema: AnyStandardSchema,
    options: FieldOptions & { readonly secret?: boolean; readonly overridable?: boolean } = {},
  ): FieldSpec<T, boolean> {
    return field<T, boolean>(schema, options.secret === true, options);
  },
} as const;

export function defineConfig<S extends ConfigSpec>(spec: S): S {
  return Object.freeze(spec);
}

export function isFieldSpec(value: unknown): value is FieldSpec<unknown, boolean> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schema' in value &&
    'secret' in value &&
    'hasDefault' in value
  );
}
