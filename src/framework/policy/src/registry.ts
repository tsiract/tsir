/**
 * The registry.
 *
 * `authorize` is the one entry point, and the order of its steps is the whole design:
 *
 * 1. **No principal → deny.** `unauthenticated`. A check with nobody to check is not a pass.
 * 2. **Deny gates.** A gate declared `deny` short-circuits everything — a suspended account stays
 * suspended no matter what its roles say.
 * 3. **Allow gates.** A `superadmin` allow-all gate, checked after every deny so it cannot
 * un-suspend anybody.
 * 4. **The declared policy for `resource:action`.** This is where ownership lives
 * (`post.update` and `data.authorId === principal.subject`), and it is the only step that can
 * see the thing being acted on.
 * 5. **Role permissions.** If no policy is declared, the permission string answers.
 * 6. **Otherwise deny** — `default`, fail closed.
 *
 * The order is fixed rather than configurable, and there is deliberately **no `after` hook**: a
 * callback that can overturn a denial is how a policy bug becomes a breach. Step 3 is the only way
 * to bypass a policy, and it is a gate someone had to declare by name.
 *
 * Everything here is HTTP-free. The same `authorize` call is what a service makes before it
 * closes an invoice, which is what means by "policies callable at the service
 * boundary" — a rule that only exists inside a controller is a rule that link, jobs and RPC all
 * skip.
 */

import { type Decision, type PolicyAnswer, allow, deny, isDecision } from './decision.ts';
import { duplicatePolicy, forbidden, invalidDecision, noPrincipal } from './errors.ts';
import { joinPermission, permissionRef, type RoleGraph } from './role.ts';

/** The caller. Structurally identical to `@tsir/http`'s `Principal`, so it passes through. */
export interface Principal<P = unknown> {
  readonly subject: string;
  readonly data?: P | undefined;
}

/** What a policy sees. `data` is the row/id under discussion; everything else is identity. */
export interface PolicyContext<P = unknown> {
  readonly principal: Principal<P>;
  readonly resource: string;
  readonly action: string;
  /** `resource.action` — the same string a role grants, so a policy can read it directly. */
  readonly permission: string;
  /** The subject of the check: a post row, an id, `undefined` when there is nothing yet. */
  readonly data: unknown;
  readonly roles: readonly string[];
  /** The principal's effective permissions, resolved from the roles in hand. */
  readonly permissions: ReadonlySet<string>;
}

export type PolicyRule<P = unknown> = (
  context: PolicyContext<P>,
) => PolicyAnswer | Promise<PolicyAnswer>;

export interface GateDefinition {
  readonly name: string;
  readonly kind: 'allow' | 'deny';
  /** Return a decision to decide, or `undefined` to let the next step run. */
  check(context: PolicyContext): Decision | undefined | Promise<Decision | undefined>;
}

/** `deny` gates answer first; declaration order only orders gates of the same kind. */
export function denyGate(input: {
  readonly name: string;
  readonly check: GateDefinition['check'];
}): GateDefinition {
  return { name: input.name, kind: 'deny', check: input.check };
}

export function allowGate(input: {
  readonly name: string;
  readonly check: GateDefinition['check'];
}): GateDefinition {
  return { name: input.name, kind: 'allow', check: input.check };
}

export interface AuthorizeInput<P = unknown> {
  readonly principal: Principal<P> | undefined;
  readonly resource: string;
  readonly action: string;
  /** What the decision is about. A policy reads it; nothing else does. */
  readonly data?: unknown;
  /** Overrides the declared roles for this call — a token that carries its own scope list. */
  readonly roles?: readonly string[] | undefined;
}

/** `AuthorizeInput` for a service: `principal` is still optional, because failing must be possible. */
export type RequireInput<P = unknown> = AuthorizeInput<P>;

