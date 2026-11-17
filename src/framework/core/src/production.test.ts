/**
 * `isProduction` (`CAP-007`).
 *
 * The guards in cache, queue, mail, storage, broadcast, search and media all key on
 * `options.production`. Until something passed it, every one of them was unreachable — so the
 * cases that matter here are not "does it read a string" but "which strings count".
 */
import { describe, expect, test } from 'bun:test';

import { environmentName, isProduction, PRODUCTION_ENVIRONMENTS } from './production.ts';

describe('isProduction', () => {
  test('APP_ENV=production is production', () => {
    expect(isProduction({ APP_ENV: 'production' })).toBe(true);
  });

  test('staging gets the same guards, because a lost write there is found earlier', () => {
    expect(isProduction({ APP_ENV: 'staging' })).toBe(true);
  });

  test('case and surrounding space do not change the answer', () => {
    // A deployer writing `Production` or a `.env` with a trailing space must not quietly disable
    // every refusal in the process.
    expect(isProduction({ APP_ENV: ' Production ' })).toBe(true);
    expect(isProduction({ APP_ENV: 'STAGING' })).toBe(true);
  });

  test('development, test and an unset APP_ENV are not production', () => {
    // Unset is the arguable one: a real deployment missing `APP_ENV` disables the guards. The
    // alternative — assume production — breaks every test and every command, which is how a guard
    // grows an escape hatch. `tsir deploy:build` writes it into the target instead.
    expect(isProduction({ APP_ENV: 'development' })).toBe(false);
    expect(isProduction({ APP_ENV: 'test' })).toBe(false);
    expect(isProduction({})).toBe(false);
  });

  test('APP_MODE is the older spelling and is still read', () => {
    expect(isProduction({ APP_MODE: 'production' })).toBe(true);
    // APP_ENV wins when both are present: it is the one the deployer writes.
    expect(isProduction({ APP_ENV: 'development', APP_MODE: 'production' })).toBe(false);
  });

  test('a near-miss is not production', () => {
    // `prod` and `production-eu` are environment *names*, not values this function invented. A
    // prefix match would have made `prod` work and `production-eu` silently not — two spellings
    // that disagree in the dangerous direction.
    expect(isProduction({ APP_ENV: 'prod' })).toBe(false);
    expect(isProduction({ APP_ENV: 'production-eu' })).toBe(false);
    expect(PRODUCTION_ENVIRONMENTS).toEqual(['production', 'staging']);
  });

  test('environmentName reports what was read, for a boot report', () => {
    expect(environmentName({ APP_ENV: 'Staging' })).toBe('staging');
    expect(environmentName({})).toBe('');
  });
});
