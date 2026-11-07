/**
 * RBAC permission resolution.
 *
 * A user's effective permission set is the union of:
 *
 *   · permissions granted directly to the user (`user_permissions`),
 *   · permissions of every role assigned to the user (`user_roles` → `role_permissions`),
 *   · permissions of every group the user belongs to (`group_users` → `group_permissions`),
 *   · permissions of every role assigned to those groups (`group_roles` → `role_permissions`).
 *
 * A super-admin has every permission without an explicit list.
 *
 * The result is a `Set<string>` of permission names. `can(user, 'users.create')` is the check.
 */
import { token } from '@tsir/container';
import { type DrizzleDb } from '../../../database.ts';
import {
  groupPermissions,
  groupRoles,
  groupUsers,
  permissions,
  rolePermissions,
  userPermissions,
  userRoles,
  users,
} from '../../shared/schema.ts';
import { and, eq, inArray } from 'drizzle-orm';

export const rbacServiceToken = token<RbacService>('RbacService');

export class RbacService {
  constructor(private readonly drizzle: DrizzleDb) {}

  /** Resolve every permission name a user effectively holds. */
  async resolvePermissions(userId: string): Promise<Set<string>> {
    const user = await this.drizzle
      .select({ isSuperAdmin: users.isSuperAdmin })
      .from(users)
      .where(eq(users.id, userId));
    if (user[0]?.isSuperAdmin === true) {
      const all = await this.drizzle.select({ name: permissions.name }).from(permissions);
      return new Set(all.map((p) => p.name));
    }

    const direct = await this.drizzle
      .select({ name: permissions.name })
      .from(userPermissions)
      .innerJoin(permissions, eq(userPermissions.permissionId, permissions.id))
      .where(eq(userPermissions.userId, userId));

    const userRoleIds = (
      await this.drizzle
        .select({ roleId: userRoles.roleId })
        .from(userRoles)
        .where(eq(userRoles.userId, userId))
    ).map((r) => r.roleId);

    const groupIds = (
      await this.drizzle
        .select({ groupId: groupUsers.groupId })
        .from(groupUsers)
        .where(eq(groupUsers.userId, userId))
    ).map((g) => g.groupId);

    const groupRoleIds =
      groupIds.length > 0
        ? (
            await this.drizzle
              .select({ roleId: groupRoles.roleId })
              .from(groupRoles)
              .where(inArray(groupRoles.groupId, groupIds))
          ).map((r) => r.roleId)
        : [];

    const allRoleIds = [...new Set([...userRoleIds, ...groupRoleIds])];
    const rolePerms =
      allRoleIds.length > 0
        ? await this.drizzle
            .select({ name: permissions.name })
            .from(rolePermissions)
            .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
            .where(inArray(rolePermissions.roleId, allRoleIds))
        : [];

    const groupPerms =
      groupIds.length > 0
        ? await this.drizzle
            .select({ name: permissions.name })
            .from(groupPermissions)
            .innerJoin(permissions, eq(groupPermissions.permissionId, permissions.id))
            .where(inArray(groupPermissions.groupId, groupIds))
        : [];

    const names = new Set<string>();
    for (const p of direct) names.add(p.name);
    for (const p of rolePerms) names.add(p.name);
    for (const p of groupPerms) names.add(p.name);
    return names;
  }

  /** Does this user hold this permission? */
  async can(userId: string, permission: string): Promise<boolean> {
    const set = await this.resolvePermissions(userId);
    return set.has(permission);
  }

  /** Require a permission; throw if absent. */
  async requirePermission(userId: string, permission: string): Promise<void> {
    if (!(await this.can(userId, permission))) {
      throw new Error(`FORBIDDEN: missing permission "${permission}"`);
    }
  }
}

void and;
