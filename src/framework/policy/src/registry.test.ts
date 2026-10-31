import { describe, expect, test } from 'bun:test';

import { allow, deny } from './decision.ts';
import { allowGate, createRegistry, denyGate } from './registry.ts';
import { authorizeService, toHttpPolicies } from './http.ts';
import { createRoleGraph, defineRole } from './role.ts';

interface User {
  readonly roles: readonly string[];
  readonly suspended?: boolean;
}

const roles = createRoleGraph([
  defineRole({ name: 'author', permissions: ['post.create', 'post.update'] }),
  defineRole({ name: 'editor', implies: ['author'], permissions: ['post.publish'] }),
  defineRole({ name: 'admin', implies: ['editor'], permissions: ['post.delete'] }),
]);

interface Post {
  readonly id: string;
  readonly authorId: string;
}

const post: Post = { id: 'p1', authorId: 'u1' };

const registry = createRegistry({
  roles,
  policies: {
    // Ownership: the only rule that needs the row.
    'post:update': ({ principal, data }) =>
      (data as Post | undefined)?.authorId === principal.subject
        ? allow('policy')
        : deny('policy', 'only the author may edit this post'),
  },
  gates: [
    {
      name: 'suspended',
      kind: 'deny',
      check: ({ principal }) =>
        (principal.data as User | undefined)?.suspended === true
          ? deny('gate', 'this account is suspended')
          : undefined,
    },
    {
      name: 'root',
      kind: 'allow',
      check: ({ principal }) =>
        principal.subject === 'root' ? allow('gate', 'the root account') : undefined,
    },
  ],
});

const author = { subject: 'u1', data: { roles: ['author'] } };
const other = { subject: 'u2', data: { roles: ['author'] } };
const admin = { subject: 'u3', data: { roles: ['admin'] } };

