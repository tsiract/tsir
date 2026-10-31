/**
 * `@tsir/policy` error codes (append-only).
 *
 * A permission that is misspelled is the failure this package exists to make loud: the check
 * returns `false`, the route 403s, and the bug reads like a bug in the guard. So a permission is
 * validated where it is **written** (`policy.post.update` is refused), a role that nothing
 * declares is refused where it is resolved, and an implication cycle is refused at declaration
 * rather than explored at request time.
 */

import { TsirError } from '@tsir/container';

export type PolicyErrorCode =
  | 'POL_INVALID_PERMISSION'
  | 'POL_INVALID_ROLE'
  | 'POL_DUPLICATE_ROLE'
  | 'POL_UNKNOWN_ROLE'
  | 'POL_ROLE_CYCLE'
  | 'POL_DUPLICATE_POLICY'
  | 'POL_INVALID_DECISION'
  | 'POL_NO_PRINCIPAL'
  | 'POL_FORBIDDEN';

const KIND = 'capability';

export function invalidPermission(permission: string, why: string): TsirError {
  return new TsirError('POL_INVALID_PERMISSION', `"${permission}" is not a permission: ${why}`, {
    kind: KIND,
    hint: "a permission is `<resource>.<action>` in lowercase — `post.update`, `invoice.void` — because the same string is a route's policy ref",
    context: { permission },
  });
}

export function invalidRole(name: string, why: string): TsirError {
  return new TsirError('POL_INVALID_ROLE', `"${name}" is not a role name: ${why}`, {
    kind: KIND,
    hint: 'role names are lowercase with dots or dashes — `admin`, `store.manager`',
    context: { role: name },
  });
}

export function duplicateRole(name: string): TsirError {
  return new TsirError('POL_DUPLICATE_ROLE', `two roles are both named "${name}"`, {
    kind: KIND,
    hint: 'a role name is what a principal carries, so a duplicate silently merges two permission sets',
    context: { role: name },
  });
}

export function unknownRole(name: string, known: readonly string[]): TsirError {
  return new TsirError('POL_UNKNOWN_ROLE', `unknown role "${name}"`, {
    kind: KIND,
    hint:
      `declared roles: ${known.length === 0 ? 'none' : known.join(', ')} — ` +
      'an undeclared role grants nothing; it is not a fallback and not an error the caller can ignore',
    context: { role: name, known: known.join(',') },
  });
}

export function roleCycle(path: readonly string[]): TsirError {
  return new TsirError('POL_ROLE_CYCLE', `role implications form a cycle: ${path.join(' → ')}`, {
    kind: KIND,
    hint: 'remove one `implies` edge — a cycle has no effective permission set, so nothing can be checked against it',
    context: { path: path.join(' → ') },
  });
}

export function duplicatePolicy(ref: string): TsirError {
  return new TsirError('POL_DUPLICATE_POLICY', `two policies are both registered for "${ref}"`, {
    kind: KIND,
    hint: 'one `resource:action` has one policy; a second registration is a decision nobody can predict from reading the code',
    context: { policy: ref },
  });
}

export function invalidDecision(ref: string, answered: string): TsirError {
  return new TsirError(
    'POL_INVALID_DECISION',
    `the policy for "${ref}" answered ${answered}, which is not a decision`,
    {
      kind: KIND,
      hint: 'a policy returns `{ allowed: true }` or `{ allowed: false, reason }` — anything else fails closed at the caller',
      context: { policy: ref, answered },
    },
  );
}

export function noPrincipal(permission: string): TsirError {
  return new TsirError('POL_NO_PRINCIPAL', `"${permission}" was checked with no principal`, {
    kind: KIND,
    hint: 'an unauthenticated caller has no permissions: return early, or let the guard produce a principal before the check',
    context: { permission },
  });
}

export function forbidden(permission: string, reason: string): TsirError {
  return new TsirError('POL_FORBIDDEN', `"${permission}" was refused: ${reason}`, {
    kind: KIND,
    hint: 'this is the service-boundary form of a 403: the caller is authenticated and the rule said no',
    context: { permission },
  });
}
