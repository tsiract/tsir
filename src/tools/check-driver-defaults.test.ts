/**
 * The gate that reads every package so `@tsir/core` does not have to.
 *
 * Both failures it exists for are injected here rather than described: a default naming a driver
 * no package ships, and a stateless target defaulting to an ephemeral one.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import { DRIVER_DEFAULTS, driverDefaultFor } from '../framework/core/src/driver-defaults.ts';
import type { DeployTarget } from '../framework/core/src/capabilities.ts';
import { problems } from './check-driver-defaults.ts';

const realCloudflare = DRIVER_DEFAULTS.cloudflare;

afterEach(() => {
  (DRIVER_DEFAULTS as Record<DeployTarget, unknown>)['cloudflare'] = realCloudflare;
});

describe('check-driver-defaults', () => {
  test('the repository is clean', () => {
    expect(problems()).toEqual([]);
  });

  test('a default naming a driver no package ships is reported', () => {
    (DRIVER_DEFAULTS as Record<DeployTarget, unknown>)['cloudflare'] = {
      ...realCloudflare,
      // `r2` is the mistake a reasonable person makes: it is the *service* name, not the driver.
      storage: { ...driverDefaultFor('cloudflare', 'storage'), driver: 'r2' },
    };
    const found = problems();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ capability: 'storage', driver: 'r2' });
    expect(found[0]?.reason).toContain('no package ships');
  });

  test('a stateless target defaulting to memory is reported, not accepted', () => {
    (DRIVER_DEFAULTS as Record<DeployTarget, unknown>)['cloudflare'] = {
      ...realCloudflare,
      sessions: { driver: 'memory', requires: [], why: 'a deliberately wrong row' },
    };
    const found = problems();
    expect(found[0]).toMatchObject({ target: 'cloudflare', capability: 'sessions' });
    expect(found[0]?.reason).toContain('which isolate took the write');
  });
});
