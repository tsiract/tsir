import { describe, expect, test } from 'bun:test';

import { isDefaultMigrationFolder, migrationFolder } from './paths.ts';

describe('one journal folder per connection (MIG-015)', () => {
  test('the default connection keeps the unqualified path', () => {
    expect(migrationFolder('/app', 'app', { defaultConnection: 'app' })).toBe('/app/migrations');
    expect(isDefaultMigrationFolder('app', { defaultConnection: 'app' })).toBe(true);
  });

  test('every other connection gets a subfolder named after itself', () => {
    expect(migrationFolder('/app', 'reporting', { defaultConnection: 'app' })).toBe(
      '/app/migrations/reporting',
    );
    expect(isDefaultMigrationFolder('reporting', { defaultConnection: 'app' })).toBe(false);
  });

  test('`paths.migrations` moves the base, not the rule', () => {
    expect(
      migrationFolder('/app', 'reporting', { base: 'db/migrations', defaultConnection: 'app' }),
    ).toBe('/app/db/migrations/reporting');
    expect(
      migrationFolder('/app', 'app', { base: 'db/migrations', defaultConnection: 'app' }),
    ).toBe('/app/db/migrations');
  });

  test('without a registry the default name is `default`', () => {
    expect(migrationFolder('/app', 'default')).toBe('/app/migrations');
    expect(migrationFolder('/app', 'reporting')).toBe('/app/migrations/reporting');
  });
});
