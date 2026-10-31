/**
 * Type-level tests for `@tsir/policy` (`TST-009`).
 *
 * These lines are compiled, not executed, and a `@ts-expect-error` that stops failing is itself a
 * compile error — so the guarantees below cannot rot quietly.
 *
 * The three this package promises:
 *
 * 1. a **decision** is either `allowed: true` or a denial **with a reason**, so a 403 can never be
 * written without one;
 * 2. a **policy** receives the principal's own data type, and may return the full `Decision` or the
 * bare `{ allowed }` an `@tsir/http` policy writes;
 * 3. `authorize` fails closed when there is no principal — `undefined` is an accepted input, and it
 * is **not** accepted as an authenticated one.
 */

import {
  allow,
  createRegistry,
  createRoleGraph,
  defineRole,
  deny,
  denyGate,
  isDecision,
  type Decision,
  type PolicyAnswer,
  type PolicyContext,
  type PolicyRule,
  type Principal,
  type Registry,
} from '../src/index.ts';

// ── 1. a denial carries a reason; an allowance does not have to ─────────────

const allowed: Decision = allow('policy');
const denied: Decision = deny('policy', 'only the author may edit this post');

// @ts-expect-error — a denial without a reason cannot be written
const reasonless: Decision = { allowed: false, source: 'policy' };
void reasonless;

// `allow` from `@tsir/decision` shape: `source` is required on a `Decision`.
const sourcedOnly: Decision = { allowed: true, source: 'role' };
void sourcedOnly;

// @ts-expect-error — a bare boolean is not a decision
const notADecision: Decision = { allowed: 'yes', source: 'role' };
void notADecision;

void allowed;
void denied;

// `isDecision` narrows, so a policy's answer can be read without a cast.
declare const answer: unknown;
if (isDecision(answer)) {
  const value: boolean = answer.allowed;
  void value;
}

// ── 2. a policy sees the principal's data type ─────────────────────────────

interface User {
  readonly roles: readonly string[];
  readonly plan: 'free' | 'pro';
}

interface Post {
  readonly id: string;
  readonly authorId: string;
}

const updatePost: PolicyRule<User> = (context: PolicyContext<User>): PolicyAnswer => {
  const post = context.data as Post | undefined;
  if (post?.authorId === context.principal.subject) return { allowed: true };
  return deny('policy', 'not the author');
};

createRegistry({
  roles: createRoleGraph([defineRole({ name: 'author', permissions: ['post.update'] })]),
  policies: { 'post:update': updatePost },
});

// Policies may also be a list of pairs — the shape a generator emits, where a duplicate key has
// not already been collapsed. Both forms accept the same rule.
createRegistry({
  roles: createRoleGraph([defineRole({ name: 'author', permissions: ['post.update'] })]),
  policies: [['post:update', updatePost]],
});

createRegistry({
  roles: createRoleGraph([defineRole({ name: 'author', permissions: ['post.update'] })]),
  // @ts-expect-error — a pair's second element is a rule, not a finished decision
  policies: [['post:update', allow('policy')]],
});

// The principal's `data` is typed, and it is *optional* — a principal may carry no data at all.
const planPolicy: PolicyRule<User> = (context) => {
  const plan: 'free' | 'pro' = context.principal.data?.plan ?? 'free';
  return plan === 'pro' ? allow('policy') : deny('policy', 'the free plan cannot publish');
};
void planPolicy;

// @ts-expect-error — `freee` is not one of the plans a `User` can have
const invalidPlan: User['plan'] = 'freee';
void invalidPlan;

declare const registry: Registry;

// The data type flows into the call, and out of `authorize`.
const decided: Promise<Decision> = registry.authorize<User>({
  principal: { subject: 'user_1', data: { roles: ['author'], plan: 'pro' } },
  resource: 'post',
  action: 'update',
  data: { id: 'post_1', authorId: 'user_1' } satisfies Post,
});
void decided;

const wrongPlan: Principal<User> = {
  subject: 'user_1',
  // @ts-expect-error — `plan: 'enterprise'` is not a `User`
  data: { roles: ['author'], plan: 'enterprise' },
};
void wrongPlan;

// ── 3. failing closed is expressible ───────────────────────────────────────

// No principal is a legal call — the answer is a denial, not a crash and not a compile error.
void registry.authorize({ principal: undefined, resource: 'post', action: 'update' });

// @ts-expect-error — `resource` and `action` are how a ref is named; neither may be dropped
void registry.authorize({ principal: { subject: 'user_1' }, resource: 'post' });

// A gate's `check` may decide or abstain.
const gate = denyGate({
  name: 'suspended',
  check: (context) =>
    context.principal.subject === 'banned' ? deny('gate', 'suspended') : undefined,
});
void gate;

// @ts-expect-error — a gate `kind` is fixed by the helper, not by the caller
void denyGate({ name: 'x', kind: 'allow', check: () => undefined });

// `can` and `permissionsOf` are synchronous: they answer from the role graph, not a store.
declare const principal: Principal<unknown> | undefined;
const canPublish: boolean = registry.can(principal, 'post.publish');
const granted: ReadonlySet<string> = registry.permissionsOf(principal);
void canPublish;
void granted;

// @ts-expect-error — `authorize` is async, so its result is not a `Decision`
const notDecided: Decision = registry.authorize({ principal, resource: 'post', action: 'update' });
void notDecided;
