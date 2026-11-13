/**
 * The production-wiring gate (`CAP-007`).
 *
 * The gate's own failure mode is the interesting one: a check that reports a call as wired when it
 * is not is worse than no check, because it certifies the thing it was supposed to catch. These
 * cases are the shapes that would fool a regex — a nested call, a comment mentioning the flag, and
 * a declaration rather than a call.
 */
import { describe, expect, test } from 'bun:test';

import { findUnwiredBootstraps, PRODUCTION_AWARE_BOOTSTRAPS } from './check-production-wiring.ts';

describe('production wiring', () => {
  test('a call without the flag is reported', () => {
    const gaps = findUnwiredBootstraps(
      'app/services/cache.ts',
      "import { createCacheBootstrap } from '@tsir/cache';\ncreateCacheBootstrap({ cache: cfg });",
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.call).toBe('createCacheBootstrap');
    expect(gaps[0]?.line).toBe(2);
  });

  test('a call with the flag passes', () => {
    expect(
      findUnwiredBootstraps(
        'app/services/cache.ts',
        'createCacheBootstrap({ cache: cfg, production: isProduction() });',
      ),
    ).toEqual([]);
  });

  test('a nested call does not truncate the argument text', () => {
    // The regex version of this check stopped at the first `)`, so `production` inside a nested
    // call — or after one — looked absent. `callText` walks the parentheses.
    expect(
      findUnwiredBootstraps(
        'app/services/cache.ts',
        'createCacheBootstrap({ cache: cfg, bindings: { databases: { primary: db() } }, production: isProduction() });',
      ),
    ).toEqual([]);
  });

  test('a flag mentioned only in a comment does not count', () => {
    // Deliberately strict: `production` in a comment is not a flag the guard reads. The false
    // positive is the safe direction here — a person reads it and deletes the comment.
    const gaps = findUnwiredBootstraps(
      'app/services/cache.ts',
      'createCacheBootstrap({ cache: cfg /* production: later */ });',
    );
    expect(gaps).toHaveLength(1);
  });

  test('a declaration is not a call site', () => {
    expect(
      findUnwiredBootstraps(
        'pkg/src/bootstrap.ts',
        'export function createStorageBootstrap(options) {\n  return options;\n}',
      ),
    ).toEqual([]);
  });

  test('every bootstrap the gate knows about is a real one', () => {
    // A typo in the list means a bootstrap is never checked. The expected names are written out
    // rather than derived, so the list cannot quietly lose one.
    expect([...PRODUCTION_AWARE_BOOTSTRAPS].sort()).toEqual([
      'createBroadcastBootstrap',
      'createCacheBootstrap',
      'createMailBootstrap',
      'createMediaBootstrap',
      'createNotifyBootstrap',
      'createQueueBootstrap',
      'createScoutBootstrap',
      'createStorageBootstrap',
    ]);
  });
});
