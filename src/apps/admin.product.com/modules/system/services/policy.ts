/**
 * Authorization: roles, permissions, and policies.
 *
 * `@tsir/policy` answers "can this principal do this action on this resource?".
 * Roles carry permissions; policies carry ownership and context rules; gates
 * carry cross-cutting denials (suspended accounts, &c.).
 *
 * The generated policies (`user-update`, `user-delete`) are registered here.
 * A service calls `registry.require({ principal, resource, action, data })`
 * which either returns a decision or throws `POL_FORBIDDEN`.
 */
import { createPolicyBootstrap, defineRole } from '@tsir/policy';
import { userUpdatePolicy } from '../policies/user-update.policy.ts';
import { userDeletePolicy } from '../policies/user-delete.policy.ts';

export const { roles, registry, policyRegistryToken, policyRegistryProvider } =
  createPolicyBootstrap({
    roles: [
      defineRole({
        name: 'user',
        permissions: ['user.update'],
        description: 'A registered user — can update their own account',
      }),
      defineRole({
        name: 'admin',
        implies: ['user'],
        permissions: ['user.update', 'user.delete'],
        description: 'An administrator — can manage all users',
      }),
    ],
    policies: [userUpdatePolicy, userDeletePolicy],
  });
