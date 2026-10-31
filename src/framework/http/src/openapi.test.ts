import { describe, expect, test } from 'bun:test';

import { Controller, compileRoutes, Get, Post, RouteRegistry } from '@tsir/router';
import { z } from '@tsir/validate';
import { IntParam, PageQuery, SortQuery } from '@tsir/validate/http';

import { createOpenApiDocument, openApiPath, PROBLEM_SCHEMA } from './openapi.ts';

type Build = (registry: RouteRegistry) => void;

function document(
  build: Build = () => undefined,
  overrides: Partial<{ problemResponses: boolean }> = {},
) {
  const registry = new RouteRegistry();
  build(registry);
  return createOpenApiDocument(compileRoutes(registry.entries()), {
    title: 'acme',
    version: '1.2.3',
    ...overrides,
  });
}

function operation(doc: ReturnType<typeof document>, path: string, method: string) {
  const found = doc.paths[path]?.[method];
  if (found === undefined) throw new Error(`no ${method} operation at ${path}`);
  return found;
}

describe('openapi · paths', () => {
  test('path parameters become templated segments', () => {
    expect(openApiPath('/users/:id')).toEqual({
      template: '/users/{id}',
      params: ['id'],
      wildcard: false,
    });
    expect(openApiPath('/')).toEqual({ template: '/', params: [], wildcard: false });
    expect(openApiPath('/files/*')).toEqual({
      template: '/files/{wildcard}',
      params: [],
      wildcard: true,
    });
  });

  test('a route is described with the documented path, not the runtime one', () => {
    const doc = document((registry) => {
      @Controller(registry, '/users')
      // declared for its decorator side effect
      class Users {
        @Get('/:id', { params: z.object({ id: IntParam }) })
        findOne(): unknown {
          return null;
        }
      }
      void Users;
    });

    expect(Object.keys(doc.paths)).toEqual(['/users/{id}']);
    // Input-side: a client sends text, and `IntParam` accepts only `/^-?\d+$/`.
    // Publishing `type: integer` would imply `4.0` and `4e3` are accepted; they are not.
    expect(operation(doc, '/users/{id}', 'get').parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^-?\\d+$' } },
    ]);
  });

  test('two methods on one path share a single path item', () => {
    const doc = document((registry) => {
      @Controller(registry, '/users')
      // declared for its decorator side effect
      class Users {
        @Get('/')
        list(): unknown {
          return null;
        }

        @Post('/', { status: 201 })
        create(): unknown {
          return null;
        }
      }
      void Users;
    });

    expect(Object.keys(doc.paths)).toEqual(['/users']);
    expect(Object.keys(doc.paths['/users'] ?? {})).toEqual(['get', 'post']);
    expect(Object.keys(operation(doc, '/users', 'post').responses)).toContain('201');
  });
});

describe('openapi · inputs', () => {
  test('query schemas are flattened to parameters with input-side types', () => {
    const doc = document((registry) => {
      @Controller(registry, '/users')
      // declared for its decorator side effect
      class Users {
        @Get('/', { query: PageQuery({ maxPerPage: 50 }) })
        list(): unknown {
          return null;
        }
      }
      void Users;
    });

    const [page, perPage] = operation(doc, '/users', 'get').parameters ?? [];
    // `?page=2` arrives as a string; the document must say so, not claim an integer.
    expect(page).toEqual({
      name: 'page',
      in: 'query',
      required: false,
      schema: { type: 'string', pattern: '^\\d+$' },
    });
    expect(perPage?.name).toBe('perPage');
  });

  test('a body schema becomes a JSON request body under the declared media type', () => {
    const CreateUser = z.object({ email: z.email(), name: z.string().min(1) });

    const doc = document((registry) => {
      @Controller(registry, '/users')
      // declared for its decorator side effect
      class Users {
        @Post('/', { body: CreateUser, status: 201 })
        create(): unknown {
          return null;
        }
      }
      void Users;
    });

    const create = operation(doc, '/users', 'post');
    expect(create.requestBody?.required).toBe(true);
    const schema = create.requestBody?.content['application/json']?.schema;
    expect(Object.keys(schema?.['properties'] ?? {})).toEqual(['email', 'name']);
  });

  test('a declared media type other than JSON is respected', () => {
    const doc = document((registry) => {
      @Controller(registry, '/hooks')
      // declared for its decorator side effect
      class Hooks {
        @Post('/', { body: z.object({ ok: z.boolean() }), consumes: ['text/plain'] })
        receive(): unknown {
          return null;
        }
      }
      void Hooks;
    });

    expect(Object.keys(operation(doc, '/hooks', 'post').requestBody?.content ?? {})).toEqual([
      'text/plain',
    ]);
  });
});

