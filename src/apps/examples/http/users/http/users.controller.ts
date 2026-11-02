/**
 * A controller that exercises the Phase 2 surface: path parameters, a query
 * schema, a JSON body, a declared status, and route-level metadata.
 *
 * Controllers are plain classes. They never resolve anything from a container —
 * dependencies arrive through the constructor, which `@tsir/http` reads from the
 * app's container when it constructs one per request.
 */

import { Controller, Delete, Get, Post } from '@tsir/router';

import { registry } from '../routes.ts';
import { z } from '@tsir/validate';
import type { Principal } from '@tsir/http';
import { IntParam, PageQuery } from '@tsir/validate/http';

/**
 * Validators are exported by name because `routes.gen.ts` imports them: a
 * Standard Schema value cannot be serialized into source, so the compiler
 * matches the object by identity and emits an import instead (RTR-007). Keeping
 * them in the controller module — rather than inline in the decorator — is what
 * makes that possible.
 */
export const CreateUser = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
});

export const UserIdParams = z.object({ id: IntParam });

export const UserPage = PageQuery({ maxPerPage: 100 });

export const UserProfile = z.object({
  id: z.number().int().positive(),
  email: z.email(),
  displayName: z.string().min(1),
});

@Controller(registry, '/api/users')
// declared for its decorator side effect
export class UsersController {
  @Get('/', { query: UserPage, tags: ['users'], operationId: 'users.list' })
  list({ query }: { query: { page: number; perPage: number } }): unknown {
    return { page: query.page, perPage: query.perPage, data: [] };
  }

  @Get('/:id', { params: UserIdParams, tags: ['users'] })
  findOne({ params }: { params: { id: number } }): unknown {
    return { id: params.id };
  }

  @Post('/', { body: CreateUser, status: 201, tags: ['users'] })
  create({ body }: { body: z.infer<typeof CreateUser> }): unknown {
    return { id: 1, ...body };
  }

  /**
   * Binds `principal`, which the router only permits together with a guard:
   * without one the value could not exist, so `principal: true` alone is
   * `RTR_PRINCIPAL_WITHOUT_GUARD` at compile time.
   *
   * `response` declares what this handler may return. In `dev` a mismatch is
   * reported; with `responseValidation: 'always'` it becomes a 500, because a
   * contract violation the caller can see is worse than one they cannot.
   */
  @Get('/:id/profile', {
    params: UserIdParams,
    guards: ['auth'],
    principal: true,
    response: UserProfile,
    tags: ['users'],
    operationId: 'users.profile',
  })
  profile({
    params,
    principal,
  }: {
    params: { id: number };
    principal: Principal<{ plan: string }>;
  }): unknown {
    return {
      id: params.id,
      email: `${principal.subject}@example.com`,
      displayName: principal.subject,
    };
  }

  @Delete('/:id', { params: UserIdParams, status: 204, tags: ['users'] })
  remove(): void {
    // Deleting an id that does not exist is not an error in this example.
  }
}
