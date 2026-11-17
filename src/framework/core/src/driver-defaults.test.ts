/**
 * The per-target default table, held to the two rules that make it worth having.
 *
 *   1. **No stateless target defaults to an ephemeral driver.** Workers and Lambda both stop the
 *      isolate between requests. `memory` there is not a smaller cache — it is a store whose
 *      contents depend on which isolate took the write. This test is the guard, because the table
 *      is hand-written data and a future row could quietly be wrong.
 *   2. **Every default names a driver its package actually ships.** A default that names nothing
 *      is a boot failure with a confusing message ("driver missing: `r2`") instead of a table bug
 *      caught here.
 */

import { describe, expect, test } from 'bun:test';

import type { DeployTarget } from './capabilities.ts';
import {
  DEFAULTED_CAPABILITIES,
  DRIVER_DEFAULTS,
  EPHEMERAL_DRIVERS,
  driverDefaultFor,
  targetKeepsIsolate,
} from './driver-defaults.ts';

const TARGETS: readonly DeployTarget[] = ['bun', 'cloudflare', 'lambda'];

describe('driver defaults · a stateless target never defaults to memory', () => {
  test('cloudflare and lambda have no ephemeral default in any capability', () => {
    for (const target of ['cloudflare', 'lambda'] as const) {
      for (const capability of DEFAULTED_CAPABILITIES) {
        const row = driverDefaultFor(target, capability);
        expect({ target, capability, driver: row.driver }).not.toEqual(
          expect.objectContaining({ driver: expect.stringMatching(/^(memory|null|sync|log)$/u) }),
        );
      }
    }
  });

  test('the reason a default is refused is the reason the isolate is stateless', () => {
    expect(targetKeepsIsolate('bun')).toBe(true);
    expect(targetKeepsIsolate('cloudflare')).toBe(false);
    expect(targetKeepsIsolate('lambda')).toBe(false);
  });

  test('bun does default to memory, and that is not a contradiction', () => {
    // A long-lived process is the one place the contents of memory outlive the request. Refusing
    // it here would mean `make dev` needs a database to render a page.
    expect(driverDefaultFor('bun', 'cache').driver).toBe('memory');
    expect(driverDefaultFor('bun', 'sessions').driver).toBe('memory');
    expect(driverDefaultFor('bun', 'notifications').driver).toBe('memory');
  });

  test('every ephemeral driver is one this table can name', () => {
    for (const driver of EPHEMERAL_DRIVERS) {
      const used = DEFAULTED_CAPABILITIES.some(
        (capability) => driverDefaultFor('bun', capability).driver === driver,
      );
      // `null` has no default anywhere — it is the "cache that never stores" a project opts into.
      if (driver === 'null') expect(used).toBe(false);
      else expect(used).toBe(true);
    }
  });
});

describe('driver defaults · every default names what it needs', () => {
  test.each(
    TARGETS.flatMap((target) =>
      DEFAULTED_CAPABILITIES.map((capability) => [target, capability] as const),
    ),
  )('%s · %s carries a reason a reader can act on', (target, capability) => {
    const row = driverDefaultFor(target, capability);
    expect(row.driver.length).toBeGreaterThan(1);
    expect(row.why.length).toBeGreaterThan(20);
  });

  test('a driver with required values says every one of them', () => {
    // The failure this prevents: a default that builds until the first write, because the value it
    // needed was never named. Boot should be able to print the whole list at once.
    const r2 = driverDefaultFor('cloudflare', 'storage');
    expect(r2.driver).toBe('s3');
    expect(r2.requires).toContain('bucket');
    expect(r2.requires.some((entry) => entry.includes('endpoint'))).toBe(true);

    const sqs = driverDefaultFor('lambda', 'queue');
    expect(sqs.driver).toBe('sqs');
    expect(sqs.requires).toContain('queueUrl');
    expect(sqs.requires).toContain('outbox: true');
  });

  test('a complete driver requires nothing', () => {
    // `requires: []` is a claim, and it must be true: these build with no values at all.
    for (const [target, capability] of [
      ['bun', 'cache'],
      ['bun', 'mail'],
      ['bun', 'queue'],
    ] as const) {
      expect(driverDefaultFor(target, capability).requires).toEqual([]);
    }
  });

  test('the two targets that can, converge on the same driver where the API is the same', () => {
    // R2 and S3 are the same driver with a different endpoint — that is the whole reason storage
    // has no per-vendor branch, and this asserts the table did not invent one.
    expect(driverDefaultFor('cloudflare', 'storage').driver).toBe('s3');
    expect(driverDefaultFor('lambda', 'storage').driver).toBe('s3');
  });

  test('cache differs by target on purpose, and KV is not the Workers answer by accident', () => {
    // KV has no atomic increment and one write/sec/key; D1 has both. The row says KV because a
    // cache tolerates convergence, and `why` has to carry that reasoning or the next reader will
    // "fix" it to `database` without knowing what was weighed.
    const kv = driverDefaultFor('cloudflare', 'cache');
    expect(kv.driver).toBe('cloudflare-kv');
    expect(kv.why).toContain('60 s');
    expect(driverDefaultFor('cloudflare', 'database').driver).toBe('d1');
    expect(driverDefaultFor('lambda', 'database').driver).toBe('postgres');
  });
});

describe('driver defaults · the table is total', () => {
  test('every target covers every capability, with no row missed', () => {
    for (const target of TARGETS) {
      expect(Object.keys(DRIVER_DEFAULTS[target]).sort()).toEqual(
        [...DEFAULTED_CAPABILITIES].sort(),
      );
    }
  });

  test('the capability list is stable output, so `tsir doctor` does not reorder', () => {
    expect(DEFAULTED_CAPABILITIES).toEqual([...DEFAULTED_CAPABILITIES].sort());
    expect(new Set(DEFAULTED_CAPABILITIES).size).toBe(DEFAULTED_CAPABILITIES.length);
  });
});
