/**
 * Groups endpoints.
 *
 * A group can hold users, roles, and direct permissions. A user's effective
 * permissions include every permission of every group they belong to (directly
 * or via the group's roles plus the group's direct permissions).
 */
import { Controller, Delete, Get, Patch, Post } from '@tsir/router';
import { z } from '@tsir/validate';
import { eq, inArray } from 'drizzle-orm';
import { token } from '@tsir/container';

import { registry } from '../registry.ts';
import { type DrizzleDb } from '../../../database.ts';
import {
  groupPermissions,
  groupRoles,
  groupUsers,
  groups,
  permissions,
  roles,
  users,
} from '../../shared/schema.ts';
import { type AuditService } from '../../shared/audit.ts';
import type { AppPrincipal } from '../../auth/index.ts';

export const UuidParam = z.string().uuid();

export const CreateGroup = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  userIds: z.array(z.string().uuid()).optional(),
  roleIds: z.array(z.string().uuid()).optional(),
  permissionIds: z.array(z.string().uuid()).optional(),
});

export const UpdateGroup = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional().nullable(),
  userIds: z.array(z.string().uuid()).optional(),
  roleIds: z.array(z.string().uuid()).optional(),
  permissionIds: z.array(z.string().uuid()).optional(),
});

export const GroupIdParams = z.object({ id: UuidParam });

export const groupsControllerToken = token<GroupsController>('GroupsController');

@Controller(registry, '/api/groups')
export class GroupsController {
  constructor(
    private readonly drizzle: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  @Get('/', { guards: ['session', 'superAdmin'], tags: ['rbac'], operationId: 'rbac.listGroups' })
  async list(): Promise<unknown> {
    const rows = await this.drizzle.select().from(groups);
    return { data: rows };
  }

  @Get('/:id', {
    guards: ['session', 'superAdmin'],
    params: GroupIdParams,
    tags: ['rbac'],
    operationId: 'rbac.getGroup',
  })
  async get({ params }: { params: { id: string } }): Promise<unknown> {
    const rows = await this.drizzle.select().from(groups).where(eq(groups.id, params.id));
    const group = rows[0];
    if (group === undefined) return new Response(null, { status: 404 });

    const memberRows = await this.drizzle
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(groupUsers)
      .innerJoin(users, eq(groupUsers.userId, users.id))
      .where(eq(groupUsers.groupId, params.id));

    const groupRolesRows = await this.drizzle
      .select({ id: roles.id, name: roles.name })
      .from(groupRoles)
      .innerJoin(roles, eq(groupRoles.roleId, roles.id))
      .where(eq(groupRoles.groupId, params.id));

    const groupPerms = await this.drizzle
      .select({ id: permissions.id, name: permissions.name })
      .from(groupPermissions)
      .innerJoin(permissions, eq(groupPermissions.permissionId, permissions.id))
      .where(eq(groupPermissions.groupId, params.id));

    return { ...group, users: memberRows, roles: groupRolesRows, permissions: groupPerms };
  }

  @Post('/', {
    guards: ['session', 'superAdmin'],
    principal: true,
    body: CreateGroup,
    status: 201,
    tags: ['rbac'],
    operationId: 'rbac.createGroup',
  })
  async create({
    body,
    principal,
  }: {
    body: z.infer<typeof CreateGroup>;
    principal: AppPrincipal;
  }): Promise<unknown> {
    const [group] = await this.drizzle
      .insert(groups)
      .values({ name: body.name, description: body.description })
      .returning();
    if (group === undefined) throw new Error('insert returned no row');

    await this.writeRelations(group.id, body.userIds, body.roleIds, body.permissionIds);
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'rbac.create_group',
      subject: group.id,
    });
    return group;
  }

  @Patch('/:id', {
    guards: ['session', 'superAdmin'],
    principal: true,
    params: GroupIdParams,
    body: UpdateGroup,
    tags: ['rbac'],
    operationId: 'rbac.updateGroup',
  })
  async update({
    params,
    body,
    principal,
  }: {
    params: { id: string };
    body: z.infer<typeof UpdateGroup>;
    principal: AppPrincipal;
  }): Promise<unknown> {
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;

    const [group] = await this.drizzle
      .update(groups)
      .set(updates)
      .where(eq(groups.id, params.id))
      .returning();
    if (group === undefined) return new Response(null, { status: 404 });

    if (
      body.userIds !== undefined ||
      body.roleIds !== undefined ||
      body.permissionIds !== undefined
    ) {
      await this.writeRelations(params.id, body.userIds, body.roleIds, body.permissionIds);
    }
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'rbac.update_group',
      subject: params.id,
    });
    return group;
  }

  @Delete('/:id', {
    guards: ['session', 'superAdmin'],
    principal: true,
    params: GroupIdParams,
    status: 204,
    tags: ['rbac'],
    operationId: 'rbac.deleteGroup',
  })
  async remove({
    params,
    principal,
  }: {
    params: { id: string };
    principal: AppPrincipal;
  }): Promise<void> {
    await this.drizzle.delete(groups).where(eq(groups.id, params.id));
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'rbac.delete_group',
      subject: params.id,
    });
  }

  /** Replace a group's user/role/permission assignments in one pass. */
  private async writeRelations(
    groupId: string,
    userIds: string[] | undefined,
    roleIds: string[] | undefined,
    permissionIds: string[] | undefined,
  ): Promise<void> {
    if (userIds !== undefined) {
      await this.drizzle.delete(groupUsers).where(eq(groupUsers.groupId, groupId));
      if (userIds.length > 0) {
        await this.drizzle
          .insert(groupUsers)
          .values(userIds.map((userId) => ({ groupId, userId })));
      }
    }
    if (roleIds !== undefined) {
      await this.drizzle.delete(groupRoles).where(eq(groupRoles.groupId, groupId));
      if (roleIds.length > 0) {
        await this.drizzle
          .insert(groupRoles)
          .values(roleIds.map((roleId) => ({ groupId, roleId })));
      }
    }
    if (permissionIds !== undefined) {
      await this.drizzle.delete(groupPermissions).where(eq(groupPermissions.groupId, groupId));
      if (permissionIds.length > 0) {
        await this.drizzle
          .insert(groupPermissions)
          .values(permissionIds.map((permissionId) => ({ groupId, permissionId })));
      }
    }
  }
}

void inArray;
