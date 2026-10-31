/** `tsir make:migration` lint rules (DB-012). Each rule is cheap and each one has a reason. */

import { describe, expect, test } from 'bun:test';

import { lintMigration } from './db.ts';

describe('lintMigration', () => {
  test('a clean migration with a trailing newline has no problems', () => {
    expect(lintMigration('create table t (id int);\n', '0001_t')).toEqual([]);
  });

  test('an empty file is reported, because it is a diff that did not happen', () => {
    expect(lintMigration('   \n', '0002_empty')).toEqual([
      '0002_empty: the generated file is empty',
    ]);
  });

  test('a missing final newline is reported, because it breaks every later diff', () => {
    expect(lintMigration('alter table t add column c int;', '0003_nl')).toEqual([
      '0003_nl: file does not end with a newline',
    ]);
  });

  test('two transaction headers are reported, but one is fine', () => {
    const header = '-- tsir:transaction=none\n';
    expect(lintMigration(`${header}select 1;\n`, 'one')).toEqual([]);
    expect(lintMigration(`${header}${header}select 1;\n`, 'two')).toEqual([
      'two: more than one tsir:transaction header',
    ]);
  });
});
