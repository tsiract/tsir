/**
 * Roles and permissions endpoints.
 *
 * Roles are named collections of permissions. Permissions are the atomic units
 * the RBAC checks. A role has many permissions; a permission can belong to many
 * roles.
 */
import { Controller, Delete, Get, Patch, Post } from '@tsir/router';
import { z } from '@tsir/validate';
import { and, eq, inArray } from 'drizzle-orm';
import { token } from '@tsir/container';

import { registry } from '../registry.ts';
import { type DrizzleDb } from '../../../database.ts';
import { roles, permissions, rolePermissions } from '../../shared/schema.ts';
import { type AuditService } from '../../shared/audit.ts';
import type { AppPrincipal } from '../../auth/index.ts';

export const UuidParam = z.string().uuid();

export const CreateRole = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  permissionIds: z.array(z.string().uuid()).optional(),
});

export const UpdateRole = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional().nullable(),
  permissionIds: z.array(z.string().uuid()).optional(),
});

export const CreatePermission = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});

export const RoleIdParams = z.object({ id: UuidParam });
export const PermissionIdParams = z.object({ id: UuidParam });

export const rolesControllerToken = token<RolesController>('RolesController');
export const permissionsControllerToken = token<PermissionsController>('PermissionsController');

@Controller(registry, '/api/roles')
export class RolesController {
  constructor(
    private readonly drizzle: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  @Get('/', { guards: ['session', 'superAdmin'], tags: ['rbac'], operationId: 'rbac.listRoles' })
  async list(): Promise<unknown> {
    const rows = await this.drizzle.select().from(roles);
    return { data: rows };
  }

  @Get('/:id', {
    guards: ['session', 'superAdmin'],
    params: RoleIdParams,
    tags: ['rbac'],
    operationId: 'rbac.getRole',
  })
  async get({ params }: { params: { id: string } }): Promise<unknown> {
    const rows = await this.drizzle.select().from(roles).where(eq(roles.id, params.id));
    const role = rows[0];
    if (role === undefined) return new Response(null, { status: 404 });
    const perms = await this.drizzle
      .select({ id: permissions.id, name: permissions.name, description: permissions.description })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(rolePermissions.roleId, params.id));
    return { ...role, permissions: perms };
  }

  @Post('/', {
    guards: ['session', 'superAdmin'],
    principal: true,
    body: CreateRole,
    status: 201,
    tags: ['rbac'],
    operationId: 'rbac.createRole',
  })
  async create({
    body,
    principal,
  }: {
    body: z.infer<typeof CreateRole>;
    principal: AppPrincipal;
  }): Promise<unknown> {
    const [role] = await this.drizzle
      .insert(roles)
      .values({ name: body.name, description: body.description })
      .returning();
    if (role === undefined) throw new Error('insert returned no row');
    if (body.permissionIds && body.permissionIds.length > 0) {
      await this.drizzle
        .insert(rolePermissions)
        .values(body.permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })));
    }
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'rbac.create_role',
      subject: role.id,
    });
    return role;
  }

  @Patch('/:id', {
    guards: ['session', 'superAdmin'],
    principal: true,
    params: RoleIdParams,
    body: UpdateRole,
    tags: ['rbac'],
    operationId: 'rbac.updateRole',
  })
  async update({
    params,
    body,
    principal,
  }: {
    params: { id: string };
    body: z.infer<typeof UpdateRole>;
    principal: AppPrincipal;
  }): Promise<unknown> {
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;

    const [role] = await this.drizzle
      .update(roles)
      .set(updates)
      .where(eq(roles.id, params.id))
      .returning();
    if (role === undefined) return new Response(null, { status: 404 });

    if (body.permissionIds !== undefined) {
      await this.drizzle.delete(rolePermissions).where(eq(rolePermissions.roleId, params.id));
      if (body.permissionIds.length > 0) {
        await this.drizzle
          .insert(rolePermissions)
          .values(body.permissionIds.map((permissionId) => ({ roleId: params.id, permissionId })));
      }
    }
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'rbac.update_role',
      subject: params.id,
    });
    return role;
  }

  @Delete('/:id', {
    guards: ['session', 'superAdmin'],
    principal: true,
    params: RoleIdParams,
    status: 204,
    tags: ['rbac'],
    operationId: 'rbac.deleteRole',
  })
  async remove({
    params,
    principal,
  }: {
    params: { id: string };
    principal: AppPrincipal;
  }): Promise<void> {
    await this.drizzle.delete(roles).where(eq(roles.id, params.id));
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'rbac.delete_role',
      subject: params.id,
    });
  }
}

@Controller(registry, '/api/permissions')
export class PermissionsController {
  constructor(
    private readonly drizzle: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  @Get('/', {
    guards: ['session', 'superAdmin'],
    tags: ['rbac'],
    operationId: 'rbac.listPermissions',
  })
  async list(): Promise<unknown> {
    const rows = await this.drizzle.select().from(permissions);
    return { data: rows };
  }

  @Post('/', {
    guards: ['session', 'superAdmin'],
    principal: true,
    body: CreatePermission,
    status: 201,
    tags: ['rbac'],
    operationId: 'rbac.createPermission',
  })
  async create({
    body,
    principal,
  }: {
    body: z.infer<typeof CreatePermission>;
    principal: AppPrincipal;
  }): Promise<unknown> {
    const [perm] = await this.drizzle
      .insert(permissions)
      .values({ name: body.name, description: body.description })
      .returning();
    if (perm === undefined) throw new Error('insert returned no row');
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'rbac.create_permission',
      subject: perm.id,
    });
    return perm;
  }

  @Delete('/:id', {
    guards: ['session', 'superAdmin'],
    principal: true,
    params: PermissionIdParams,
    status: 204,
    tags: ['rbac'],
    operationId: 'rbac.deletePermission',
  })
  async remove({
    params,
    principal,
  }: {
    params: { id: string };
    principal: AppPrincipal;
  }): Promise<void> {
    await this.drizzle.delete(permissions).where(eq(permissions.id, params.id));
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'rbac.delete_permission',
      subject: params.id,
    });
  }
}

void and;
void inArray;