describe('openapi · description and failures', () => {
  test('an operation carries its id, summary, tags and problem responses', () => {
    const doc = document((registry) => {
      @Controller(registry, '/reports')
      // declared for its decorator side effect
      class Reports {
        @Get('/', { operationId: 'reports.list', summary: 'List reports', tags: ['reports'] })
        list(): unknown {
          return null;
        }
      }
      void Reports;
    });

    const list = operation(doc, '/reports', 'get');
    expect(list.operationId).toBe('reports.list');
    expect(list.summary).toBe('List reports');
    expect(list.tags).toEqual(['reports']);
    expect(list.responses['4XX']).toEqual({ $ref: '#/components/responses/Problem' });
    expect(list.responses['5XX']).toEqual({ $ref: '#/components/responses/Problem' });
    // No response contracts yet: the default response says so instead of guessing.
    const ok = list.responses['200'];
    expect(ok !== undefined && '$ref' in ok ? ok : ok?.description).toBe(
      '`200` response; the handler declares no response schema.',
    );
  });

  test('operations without an explicit id derive one from the controller and handler', () => {
    const doc = document((registry) => {
      @Controller(registry, '/health')
      // declared for its decorator side effect
      class HealthController {
        @Get('/')
        check(): unknown {
          return null;
        }
      }
      void HealthController;
    });

    expect(operation(doc, '/health', 'get').operationId).toBe('HealthController.check');
  });

  test('problem responses can be turned off for a partial document', () => {
    const doc = document(
      (registry) => {
        @Controller(registry, '/health')
        // declared for its decorator side effect
        class Health {
          @Get('/')
          check(): unknown {
            return null;
          }
        }
        void Health;
      },
      { problemResponses: false },
    );

    expect(Object.keys(operation(doc, '/health', 'get').responses)).toEqual(['200']);
  });

  test('a non-Zod validator fails loudly and names the route', () => {
    const handmade = {
      '~standard': {
        version: 1 as const,
        vendor: 'handmade',
        validate: (value: unknown) => ({ value }),
      },
    };

    expect(() =>
      document((registry) => {
        @Controller(registry, '/custom')
        // declared for its decorator side effect
        class Custom {
          @Get('/', { query: handmade })
          list(): unknown {
            return null;
          }
        }
        void Custom;
      }),
    ).toThrow(/GET \/custom query/);
  });

  test('a query schema whose input is not an object is rejected, matching the binder', () => {
    // `SortQuery` reads a string; the binder hands the query schema a record, so a
    // string-rooted query schema can never match. Better to fail generation than
    // publish an endpoint that always answers 422.
    expect(() =>
      document((registry) => {
        @Controller(registry, '/search')
        // declared for its decorator side effect
        class Search {
          @Get('/', { query: SortQuery(['createdAt']) })
          run(): unknown {
            return null;
          }
        }
        void Search;
      }),
    ).toThrow(/must describe an object.*SortQuery/s);
  });

  test('a params schema naming something the path does not contain is rejected', () => {
    expect(() =>
      document((registry) => {
        @Controller(registry, '/users')
        // declared for its decorator side effect
        class Users {
          @Get('/:id', { params: z.object({ slug: z.string() }) })
          findOne(): unknown {
            return null;
          }
        }
        void Users;
      }),
    ).toThrow(/binds slug/);
  });
});

describe('openapi · document', () => {
  test('the shell is 3.1.0 with info, servers and a shared Problem component', () => {
    const registry = new RouteRegistry();
    const doc = createOpenApiDocument(compileRoutes(registry.entries()), {
      title: 'acme',
      version: '1.2.3',
      description: 'An example service.',
      servers: [{ url: 'https://api.example.com', description: 'production' }],
    });

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual({
      title: 'acme',
      version: '1.2.3',
      description: 'An example service.',
    });
    expect(doc.servers).toHaveLength(1);
    expect(doc.components.schemas['Problem']).toBe(PROBLEM_SCHEMA);
    expect(doc.paths).toEqual({});
  });

  test('generation is deterministic and serializes without cycles', () => {
    const build: Build = (registry) => {
      @Controller(registry, '/users')
      // declared for its decorator side effect
      class Users {
        @Get('/', { query: PageQuery() })
        list(): unknown {
          return null;
        }

        @Post('/', { body: z.object({ email: z.email() }), status: 201 })
        create(): unknown {
          return null;
        }
      }
      void Users;
    };

    const first = JSON.stringify(document(build));
    expect(JSON.stringify(document(build))).toBe(first);
    expect(JSON.parse(first)).toHaveProperty('openapi', '3.1.0');
  });
});

describe('openapi · unknown-key policy (VLD-005)', () => {
  function bodySchema(
    schema:
      | ReturnType<typeof z.object>
      | ReturnType<typeof z.strictObject>
      | ReturnType<typeof z.looseObject>,
  ) {
    const doc = document((registry) => {
      @Controller(registry, '/')
      class Things {
        @Post('/', { body: schema })
        create(): unknown {
          return null;
        }
      }
      void Things;
    });
    const op = operation(doc, '/', 'post') as {
      requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
    };
    // A media type object wraps the schema; `$ref` (if any) points at components.
    const inline = op.requestBody?.content?.['application/json']?.schema;
    if (inline?.$ref === undefined) return inline;
    const name = inline.$ref.split('/').pop() ?? '';
    return (doc.components?.schemas as Record<string, unknown> | undefined)?.[name];
  }

  test('strip is published as a vendor extension, not as additionalProperties: false', () => {
    // `additionalProperties: false` would claim the server rejects extras; it
    // accepts and drops them, so the honest document says so explicitly.
    const schema = bodySchema(z.object({ name: z.string() })) as Record<string, unknown>;
    expect(schema['additionalProperties']).toBeUndefined();
    expect(schema['x-tsir-unknown-keys']).toBe('strip');
  });

  test('strict is published as additionalProperties: false', () => {
    const schema = bodySchema(z.strictObject({ name: z.string() })) as Record<string, unknown>;
    expect(schema['additionalProperties']).toBe(false);
  });

  test('passthrough is published as additionalProperties: true', () => {
    const schema = bodySchema(z.looseObject({ name: z.string() })) as Record<string, unknown>;
    expect(schema['additionalProperties']).toBe(true);
  });
});
