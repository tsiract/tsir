/**
 * Roles and permissions ( of the capability map).
 *
 * A **permission** is a string, `resource.action`, and the whole package treats it as the unit of
 * authority. `roles` are named sets of permissions; nothing in this file checks a role — it resolves
 * one to the permissions it implies, once, at construction.
 *
 * Three decisions:
 *
 * · **Roles imply roles, and the graph is checked.** `admin implies store.manager` is how a real
 * permission model is written, and a cycle in that graph has no fixed point — it is refused at
 * declaration with the path that closes it (`roleCycle`), not explored per request.
 * · **Permissions are sorted and deduplicated at the end.** A principal's effective set is a
 * `Set`, so `can` is a lookup rather than a scan, and `policy:list` prints a stable table.
 * · **A permission is validated where it is written.** `post.update` is also a route's policy
 * ref, so a typo in either place has to be caught by the same rule.
 */

import { duplicateRole, invalidPermission, invalidRole, roleCycle, unknownRole } from './errors.ts';

/** A permission string: `resource.action`, lowercase, dots allowed in the resource. */
export const PERMISSION_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$/u;
const ROLE_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/u;

/** `post.update` → `{ resource: 'post', action: 'update' }`. Split at the **last** dot. */
export function splitPermission(permission: string): { resource: string; action: string } {
  const index = permission.lastIndexOf('.');
  if (index <= 0 || index === permission.length - 1) {
    throw invalidPermission(permission, 'it has no `<resource>.<action>` shape');
  }
  return { resource: permission.slice(0, index), action: permission.slice(index + 1) };
}

/** `{ resource: 'post', action: 'update' }` → `post.update`. */
export function joinPermission(resource: string, action: string): string {
  return `${resource}.${action}`;
}

/**
 * `post.update` → `post:update` — the key a route's `PolicyRef` is registered under.
 *
 * The two spellings exist because they answer different questions: a permission is something a role
 * *grants*, and a ref is something a route *declares*. Both are the same pair, and converting in one
 * place is what keeps them from drifting into two vocabularies.
 */
export function permissionRef(permission: string): string {
  const { resource, action } = splitPermission(permission);
  return `${resource}:${action}`;
}

/** Throws unless `permission` is a well-formed permission string. Returns it. */
export function assertPermission(permission: string): string {
  if (!PERMISSION_PATTERN.test(permission)) {
    throw invalidPermission(
      permission,
      /[A-Z]/u.test(permission)
        ? 'permissions are lowercase'
        : 'it is not lowercase `<resource>.<action>`',
    );
  }
  return permission;
}

export interface RoleDefinition {
  readonly name: string;
  /** The permissions this role grants directly. Implied roles' permissions are added on top. */
  readonly permissions: readonly string[];
  /** Roles this one includes: `admin` implies `editor` implies `author`. */
  readonly implies: readonly string[];
  /** One line for `policy:list`. */
  readonly description?: string | undefined;
  /**
   * Never set. It exists so a test can assert the *effective* set without resolving a principal,
   * and so this file can downcast a `RoleDefinition<never>` into a registry of unknown ones.
   */
  readonly all?: never;
}

export function defineRole(input: {
  readonly name: string;
  readonly permissions?: readonly string[] | undefined;
  readonly implies?: readonly string[] | undefined;
  readonly description?: string | undefined;
}): RoleDefinition {
  if (!ROLE_PATTERN.test(input.name)) {
    throw invalidRole(input.name, 'it is not lowercase with dots or dashes');
  }
  const permissions = (input.permissions ?? []).map(assertPermission);
  const implies = (input.implies ?? []).slice();
  for (const role of implies) {
    if (!ROLE_PATTERN.test(role))
      throw invalidRole(role, 'it is not lowercase with dots or dashes');
  }
  return Object.freeze({
    name: input.name,
    permissions: Object.freeze(permissions),
    implies: Object.freeze(implies),
    ...(input.description === undefined ? {} : { description: input.description }),
  });
}

/**
 * The resolved role graph: every role's **effective** permission set, in one pass.
 *
 * Resolution is a depth-first walk with a visited set — that is what turns a cycle from an infinite
 * loop into a sentence. `permissionsOf` hands back a copy, so a caller cannot add a permission to a
 * role at runtime and quietly grant it.
 */
export interface RoleGraph {
  readonly roles: readonly RoleDefinition[];
  readonly names: readonly string[];
  /** Every permission any role grants, sorted. What `policy:list` prints as the permission table. */
  readonly permissions: readonly string[];
  /** The effective permissions of one role, including implied roles. */
  permissionsOf(role: string): ReadonlySet<string>;
  /** A role that was never declared is an error, not an empty set. */
  has(role: string): boolean;
}

export function createRoleGraph(roles: readonly RoleDefinition[]): RoleGraph {
  const byName = new Map<string, RoleDefinition>();
  for (const role of roles) {
    if (byName.has(role.name)) throw duplicateRole(role.name);
    byName.set(role.name, role);
  }

  const names = [...byName.keys()].sort((a, b) => a.localeCompare(b));
  const resolved = new Map<string, ReadonlySet<string>>();
  const resolving = new Set<string>();

  const resolve = (name: string, path: readonly string[]): ReadonlySet<string> => {
    const cached = resolved.get(name);
    if (cached !== undefined) return cached;

    const role = byName.get(name);
    if (role === undefined) throw unknownRole(name, names);
    if (resolving.has(name)) throw roleCycle([...path, name]);

    resolving.add(name);
    const permissions = new Set<string>(role.permissions);
    for (const implied of role.implies) {
      for (const permission of resolve(implied, [...path, name])) permissions.add(permission);
    }
    resolving.delete(name);

    const frozen = new Set<string>([...permissions].sort((a, b) => a.localeCompare(b)));
    resolved.set(name, frozen);
    return frozen;
  };

  for (const name of names) resolve(name, []);

  const everyPermission = new Set<string>();
  for (const set of resolved.values())
    for (const permission of set) everyPermission.add(permission);

  return {
    roles: roles.slice(),
    names,
    permissions: [...everyPermission].sort((a, b) => a.localeCompare(b)),
    has(role) {
      return byName.has(role);
    },
    permissionsOf(role) {
      const set = resolved.get(role);
      if (set === undefined) throw unknownRole(role, names);
      // A copy, not the cached set: `Object.freeze` does not stop `Set.prototype.add`, and a caller
      // that could add to this set would be granting itself a permission.
      return new Set(set);
    },
  };
}
