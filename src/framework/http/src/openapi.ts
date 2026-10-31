/**
 * OpenAPI 3.1 generation (HTP-020).
 *
 * A route table is already a description of the HTTP surface: methods, paths,
 * parameter names, validators, content types, statuses, guards. This turns that
 * description into an OpenAPI document rather than asking applications to hand
 * write one that will drift.
 *
 * Three rules kept this honest:
 *
 * 1. **A separate entry point.** `@tsir/http` bundles without Zod (proven by the
 *    `http-app` budget). Schema conversion needs Zod, so it lives behind
 *    `@tsir/http/openapi`: apps that never emit a document never pay for it.
 * 2. **Input-side schemas.** Parameters and bodies are described with `io:
 *    'input'`, i.e. what a client must send — `?page=2` is a string, not the
 *    integer the binder produces.
 * 3. **Never invent.** Response schemas are not declared by handlers yet, so the
 *    document says so in the response description instead of emitting a
 *    plausible-looking empty schema.
 */

import type { RouteEntry, RouteTable } from '@tsir/router';
import { type AnyStandardSchema, unknownKeysPolicy, z } from '@tsir/validate';

/** A JSON Schema value. Loose on purpose: Zod's output is passed through as-is. */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface OpenApiServer {
  readonly url: string;
  readonly description?: string;
}

export interface OpenApiOptions {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly servers?: readonly OpenApiServer[];
  /**
   * Converts a validator to JSON Schema. Defaults to Zod. Return `undefined` to
   * leave a schema out; anything else is a hard error, because a silently empty
   * schema in a published document is worse than a failed build.
   */
  readonly convertSchema?: (schema: AnyStandardSchema) => JsonSchema | undefined;
  /** Adds `4XX`/`5XX` problem+json responses to every operation. Defaults to true. */
  readonly problemResponses?: boolean;
}

export interface OpenApiParameter {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly description?: string;
  readonly schema: JsonSchema;
}

export interface OpenApiMediaType {
  readonly schema: JsonSchema;
}

export interface OpenApiRequestBody {
  readonly required: boolean;
  readonly content: Readonly<Record<string, OpenApiMediaType>>;
}

export interface OpenApiResponse {
  readonly description: string;
  readonly content?: Readonly<Record<string, OpenApiMediaType>>;
}

export type OpenApiResponseObject = OpenApiResponse | { readonly $ref: string };

export interface OpenApiOperation {
  readonly operationId: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: OpenApiRequestBody;
  readonly responses: Readonly<Record<string, OpenApiResponseObject>>;
}

export type OpenApiPathItem = Readonly<Record<string, OpenApiOperation>>;

export interface OpenApiDocument {
  readonly openapi: '3.1.0';
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  };
  readonly servers?: readonly OpenApiServer[];
  readonly paths: Readonly<Record<string, OpenApiPathItem>>;
  readonly components: {
    readonly schemas: Readonly<Record<string, JsonSchema>>;
    readonly responses: Readonly<Record<string, OpenApiResponseObject>>;
  };
}

/** The problem+json envelope every non-2xx response uses (§6). */
export const PROBLEM_SCHEMA: JsonSchema = Object.freeze({
  type: 'object',
  required: ['type', 'title', 'status', 'code', 'requestId'],
  properties: {
    type: { type: 'string', format: 'uri-reference' },
    title: { type: 'string' },
    status: { type: 'integer', minimum: 400, maximum: 599 },
    detail: { type: 'string' },
    instance: { type: 'string' },
    code: { type: 'string', description: 'Stable failure code, e.g. HTP_VALIDATION_FAILED.' },
    requestId: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'message'],
        properties: {
          path: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
          code: { type: 'string' },
        },
      },
    },
  },
});

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Zod is the only schema library Tsir can convert without a plugin. Anything
 * else must supply `convertSchema` — the throw happens at generation time, not
 * at request time.
 */
