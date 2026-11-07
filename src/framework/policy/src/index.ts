/**
 * @tsir/policy — roles, permissions and policies.
 *
 * ```ts
 * const roles = createRoleGraph([
 * defineRole({ name: 'author', permissions: ['post.create', 'post.update'] }),
 * defineRole({ name: 'admin', implies: ['author'], permissions: ['post.delete'] }),
 * ]);
 *
 * const policies = createRegistry({
 * roles,
 * policies: {
 * // ownership lives here, and only here
 * 'post:update': ({ principal, data }) =>
 * (data as Post | undefined)?.authorId === principal.subject
 * ? allow('policy')
 *: deny('policy', 'only the author may edit this post'),
 * },
 * gates: [denyGate({ name: 'suspended', check: (ctx) => suspended(ctx.principal) ? deny('gate', 'account is suspended'): undefined })],
 * });
 *
 * await policies.require({ principal, resource: 'post', action: 'update', data: post }); // or throws
 * ```
 *
 * The registry is HTTP-free on purpose: the same `authorize` is what a service, a job and an RPC
 * handler call, which is the only way "the rule is enforced" can mean anything outside a controller.
 */

export { allow, deny, isDecision } from './decision.ts';
export type { Decision, DecisionSource, PolicyAnswer, PolicyRequest } from './decision.ts';

export {
  assertPermission,
  createRoleGraph,
  defineRole,
  joinPermission,
  PERMISSION_PATTERN,
  permissionRef,
  splitPermission,
  type RoleDefinition,
  type RoleGraph,
} from './role.ts';

export {
  allowGate,
  createRegistry,
  denyGate,
  rolesFromData,
  type AuthorizeInput,
  type GateDefinition,
  type PolicyContext,
  type PolicyMatrixRow,
  type PolicyRule,
  type Principal,
  type Registry,
  type RegistryOptions,
  type RequireInput,
} from './registry.ts';

export {
  authorizeService,
  toHttpPolicies,
  type HttpPolicy,
  type PolicyRefLike,
  type PolicyRequestContext,
  type ToHttpOptions,
} from './http.ts';

export type { PolicyErrorCode } from './errors.ts';

export { createPolicyBootstrap } from './bootstrap.ts';
export type { PolicyBootstrap, PolicyBootstrapOptions } from './bootstrap.ts';
