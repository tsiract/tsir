import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { checkModuleSpecifier, moduleOf } from './check-modules.ts';

/** `src/apps/shop` — a shape no test file has to exist for. */
const APP = '/repo/src/apps/shop';
const MODULES = ['users', 'invoices'] as const;

function context(file: string): {
  file: string;
  appRoot: string;
  moduleNames: readonly string[];
} {
  return { file: join(APP, 'modules', file), appRoot: APP, moduleNames: MODULES };
}

describe('checkModuleSpecifier', () => {
  test('allows a module importing another module through its entry', () => {
    expect(
      checkModuleSpecifier('../invoices/index.ts', context('users/service.ts')),
    ).toBeUndefined();
    expect(checkModuleSpecifier('../invoices', context('users/service.ts'))).toBeUndefined();
  });

  test('rejects a module importing another module’s internals', () => {
    const violation = checkModuleSpecifier(
      '../invoices/repository.ts',
      context('users/service.ts'),
    );
    expect(violation?.rule).toBe('cross-module-internal');
    expect(violation?.importer).toBe('users');
    expect(violation?.detail).toContain('../invoices/index.ts');
  });

  test('rejects reaching into a nested internals path', () => {
    const violation = checkModuleSpecifier(
      '../invoices/internal/totals.ts',
      context('users/service.ts'),
    );
    expect(violation?.rule).toBe('cross-module-internal');
  });

  test('allows a module importing its own files with ./', () => {
    expect(checkModuleSpecifier('./repository.ts', context('users/service.ts'))).toBeUndefined();
  });

  test('rejects a module re-entering itself through ..', () => {
    const violation = checkModuleSpecifier(
      '../users/../users/repository.ts',
      context('users/http/controller.ts'),
    );
    expect(violation?.rule).toBe('self-import');
  });

  test('rejects shared/ importing a module', () => {
    const violation = checkModuleSpecifier('../modules/users/index.ts', {
      file: join(APP, 'shared', 'money.ts'),
      appRoot: APP,
      moduleNames: MODULES,
    });
    expect(violation?.rule).toBe('shared-depends-on-module');
    expect(violation?.detail).toContain('"users"');
  });

  test('allows shared/ importing shared/', () => {
    expect(
      checkModuleSpecifier('./money.ts', {
        file: join(APP, 'shared', 'pricing.ts'),
        appRoot: APP,
        moduleNames: MODULES,
      }),
    ).toBeUndefined();
  });

  test('ignores bare package specifiers and framework imports', () => {
    expect(checkModuleSpecifier('@tsir/http', context('users/service.ts'))).toBeUndefined();
    expect(checkModuleSpecifier('drizzle-orm', context('users/service.ts'))).toBeUndefined();
  });

  test('ignores paths that leave the application', () => {
    expect(
      checkModuleSpecifier('../../shared/money.ts', context('users/service.ts')),
    ).toBeUndefined();
  });
});

describe('moduleOf', () => {
  test('splits a module path into name and remainder', () => {
    expect(moduleOf(`${APP}/modules/users/http/controller.ts`, APP, MODULES)).toEqual({
      name: 'users',
      rest: 'http/controller.ts',
    });
  });

  test('returns undefined outside modules/', () => {
    expect(moduleOf(`${APP}/shared/money.ts`, APP, MODULES)).toBeUndefined();
  });

  test('works for a directory entry with no remainder', () => {
    expect(moduleOf(`${APP}/modules/users`, APP, MODULES)).toEqual({ name: 'users', rest: '' });
  });

  test('returns undefined for an unknown module name', () => {
    expect(moduleOf(`${APP}/modules/billing/service.ts`, APP, MODULES)).toBeUndefined();
  });
});