function defaultConvert(schema: AnyStandardSchema): JsonSchema | undefined {
  if (!(schema instanceof z.ZodType)) return undefined;
  // Zod's output is already a structural match for `JsonSchema`; no cast needed.
  const json = z.toJSONSchema(schema, { target: 'openapi-3.1', io: 'input' });

  // Report the unknown-key policy (VLD-005). Zod emits `additionalProperties`
  // for `strict` (`false`) and `passthrough` (`{}`), but emits nothing for the
  // default `strip` — where extras are accepted and silently dropped. Saying
  // `additionalProperties: false` there would be a lie (the request succeeds),
  // and saying nothing leaves the contract ambiguous, so `strip` is published as
  // a vendor extension and `additionalProperties` stays absent.
  const policy = unknownKeysPolicy(schema);
  if (policy === 'strip') return { ...json, 'x-tsir-unknown-keys': 'strip' };
  if (policy === 'passthrough') return { ...json, additionalProperties: true };
  return json;
}

/** `/users/:id` → `/users/{id}`; the `*` catch-all becomes `{wildcard}`. */
export function openApiPath(path: string): {
  readonly template: string;
  readonly params: readonly string[];
  readonly wildcard: boolean;
} {
  if (path === '/') return { template: '/', params: [], wildcard: false };

  const params: string[] = [];
  let wildcard = false;

  const template = path
    .slice(1)
    .split('/')
    .map((segment) => {
      if (segment === '*') {
        wildcard = true;
        return '{wildcard}';
      }
      if (segment.startsWith(':')) {
        const name = segment.slice(1);
        params.push(name);
        return `{${name}}`;
      }
      return segment;
    })
    .join('/');

  return { template: `/${template}`, params, wildcard };
}

function describe(
  schema: AnyStandardSchema,
  convert: (input: AnyStandardSchema) => JsonSchema | undefined,
  where: string,
): JsonSchema {
  const converted = convert(schema);
  if (converted === undefined) {
    throw new TypeError(
      `openapi: ${where} uses a validator that cannot be converted to JSON Schema; ` +
        'pass `convertSchema` or emit the document from Zod schemas',
    );
  }
  return converted;
}

/** Flattens an object schema into OpenAPI parameters for one location. */
function objectParameters(
  schema: JsonSchema,
  location: 'query' | 'header',
  where: string,
): readonly OpenApiParameter[] {
  if (schema['type'] !== 'object') {
    // The binder hands a record of fields to the query schema, so a schema whose
    // input is a string can never match. Reject it here rather than publish a
    // document describing an endpoint that always answers 422.
    throw new TypeError(
      `openapi: ${where} must describe an object to become ${location} parameters; ` +
        'field helpers such as `SortQuery` belong inside `z.object({ sort: SortQuery([...]) })`',
    );
  }
  const properties = schema['properties'];
  if (!isRecord(properties)) return [];
  const required = new Set(stringArray(schema['required']));

  return Object.entries(properties).map(([name, value]) => ({
    name,
    in: location,
    required: required.has(name),
    ...(isRecord(value) && typeof value['description'] === 'string'
      ? { description: value['description'] }
      : {}),
    schema: isRecord(value) ? value : {},
  }));
}

function pathParameters(
  names: readonly string[],
  paramsSchema: JsonSchema | undefined,
  where: string,
): readonly OpenApiParameter[] {
  const properties =
    paramsSchema !== undefined && isRecord(paramsSchema['properties'])
      ? paramsSchema['properties']
      : undefined;

  if (paramsSchema !== undefined && properties === undefined) {
    throw new TypeError(`openapi: ${where} declares a params schema that is not an object`);
  }

  if (properties !== undefined) {
    const declared = Object.keys(properties);
    const undocumented = names.filter((name) => !declared.includes(name));
    const unbound = declared.filter((name) => !names.includes(name));
    if (unbound.length > 0) {
      throw new TypeError(
        `openapi: ${where} binds ${unbound.join(', ')}, which the path does not contain`,
      );
    }
    if (undocumented.length > 0) {
      throw new TypeError(
        `openapi: ${where} leaves path parameter${undocumented.length === 1 ? '' : 's'} ` +
          `${undocumented.join(', ')} without a schema`,
      );
    }
  }

  return names.map((name) => {
    const declared = properties?.[name];
    return {
      name,
      in: 'path' as const,
      required: true,
      schema: isRecord(declared) ? declared : { type: 'string' },
    };
  });
}