describe('authorize', () => {
  test('no principal is a denial, not a pass', async () => {
    const decision = await registry.authorize({
      principal: undefined,
      resource: 'post',
      action: 'create',
    });
    expect(decision).toEqual({
      allowed: false,
      source: 'unauthenticated',
      reason: 'post.create needs an authenticated principal',
    });
  });

  test('a declared policy decides, and it is the only step that sees the row', async () => {
    const mine = await registry.authorize({
      principal: author,
      resource: 'post',
      action: 'update',
      data: post,
    });
    expect(mine).toMatchObject({ allowed: true, source: 'policy' });

    const theirs = await registry.authorize({
      principal: other,
      resource: 'post',
      action: 'update',
      data: post,
    });
    expect(theirs).toMatchObject({
      allowed: false,
      source: 'policy',
      reason: 'only the author may edit this post',
    });
  });

  test('with no policy declared, the role answers — and implied roles count', async () => {
    const direct = await registry.authorize({
      principal: author,
      resource: 'post',
      action: 'create',
    });
    expect(direct).toMatchObject({ allowed: true, source: 'role' });

    const implied = await registry.authorize({
      principal: admin,
      resource: 'post',
      action: 'publish',
    });
    expect(implied).toMatchObject({ allowed: true, source: 'role' });
  });

  test('nothing grants it: denied by default, and the reason says so', async () => {
    const decision = await registry.authorize({
      principal: author,
      resource: 'post',
      action: 'delete',
    });
    expect(decision).toEqual({
      allowed: false,
      source: 'default',
      reason: 'no policy decides post.delete, and no role grants it',
    });
  });

  test('a deny gate wins over every role, including admin', async () => {
    const suspended = {
      subject: 'u4',
      data: { roles: ['admin'], suspended: true },
    };
    const decision = await registry.authorize({
      principal: suspended,
      resource: 'post',
      action: 'delete',
    });
    expect(decision).toMatchObject({ allowed: false, source: 'gate' });
  });

  test('a deny gate wins over an allow gate, whatever order they were declared in', async () => {
    const both = createRegistry({
      roles,
      gates: [
        { name: 'root', kind: 'allow', check: () => allow('gate', 'root') },
        { name: 'suspended', kind: 'deny', check: () => deny('gate', 'suspended') },
      ],
    });
    const decision = await both.authorize({
      principal: admin,
      resource: 'post',
      action: 'delete',
    });
    // The allow gate was declared first and still loses: a denial cannot be un-denied by ordering.
    expect(decision).toMatchObject({ allowed: false, source: 'gate', reason: 'suspended' });
  });

  test('the gate factories spell the kind, so a gate cannot be miscategorised by a typo', async () => {
    const written = createRegistry({
      roles,
      // Declared allow-first on purpose: `denyGate`/`allowGate` must carry the same precedence the
      // literal objects do, or the whole point of naming the kind is lost.
      gates: [
        allowGate({
          name: 'root',
          check: ({ principal }) =>
            principal.subject === 'root' ? allow('gate', 'the root account') : undefined,
        }),
        denyGate({
          name: 'suspended',
          check: ({ principal }) =>
            (principal.data as User | undefined)?.suspended === true
              ? deny('gate', 'this account is suspended')
              : undefined,
        }),
      ],
    });
    // An admin, suspended, and matching the allow gate's subject: deny still wins.
    const locked = { subject: 'root', data: { roles: ['admin'], suspended: true } };
    expect(
      await written.authorize({ principal: locked, resource: 'post', action: 'delete' }),
    ).toMatchObject({ allowed: false, source: 'gate', reason: 'this account is suspended' });

    // Nobody suspended, but the root account: now the allow gate is the one that answers.
    const root = { subject: 'root', data: { roles: [] } };
    expect(
      await written.authorize({ principal: root, resource: 'post', action: 'delete' }),
    ).toMatchObject({ allowed: true, source: 'gate', reason: 'the root account' });

    // An ordinary account trips neither gate, so the role graph still decides.
    expect(
      await written.authorize({ principal: author, resource: 'post', action: 'create' }),
    ).toMatchObject({ allowed: true, source: 'role' });
  });

  test('a gate that declines to answer lets the next step decide, sync or async', async () => {
    const chained = createRegistry({
      roles,
      policies: { 'post:update': () => deny('policy', 'the policy has the last word') },
      gates: [
        denyGate({ name: 'sync-passes', check: () => undefined }),
        allowGate({ name: 'async-passes', check: async () => undefined }),
      ],
    });
    const decision = await chained.authorize({
      principal: author,
      resource: 'post',
      action: 'update',
    });
    // Two abstentions are not a pass: the policy still runs, and its denial still stands.
    expect(decision).toMatchObject({ allowed: false, source: 'policy' });
  });

  test('a policy answering a non-decision is named by type, not printed as [object Object]', async () => {
    const answer = async (value: unknown): Promise<string> => {
      const broken = createRegistry({
        roles,
        policies: { 'post:update': (() => value) as never },
      });
      try {
        await broken.authorize({ principal: author, resource: 'post', action: 'update' });
        return 'no error';
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(await answer('yes')).toContain('answered "yes"');
    expect(await answer(42)).toContain('answered 42');
    expect(await answer(false)).toContain('answered false');
    expect(await answer(undefined)).toContain('answered undefined');
    // A half-built decision is the likely mistake, and "object" is the honest name for it.
    expect(await answer({ allowed: 'yes' })).toContain('answered object');
  });

  test('per-call roles narrow the principal, and never widen it', async () => {
    const narrowed = await registry.authorize({
      principal: admin,
      resource: 'post',
      action: 'delete',
      roles: ['author'],
    });
    expect(narrowed).toMatchObject({ allowed: false, source: 'default' });

    const stale = await registry.authorize({
      principal: admin,
      resource: 'post',
      action: 'delete',
      roles: ['ghost'],
    });
    expect(stale).toMatchObject({ allowed: false, source: 'default' });
  });

  test('a policy that answers something that is not a decision is an error, not a pass', async () => {
    const broken = createRegistry({
      roles,
      policies: { 'post:update': (() => 'yes') as never },
    });
    expect(
      broken.authorize({ principal: author, resource: 'post', action: 'update' }),
    ).rejects.toThrow(/answered "yes", which is not a decision/u);
  });

  test('a policy may answer the bare http shape, and it is labelled as the policy', async () => {
    const bare = createRegistry({
      roles,
      policies: { 'post:update': () => ({ allowed: true }) },
    });
    const decision = await bare.authorize({
      principal: author,
      resource: 'post',
      action: 'update',
    });
    expect(decision).toMatchObject({ allowed: true, source: 'policy' });
  });
});

describe('require, for a service or a job', () => {
  test('it returns the decision when allowed, and throws when not', async () => {
    const allowed = await registry.require({
      principal: author,
      resource: 'post',
      action: 'create',
    });
    expect(allowed.allowed).toBe(true);

    expect(
      registry.require({ principal: author, resource: 'post', action: 'delete' }),
    ).rejects.toThrow(/POL_FORBIDDEN|was refused/u);

    expect(
      registry.require({ principal: undefined, resource: 'post', action: 'create' }),
    ).rejects.toThrow(/checked with no principal/u);
  });
});

describe('the registry as data', () => {
  test('refs are the policies plus every permission a role grants', () => {
    expect(registry.refs).toEqual(['post:create', 'post:delete', 'post:publish', 'post:update']);
  });

  test('`missing` names the refs nothing answers — the hole a route would fall through', () => {
    expect(registry.missing(['post:update', 'invoice:void', 'post:create'])).toEqual([
      'invoice:void',
    ]);
    expect(registry.missing([])).toEqual([]);
  });

  test('`missing` reports each hole once, sorted, whatever order the routes asked in', () => {
    // A route file that declares the same ref twice should not produce two identical warnings.
    expect(
      registry.missing(['warehouse:close', 'audit:read', 'warehouse:close', 'post:update']),
    ).toEqual(['audit:read', 'warehouse:close']);
  });

  test('the matrix is one row per role, with effective permissions', () => {
    // Declaration order, because a table that reorders itself is a table nobody scans twice.
    expect(registry.matrix()).toEqual([
      {
        role: 'author',
        permissions: ['post.create', 'post.update'],
        implies: [],
        description: undefined,
      },
      {
        role: 'editor',
        permissions: ['post.create', 'post.publish', 'post.update'],
        implies: ['author'],
        description: undefined,
      },
      {
        role: 'admin',
        permissions: ['post.create', 'post.delete', 'post.publish', 'post.update'],
        implies: ['editor'],
        description: undefined,
      },
    ]);
  });

  test('`can` is the cheap check, and it never resolves a policy', () => {
    expect(registry.can(author, 'post.update')).toBe(true);
    expect(registry.can(author, 'post.delete')).toBe(false);
    expect(registry.can(undefined, 'post.update')).toBe(false);
    expect([...registry.permissionsOf(admin)]).toEqual([
      'post.create',
      'post.delete',
      'post.publish',
      'post.update',
    ]);
    expect(registry.rolesOf(admin)).toEqual(['admin']);
  });

  test('a custom role resolver is how a project reads roles from a token or a column', async () => {
    const fromToken = createRegistry({
      roles,
      rolesOf: (principal) => {
        const data: unknown = (principal as { data?: unknown }).data;
        return typeof data === 'string' ? data.split(' ') : [];
      },
    });
    const decision = await fromToken.authorize({
      principal: { subject: 'u5', data: 'editor author' },
      resource: 'post',
      action: 'publish',
    });
    expect(decision).toMatchObject({ allowed: true, source: 'role' });
  });

  test('policies may be given as pairs, so generated config does not have to build a record', async () => {
    const pairs = createRegistry({
      roles,
      policies: [['post:update', () => allow('policy')] as const],
    });
    expect(pairs.refs).toContain('post:update');
    expect(
      await pairs.authorize({ principal: author, resource: 'post', action: 'update' }),
    ).toMatchObject({ allowed: true, source: 'policy' });
  });

  test('two policies for one ref are refused, naming the ref', () => {
    // A record literal cannot hold a duplicate key — it collapses to one entry before the registry
    // sees it, so `{ a, a }` is a silent last-one-wins, not an error. The pair form is the shape a
    // generator emits, and there the duplicate survives long enough to be refused.
    const message = (() => {
      try {
        createRegistry({
          roles,
          policies: [
            ['post:update', () => deny('policy', 'first')],
            ['post:update', () => allow('policy')],
          ] as const,
        });
        return 'no error';
      } catch (error) {
        return (error as { code?: string }).code ?? (error as Error).message;
      }
    })();
    expect(message).toBe('POL_DUPLICATE_POLICY');
  });
});

describe('authorizeService, for code with no request to guard', () => {
  test('it answers the same decision the registry would, for a job or a handler', async () => {
    expect(
      await authorizeService(registry, {
        principal: author,
        resource: 'post',
        action: 'update',
        data: post,
      }),
    ).toMatchObject({ allowed: true, source: 'policy' });

    expect(
      await authorizeService(registry, { principal: author, resource: 'post', action: 'publish' }),
    ).toMatchObject({ allowed: false, source: 'default' });

    // No principal is a denial here too: a job that forgets to pass one fails closed.
    expect(
      await authorizeService(registry, {
        principal: undefined,
        resource: 'post',
        action: 'publish',
      }),
    ).toMatchObject({ allowed: false, source: 'unauthenticated' });
  });
});

describe('the HTTP adapter', () => {
  test('every ref the roles know becomes a policy, so http stops skipping it', async () => {
    const policies = toHttpPolicies(registry, { data: (ctx) => ctx.state.get('post') });
    expect(Object.keys(policies).sort()).toEqual([...registry.refs]);

    const context = {
      principal: author,
      url: new URL('https://tsir.local/posts/p1'),
      state: new Map<string, unknown>([['post', post]]),
    };

    const mine = await policies['post:update']?.(context, { resource: 'post', action: 'update' });
    expect(mine).toMatchObject({ allowed: true, source: 'policy' });

    const create = await policies['post:create']?.(context, { resource: 'post', action: 'create' });
    expect(create).toMatchObject({ allowed: true, source: 'role' });
  });
});
