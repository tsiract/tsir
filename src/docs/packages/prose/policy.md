## Example

Describe the roles, then write a rule for the actions that need one. The registry answers whether a
principal may do something. The same answer is used by a route, a job and a service.

```ts
import { allow, createRegistry, createRoleGraph, defineRole, deny } from '@tsir/policy';

interface Post {
  authorId: string;
}

const roles = createRoleGraph([
  defineRole({ name: 'author', permissions: ['post.create', 'post.update'] }),
]);

const registry = createRegistry({
  roles,
  policies: {
    'post:update': ({ principal, data }) =>
      (data as Post | undefined)?.authorId === principal.subject
        ? allow('policy')
        : deny('policy', 'only the author may edit this post'),
  },
});

const decision = await registry.authorize({
  principal: { subject: 'u1' },
  resource: 'post',
  action: 'update',
  data: { authorId: 'u2' } satisfies Post,
});

console.log(decision.allowed, decision.reason);
```

## Failure modes

- `POL_INVALID_PERMISSION`: a permission is not `<resource>.<action>` in lowercase. The same string is
  a route's policy reference, so it must be valid everywhere.
- `POL_INVALID_ROLE`: a role name is not lowercase with dots or dashes.
- `POL_DUPLICATE_ROLE`: two roles have the same name. A duplicate would merge two permission sets
  without a sign.
- `POL_UNKNOWN_ROLE`: a role was named that is not declared.
- `POL_ROLE_CYCLE`: role implications form a cycle. A cycle has no effective permission set, so
  nothing can be checked against it.
- `POL_DUPLICATE_POLICY`: two policies are registered for one `resource:action`.
- `POL_INVALID_DECISION`: a policy returned something other than a decision. Anything other than
  `{ allowed: true }` or `{ allowed: false, reason }` fails closed.
- `POL_NO_PRINCIPAL`: a permission was checked with no principal. An unauthenticated caller has no
  permissions.
- `POL_FORBIDDEN`: the rule refused the action. At a service boundary this is the form of a 403.

## Security notes

When no rule is declared for an action, the role permissions decide, and if no role grants it the
answer is a denial. A rule that returns anything other than a decision also denies. Authorization happens on the server for each action, and
the principal is built by authentication, not by the caller. Keep rules in code, so every decision can
be read where it is made, and test the deny path of each rule as well as the allow path.
