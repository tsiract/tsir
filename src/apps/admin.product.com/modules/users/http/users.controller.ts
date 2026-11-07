/**
 * User management endpoints.
 *
 * List/create/update/delete users. Passwords are hashed with `@tsir/auth`'s
 * hasher. Users are never returned with their password hash.
 */
import { Controller, Delete, Get, Patch, Post } from '@tsir/router';
import { z } from '@tsir/validate';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { token } from '@tsir/container';

import { registry } from '../registry.ts';
import { type DrizzleDb } from '../../../database.ts';
import { users, userRoles, roles } from '../../shared/schema.ts';
import type { AuthService } from '../../auth/services/auth.service.ts';
import type { AuditService } from '../../shared/audit.ts';
import type { AppPrincipal } from '../../auth/index.ts';
import type { RbacService } from '../../rbac/services/rbac.service.ts';

export const UuidParam = z.string().uuid();

export const CreateUser = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(120).optional(),
  roleIds: z.array(z.string().uuid()).optional(),
});

export const UpdateUser = z.object({
  email: z.email().optional(),
  displayName: z.string().min(1).max(120).optional().nullable(),
  password: z.string().min(8).max(200).optional(),
  roleIds: z.array(z.string().uuid()).optional(),
  isSuperAdmin: z.boolean().optional(),
});

export const UserIdParams = z.object({ id: UuidParam });

export const usersControllerToken = token<UsersController>('UsersController');

@Controller(registry, '/api/users')
export class UsersController {
  constructor(
    private readonly drizzle: DrizzleDb,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
  ) {}

  @Get('/', { guards: ['session', 'superAdmin'], tags: ['users'], operationId: 'users.list' })
  async list({
    query,
  }: {
    query?: { search?: string; page?: string; perPage?: string };
  }): Promise<unknown> {
    const DIGITS = /^\d+$/;
    const pageRaw = query?.page ?? '1';
    const perPageRaw = query?.perPage ?? '20';
    const page = DIGITS.test(pageRaw) ? Math.max(1, Number.parseInt(pageRaw, 10)) : 1; // coercion-ok: digits-only query param, regex-guarded
    const perPage = DIGITS.test(perPageRaw)
      ? Math.min(100, Math.max(1, Number.parseInt(perPageRaw, 10)))
      : 20; // coercion-ok: digits-only query param, regex-guarded
    const search = query?.search;

    const base = this.drizzle
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        isSuperAdmin: users.isSuperAdmin,
        emailVerified: users.emailVerified,
        createdAt: users.createdAt,
      })
      .from(users);

    const rows = search
      ? await base
          .where(like(users.email, `%${search}%`))
          .limit(perPage)
          .offset((page - 1) * perPage)
      : await base.limit(perPage).offset((page - 1) * perPage);

    const total = await this.drizzle.select({ count: sql<number>`count(*)` }).from(users);

    return { data: rows, page, perPage, total: total[0]?.count ?? 0 };
  }

  @Get('/:id', {
    guards: ['session', 'superAdmin'],
    params: UserIdParams,
    tags: ['users'],
    operationId: 'users.get',
  })
  async get({ params }: { params: { id: string } }): Promise<unknown> {
    const rows = await this.drizzle.select().from(users).where(eq(users.id, params.id));
    const user = rows[0];
    if (user === undefined) return new Response(null, { status: 404 });
    const { passwordHash, ...rest } = user;
    void passwordHash;
    return rest;
  }

  @Post('/', {
    guards: ['session', 'superAdmin'],
    principal: true,
    body: CreateUser,
    status: 201,
    tags: ['users'],
    operationId: 'users.create',
  })
  async create({
    body,
    principal,
  }: {
    body: z.infer<typeof CreateUser>;
    principal: AppPrincipal;
  }): Promise<unknown> {
    const passwordHash = await this.auth.hashPassword(body.password);
    const [user] = await this.drizzle
      .insert(users)
      .values({ email: body.email.toLowerCase(), passwordHash, displayName: body.displayName })
      .returning();
    if (user === undefined) throw new Error('insert returned no row');

    if (body.roleIds && body.roleIds.length > 0) {
      await this.drizzle
        .insert(userRoles)
        .values(body.roleIds.map((roleId) => ({ userId: user.id, roleId })));
    }

    await this.audit.record({
      actorId: principal.data.userId,
      action: 'users.create',
      subject: user.id,
    });
    const { passwordHash: _ph, ...rest } = user;
    void _ph;
    return rest;
  }

  @Patch('/:id', {
    guards: ['session', 'superAdmin'],
    principal: true,
    params: UserIdParams,
    body: UpdateUser,
    tags: ['users'],
    operationId: 'users.update',
  })
  async update({
    params,
    body,
    principal,
  }: {
    params: { id: string };
    body: z.infer<typeof UpdateUser>;
    principal: AppPrincipal;
  }): Promise<unknown> {
    const updates: Record<string, unknown> = {};
    if (body.email !== undefined) updates.email = body.email.toLowerCase();
    if (body.displayName !== undefined) updates.displayName = body.displayName;
    if (body.password !== undefined)
      updates.passwordHash = await this.auth.hashPassword(body.password);
    if (body.isSuperAdmin !== undefined) updates.isSuperAdmin = body.isSuperAdmin;

    const [user] = await this.drizzle
      .update(users)
      .set(updates)
      .where(eq(users.id, params.id))
      .returning();
    if (user === undefined) return new Response(null, { status: 404 });

    if (body.roleIds !== undefined) {
      await this.drizzle.delete(userRoles).where(eq(userRoles.userId, params.id));
      if (body.roleIds.length > 0) {
        await this.drizzle
          .insert(userRoles)
          .values(body.roleIds.map((roleId) => ({ userId: params.id, roleId })));
      }
    }

    await this.audit.record({
      actorId: principal.data.userId,
      action: 'users.update',
      subject: params.id,
    });
    const { passwordHash: _ph, ...rest } = user;
    void _ph;
    return rest;
  }

  @Delete('/:id', {
    guards: ['session', 'superAdmin'],
    principal: true,
    params: UserIdParams,
    status: 204,
    tags: ['users'],
    operationId: 'users.delete',
  })
  async remove({
    params,
    principal,
  }: {
    params: { id: string };
    principal: AppPrincipal;
  }): Promise<void> {
    await this.drizzle.delete(users).where(eq(users.id, params.id));
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'users.delete',
      subject: params.id,
    });
  }

  @Get('/:id/roles', {
    guards: ['session', 'superAdmin'],
    params: UserIdParams,
    tags: ['users'],
    operationId: 'users.listRoles',
  })
  async listRoles({ params }: { params: { id: string } }): Promise<unknown> {
    const rows = await this.drizzle
      .select({ id: roles.id, name: roles.name, description: roles.description })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, params.id));
    return { data: rows };
  }

  @Get('/:id/permissions', {
    guards: ['session', 'superAdmin'],
    params: UserIdParams,
    tags: ['users'],
    operationId: 'users.listPermissions',
  })
  async listPermissions({ params }: { params: { id: string } }): Promise<unknown> {
    const set = await this.rbac.resolvePermissions(params.id);
    return { data: [...set] };
  }
}

void and;
void inArray;
