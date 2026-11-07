/**
 * One-call policy bootstrap for apps that use `@tsir/policy`.
 *
 * Replaces the hand-written `modules/system/services/policy.ts` every app
 * previously needed: it builds the role graph and policy registry from the
 * app's role definitions and policies, and exposes the DI token + value
 * provider the rest of the app wires into its modules.
 *
 * Roles and policies are app-specific, so the app passes them in.
 */

import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { createRegistry, type Registry, type RegistryOptions } from './registry.ts';
import { createRoleGraph, type RoleDefinition, type RoleGraph } from './role.ts';

/** Options for `createPolicyBootstrap`. */
export interface PolicyBootstrapOptions {
  /** The app's role definitions. */
  readonly roles: readonly RoleDefinition[];
  /** The app's policy rules. */
  readonly policies?: RegistryOptions['policies'];
  /** The app's gate definitions. */
  readonly gates?: RegistryOptions['gates'];
  /** Where a principal's roles come from. Default: `data.roles`. */
  readonly rolesOf?: RegistryOptions['rolesOf'];
}

/** Everything an app needs to wire its policy layer. */
export interface PolicyBootstrap {
  /** The role graph. */
  readonly roles: RoleGraph;
  /** The policy registry. */
  readonly registry: Registry;
  /** DI token for `registry`. */
  readonly policyRegistryToken: Token<Registry>;
  /** Value provider for `registry`. */
  readonly policyRegistryProvider: Provider<Registry>;
}

/**
 * Build the policy layer from role definitions and policies.
 *
 * ```ts
 * import { createPolicyBootstrap, defineRole } from '@tsir/policy';
 * import { userUpdatePolicy } from './policies/user-update.policy.ts';
 *
 * export const { registry, policyRegistryToken, policyRegistryProvider } = createPolicyBootstrap({
 *   roles: [
 *     defineRole({ name: 'user', permissions: ['user.update'] }),
 *     defineRole({ name: 'admin', implies: ['user'], permissions: ['user.delete'] }),
 *   ],
 *   policies: [userUpdatePolicy],
 * });
 * ```
 */
export function createPolicyBootstrap(options: PolicyBootstrapOptions): PolicyBootstrap {
  const roles = createRoleGraph(options.roles);
  const registry = createRegistry({
    roles,
    policies: options.policies,
    gates: options.gates,
    rolesOf: options.rolesOf,
  });

  const policyRegistryToken = token<Registry>('policyRegistry');
  const policyRegistryProvider = valueProvider(policyRegistryToken, registry);

  return { roles, registry, policyRegistryToken, policyRegistryProvider };
}
