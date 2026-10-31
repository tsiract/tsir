/**
 * The Standard Schema v1 interface, vendored as types only.
 *
 * Tsir does not depend on Zod, Valibot, ArkType, or any other validator to
 * *use* one: the shape below is the published Standard Schema contract
 * (https://standardschema.dev), which those libraries implement natively. Vendoring
 * twelve lines of interface is cheaper than choosing a validator for the user,
 * and it keeps `@tsir/validate` free of runtime dependencies.
 */

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

// The vendored contract uses a namespace because that is exactly how the
// published Standard Schema types are shaped (`StandardSchemaV1.Issue`,
// `StandardSchemaV1.Result`). Diverging would break structural compatibility.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  /** Extracts the output type of a schema, so binders can type their handlers. */
  export type InferOutput<S> = S extends StandardSchemaV1<unknown, infer Output> ? Output : never;

  /** Extracts the input type of a schema. */
  export type InferInput<S> = S extends StandardSchemaV1<infer Input, unknown> ? Input : never;
}

export type AnyStandardSchema = StandardSchemaV1<unknown, unknown>;