export interface RegistryOptions {
  readonly roles: RoleGraph;
  /**
   * `resource:action` → rule.
   *
   * A record is what a person writes. **Pairs** are what a generator produces: a codegen step
   * emitting `[ref, rule]` tuples cannot be protected by an object literal, because two entries
   * with one key collapse before the registry ever sees them. The pair form keeps the duplicate
   * long enough to be refused — `POL_DUPLICATE_POLICY` instead of a silent last-one-wins where
   * one module's ownership rule replaces another's.
   */
  readonly policies?:
    | Readonly<Record<string, PolicyRule<never>>>
    | readonly (readonly [string, PolicyRule<never>])[]
    | undefined;
  readonly gates?: readonly GateDefinition[] | undefined;
  /** Where a principal's roles come from. Default: `data.roles`, which is a string array. */
  readonly rolesOf?: ((principal: Principal<never>) => readonly string[]) | undefined;
}

export interface PolicyMatrixRow {
  readonly role: string;
  readonly permissions: readonly string[];
  readonly implies: readonly string[];
  readonly description: string | undefined;
}

export interface Registry {
  readonly roles: RoleGraph;
  /** Every `resource:action` a route may name: declared policies, then role permissions. */
  readonly refs: readonly string[];
  can(principal: Principal<unknown> | undefined, permission: string): boolean;
  authorize<P>(input: AuthorizeInput<P>): Promise<Decision>;
  /**
   * `authorize`, but **throws** instead of returning a denial.
   *
   * A controller turns a decision into a 403. A job or an RPC handler has no response to write, and
   * a decision object it forgets to check is a silent bypass — so this variant cannot be forgotten:
   * it either returns or raises (`POL_NO_PRINCIPAL`, `POL_FORBIDDEN`).
   */
  require<P>(input: RequireInput<P>): Promise<Decision>;
  /** The effective permission set of a principal, implied roles included. */
  permissionsOf(principal: Principal<unknown> | undefined): ReadonlySet<string>;
  rolesOf(principal: Principal<unknown> | undefined): readonly string[];
  matrix(): readonly PolicyMatrixRow[];
  /** Refs a route declared that nothing answers — the fail-open hole, made visible. */
  missing(refs: readonly string[]): readonly string[];
}

/** The default resolver: a principal carries its roles in `data.roles`. */
export function rolesFromData(principal: Principal<unknown>): readonly string[] {
  const data = principal.data;
  if (typeof data !== 'object' || data === null) return [];
  const roles = (data as { readonly roles?: unknown }).roles;
  if (!Array.isArray(roles)) return [];
  return roles.filter((role): role is string => typeof role === 'string');
}