function operationFor(
  route: RouteEntry,
  convert: (input: AnyStandardSchema) => JsonSchema | undefined,
  withProblems: boolean,
): { template: string; operation: OpenApiOperation } {
  const { template, params, wildcard } = openApiPath(route.path);
  const where = `${route.method} ${route.path}`;
  const { meta } = route;

  const parameters: OpenApiParameter[] = [
    ...pathParameters(
      params,
      meta.params === undefined ? undefined : describe(meta.params, convert, `${where} params`),
      where,
    ),
    ...(wildcard
      ? [
          {
            name: 'wildcard',
            in: 'path' as const,
            required: true,
            description: 'The `*` catch-all: every remaining path segment, bound as `params["*"]`.',
            schema: { type: 'string' },
          },
        ]
      : []),
    ...(meta.query === undefined
      ? []
      : objectParameters(
          describe(meta.query, convert, `${where} query`),
          'query',
          `${where} query`,
        )),
    ...(meta.headers === undefined
      ? []
      : objectParameters(
          describe(meta.headers, convert, `${where} headers`),
          'header',
          `${where} headers`,
        )),
  ];

  const status = meta.status ?? 200;
  const mediaType = meta.consumes?.[0] ?? 'application/json';

  // `summary` describes the operation, never the response. Until response
  // contracts exist, each success response says what it does not know.
  const responses: Record<string, OpenApiResponseObject> = {
    [String(status)]: {
      description: `\`${String(status)}\` response; the handler declares no response schema.`,
    },
  };
  if (withProblems) {
    responses['4XX'] = { $ref: '#/components/responses/Problem' };
    responses['5XX'] = { $ref: '#/components/responses/Problem' };
  }

  return {
    template,
    operation: {
      operationId: meta.operationId ?? `${route.controller.name}.${route.handler}`,
      ...(meta.summary === undefined ? {} : { summary: meta.summary }),
      ...(meta.tags === undefined ? {} : { tags: [...meta.tags] }),
      ...(parameters.length === 0 ? {} : { parameters }),
      ...(meta.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: { [mediaType]: { schema: describe(meta.body, convert, `${where} body`) } },
            },
          }),
      responses,
    },
  };
}

/**
 * Builds a document from a compiled table. Deterministic: the table is already
 * sorted by the compiler, so the same routes always produce byte-identical JSON.
 */
export function createOpenApiDocument(table: RouteTable, options: OpenApiOptions): OpenApiDocument {
  const convert = options.convertSchema ?? defaultConvert;
  const withProblems = options.problemResponses ?? true;

  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  for (const route of table.routes) {
    const { template, operation } = operationFor(route, convert, withProblems);
    const item = paths[template] ?? {};
    item[route.method.toLowerCase()] = operation;
    paths[template] = item;
  }

  return Object.freeze({
    openapi: '3.1.0' as const,
    info: Object.freeze({
      title: options.title,
      version: options.version,
      ...(options.description === undefined ? {} : { description: options.description }),
    }),
    ...(options.servers === undefined ? {} : { servers: Object.freeze([...options.servers]) }),
    paths: Object.freeze(paths),
    components: Object.freeze({
      schemas: Object.freeze({ Problem: PROBLEM_SCHEMA }),
      responses: Object.freeze({
        Problem: {
          description: 'Any 4xx/5xx response (RFC 9457 `application/problem+json`).',
          content: { 'application/problem+json': { schema: PROBLEM_SCHEMA } },
        } satisfies OpenApiResponse,
      }),
    }),
  });
}
