import { describe, expect, test } from 'bun:test';

import {
  assertPermission,
  createRoleGraph,
  defineRole,
  joinPermission,
  PERMISSION_PATTERN,
  permissionRef,
  splitPermission,
} from './role.ts';

describe('permissions', () => {
  test('a permission splits at the last dot, so a resource may be dotted', () => {
    expect(splitPermission('post.update')).toEqual({ resource: 'post', action: 'update' });
    expect(splitPermission('posts.comments.update')).toEqual({
      resource: 'posts.comments',
      action: 'update',
    });
    expect(joinPermission('post', 'update')).toBe('post.update');
    expect(permissionRef('posts.comments.update')).toBe('posts.comments:update');
  });

  test('a malformed permission is refused where it is written', () => {
    expect(() => splitPermission('update')).toThrow(/is not a permission/u);
    expect(() => splitPermission('.update')).toThrow(/is not a permission/u);
    expect(() => splitPermission('post.')).toThrow(/is not a permission/u);

    expect(assertPermission('invoice.void')).toBe('invoice.void');
    expect(() => assertPermission('Invoice.Void')).toThrow(/permissions are lowercase/u);
    expect(() => assertPermission('invoice_void')).toThrow(/not lowercase/u);
    expect(() => assertPermission('invoice..void')).toThrow(/is not a permission/u);
    // The pattern is exported because a project's own tooling wants the same rule.
    expect(PERMISSION_PATTERN.test('post.update')).toBe(true);
    expect(PERMISSION_PATTERN.test('Post.update')).toBe(false);
  });
});

describe('roles', () => {
  test('a role holds its own permissions and the ones it implies', () => {
    const graph = createRoleGraph([
      defineRole({ name: 'author', permissions: ['post.create'] }),
      defineRole({ name: 'editor', implies: ['author'], permissions: ['post.update'] }),
      defineRole({ name: 'admin', implies: ['editor'], permissions: ['post.delete'] }),
    ]);

    expect(graph.names).toEqual(['admin', 'author', 'editor']);
    expect([...graph.permissionsOf('author')]).toEqual(['post.create']);
    expect([...graph.permissionsOf('editor')]).toEqual(['post.create', 'post.update']);
    expect([...graph.permissionsOf('admin')]).toEqual([
      'post.create',
      'post.delete',
      'post.update',
    ]);
    // The union, sorted: what `policy:list` prints as the project's permission table.
    expect(graph.permissions).toEqual(['post.create', 'post.delete', 'post.update']);
  });

  test('diamond implication counts each permission once', () => {
    const graph = createRoleGraph([
      defineRole({ name: 'base', permissions: ['post.read'] }),
      defineRole({ name: 'left', implies: ['base'], permissions: ['post.create'] }),
      defineRole({ name: 'right', implies: ['base'], permissions: ['post.update'] }),
      defineRole({ name: 'both', implies: ['left', 'right'] }),
    ]);
    expect([...graph.permissionsOf('both')]).toEqual(['post.create', 'post.read', 'post.update']);
  });

  test('a cycle is refused at declaration, with the path that closes it', () => {
    const graph = [
      defineRole({ name: 'a', implies: ['b'] }),
      defineRole({ name: 'b', implies: ['c'] }),
      defineRole({ name: 'c', implies: ['a'] }),
    ];
    expect(() => createRoleGraph(graph)).toThrow(/role implications form a cycle: a → b → c → a/u);
  });

  test('a role that implies a role nobody declares is refused, not silently empty', () => {
    expect(() => createRoleGraph([defineRole({ name: 'editor', implies: ['author'] })])).toThrow(
      /unknown role "author"/u,
    );
  });

  test('duplicate role names are refused: one name, one permission set', () => {
    expect(() =>
      createRoleGraph([defineRole({ name: 'admin' }), defineRole({ name: 'admin' })]),
    ).toThrow(/two roles are both named "admin"/u);
  });

  test('a role name and its permissions are validated at definition', () => {
    expect(() => defineRole({ name: 'Admin' })).toThrow(/is not a role name/u);
    expect(() => defineRole({ name: 'admin', permissions: ['Post.update'] })).toThrow(
      /is not a permission/u,
    );
    expect(() => defineRole({ name: 'admin', implies: ['Bad Role'] })).toThrow(
      /is not a role name/u,
    );
  });

  test('the effective set cannot be mutated through the graph', () => {
    const graph = createRoleGraph([defineRole({ name: 'admin', permissions: ['post.delete'] })]);
    const permissions = graph.permissionsOf('admin') as Set<string>;
    permissions.add('billing.void');
    expect([...graph.permissionsOf('admin')]).toEqual(['post.delete']);
    expect(graph.has('nobody')).toBe(false);
    expect(() => graph.permissionsOf('nobody')).toThrow(/unknown role "nobody"/u);
  });
});