export function createRegistry(options: RegistryOptions): Registry {
  const { roles } = options;
  const policies = new Map<string, PolicyRule<never>>();
  const declared = options.policies ?? {};
  const entries: readonly (readonly [string, PolicyRule<never>])[] = Array.isArray(declared)
    ? declared
    : Object.entries(declared as Readonly<Record<string, PolicyRule<never>>>);
  for (const [ref, rule] of entries) {
    // Reachable only through the pair form: a record has already collapsed duplicates by the
    // time it arrives, which is exactly the failure this catches for generated config.
    if (policies.has(ref)) throw duplicatePolicy(ref);
    policies.set(ref, rule);
  }

  const gates = options.gates ?? [];
  const denyGates = gates.filter((gate) => gate.kind === 'deny');
  const allowGates = gates.filter((gate) => gate.kind === 'allow');
  const rolesOf = options.rolesOf ?? rolesFromData;

  /** Every ref a route can name and get an answer for: declared policies, then role permissions. */
  const refs = [...new Set([...policies.keys(), ...roles.permissions.map(permissionRef)])].sort(
    (a, b) => a.localeCompare(b),
  );

  const resolveRoles = (principal: Principal<unknown> | undefined): readonly string[] => {
    if (principal === undefined) return [];
    // A role a token carries but the project no longer declares grants nothing. That is a stale
    // grant, not an error here — `policy:list` reports it at build time instead.
    // `rolesOf` is declared over `Principal<never>` so that *any* resolver — one that reads
    // `data.roles`, one that reads a column — is assignable to it. The registry has already lost the
    // data type by this point, so this is the one place the cast belongs.
    return rolesOf(principal as Principal<never>).filter((role) => roles.has(role));
  };

  const permissionsFor = (principal: Principal<unknown> | undefined): ReadonlySet<string> => {
    const effective = new Set<string>();
    for (const role of resolveRoles(principal)) {
      for (const permission of roles.permissionsOf(role)) effective.add(permission);
    }
    return effective;
  };

  const permissionsOfRoles = (declaredRoles: readonly string[]): ReadonlySet<string> => {
    const effective = new Set<string>();
    for (const role of declaredRoles) {
      if (!roles.has(role)) continue;
      for (const permission of roles.permissionsOf(role)) effective.add(permission);
    }
    return effective;
  };

  async function authorize<P>(input: AuthorizeInput<P>): Promise<Decision> {
    const permission = joinPermission(input.resource, input.action);
    if (input.principal === undefined) {
      return deny('unauthenticated', `${permission} needs an authenticated principal`);
    }

    const declaredRoles = input.roles ?? resolveRoles(input.principal);
    // Roles can be narrowed per call (a token carrying its own scopes), so the permission set is
    // resolved from the roles actually in hand, not from the ones the principal usually has.
    const permissions = permissionsOfRoles(declaredRoles);

    const context: PolicyContext = {
      principal: input.principal,
      resource: input.resource,
      action: input.action,
      permission,
      data: input.data,
      roles: declaredRoles,
      permissions,
    };

    for (const gate of denyGates) {
      const decision = await gate.check(context);
      if (decision !== undefined) return decision;
    }
    for (const gate of allowGates) {
      const decision = await gate.check(context);
      if (decision !== undefined) return decision;
    }

    const ref = `${input.resource}:${input.action}`;
    const rule = policies.get(ref);
    if (rule !== undefined) {
      // The registry stores rules as `PolicyRule<never>` — a registry cannot know every
      // notification's data type, and the cast is confined to this one call.
      const answer: unknown = await (rule as unknown as PolicyRule<unknown>)(context);
      if (!isDecision(answer)) throw invalidDecision(ref, describe(answer));
      // A user-written policy may return `{ allowed: true }` with no `source`; it is still the
      // policy's decision, and labelling it here keeps `source` total.
      const decided = answer as { allowed: boolean; reason?: string; source?: Decision['source'] };
      if (decided.allowed) return allow(decided.source ?? 'policy', decided.reason);
      return deny(decided.source ?? 'policy', decided.reason ?? `${permission} was refused`);
    }

    if (permissions.has(permission)) {
      return allow('role', `${permission} is granted by ${describeRoles(declaredRoles)}`);
    }
    return deny('default', `no policy decides ${permission}, and no role grants it`);
  }

  return {
    roles,
    refs,

    rolesOf(principal) {
      return resolveRoles(principal);
    },

    permissionsOf(principal) {
      return permissionsFor(principal);
    },

    can(principal, permission) {
      return permissionsFor(principal).has(permission);
    },

    authorize,

    async require(input) {
      const decision = await authorize(input);
      if (!decision.allowed) {
        if (decision.source === 'unauthenticated') {
          throw noPrincipal(joinPermission(input.resource, input.action));
        }
        throw forbidden(joinPermission(input.resource, input.action), decision.reason);
      }
      return decision;
    },

    matrix() {
      return roles.roles.map((role) => ({
        role: role.name,
        permissions: [...roles.permissionsOf(role.name)],
        implies: role.implies,
        description: role.description,
      }));
    },

    missing(refList) {
      const known = new Set(refs);
      return [...new Set(refList.filter((ref) => !known.has(ref)))].sort((a, b) =>
        a.localeCompare(b),
      );
    },
  };
}

function describe(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === undefined) return 'undefined';
  return typeof value;
}

function describeRoles(roles: readonly string[]): string {
  return roles.length === 0 ? 'no role' : roles.join(', ');
}
