/**
 * The gate that reads every package so `@tsir/core` does not have to.
 *
 * Both failures it exists for are injected here rather than described: a default naming a driver
 * no package ships, and a stateless target defaulting to an ephemeral one.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import { DRIVER_DEFAULTS, driverDefaultFor } from '../framework/core/src/driver-defaults.ts';
import type { DeployTarget } from '../framework/core/src/capabilities.ts';
import { guideDrift, problems } from './check-driver-defaults.ts';

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

describe('the guide table documents the code', () => {
  const row = (label: string, defaults: string): string =>
    `| **${label}** | ` + '`x` | ' + defaults + ' | `a` | selectable | refused |';

  // Every row the gate knows about, written the way the real guide writes it, so the "clean"
  // fixture is not vacuously clean because a row failed to parse.
  const table = [
    row('Cache', '`cloudflare-kv` → `redis` → `memory`'),
    row('Queue', '`cloudflare-queues` → `sqs` → `sync`'),
    row('Mail', '`resend` → `ses` → `log`'),
    row('Storage', '`s3` + R2 endpoint → `s3` → `local`'),
    row('Notifications', '`database` → `database` → `memory`'),
    row('Broadcast', '`durable-object` → `redis` → `memory`'),
    row('Search', '`typesense` → `postgres` → `memory`'),
    row('Media', '`cloudflare` → `sharp` → `sharp`'),
    row('Sessions', '`database` → `database` → `memory`'),
    row('Database', '`d1` → `postgres` → `postgres`'),
    row('Feature flags', '`database` → `database` → `database`'),
    row('Scheduler lock', '`database` → `database` → `database`'),
  ].join('\n');

  test('a table that matches has no drift', () => {
    expect(guideDrift(table)).toEqual([]);
  });

  test('a row naming the wrong default is reported, naming both sides', () => {
    // The real drift: two rows claimed `memory` as the bun default while every target says
    // `database`. A reader on that page is choosing a production configuration.
    const drifted = table.replace(
      '| **Feature flags** | `x` | `database` → `database` → `database` |',
      '| **Feature flags** | `x` | `database` → `database` → `memory` |',
    );
    const drift = guideDrift(drifted);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain('memory');
    expect(drift[0]).toContain('database');
  });

  test('a row that disappeared is reported rather than skipped', () => {
    const missing = table
      .split('\n')
      .filter((line) => !line.includes('**Search**'))
      .join('\n');
    expect(guideDrift(missing).join(' ')).toContain('no row for `Search`');
  });
});
