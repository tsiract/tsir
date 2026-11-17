/**
 * `broadcast.driver` as a name in `tsir.js` (`CAP-006`).
 *
 * Two properties matter and neither is about publishing: a name this build does not ship fails
 * with the list of names it does, and `memory` — the driver whose subscribers live in the isolate
 * — is refused in production. Before this registry existed there was no place for either refusal
 * to live, which is why the package had drivers but no way to select one from a file.
 */

import { describe, expect, test } from 'bun:test';

import { BROADCAST_DRIVERS } from './broadcaster.ts';
import { broadcasterFor, broadcasterFromConfig } from './config.ts';
import { createBroadcastBootstrap } from './bootstrap.ts';
import type { DurableObjectNamespaceLike } from './durable-object.ts';
import type { RedisPubSubClient } from './redis.ts';

function fakeRedis(): RedisPubSubClient {
  return {
    publish: (): Promise<number> => Promise.resolve(1),
    subscribe: (): Promise<unknown> => Promise.resolve(undefined),
    unsubscribe: (): Promise<unknown> => Promise.resolve(undefined),
    on: (): void => undefined,
  };
}

function fakeNamespace(): DurableObjectNamespaceLike {
  return {
    idFromName: (name: string): unknown => name,
    get: () => ({
      fetch: (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 })),
    }),
  };
}

function codeOf(fn: () => unknown): { code?: string; hint?: string } {
  try {
    fn();
  } catch (error: unknown) {
    return error as { code?: string; hint?: string };
  }
  return {};
}

describe('broadcast registry · a driver is a name in tsir.js', () => {
  test('every shipped driver can be built from config plus its binding', () => {
    expect(broadcasterFor({ driver: 'memory' })).toBeDefined();
    expect(broadcasterFor({ driver: 'redis' }, { redis: { default: fakeRedis() } })).toBeDefined();
    expect(
      broadcasterFor({ driver: 'durable-object' }, { realtime: { default: fakeNamespace() } }),
    ).toBeDefined();
    expect(
      broadcasterFor(
        { driver: 'pusher' },
        { pusher: { default: { trigger: (): Promise<unknown> => Promise.resolve({}) } } },
      ),
    ).toBeDefined();
  });

  test('an unknown driver lists the ones this build ships', () => {
    const thrown = codeOf(() => broadcasterFor({ driver: 'ably' }));
    expect(thrown.code).toBe('CAP_DRIVER_MISSING');
    expect(thrown.hint).toContain(BROADCAST_DRIVERS.join(', '));
  });

  test('a driver whose binding is absent names the binding, not just the driver', () => {
    // The failure this prevents: "no broadcaster" — which sends a reader to the wrong file.
    const thrown = codeOf(() => broadcasterFor({ driver: 'durable-object' }));
    expect(thrown.code).toBe('CAP_DRIVER_MISSING');
    expect(thrown.hint).toContain('bindings.realtime.default');
  });

  test('a binding is looked up by the configured connection, not always "default"', () => {
    expect(
      broadcasterFor(
        { driver: 'redis', connection: 'realtime' },
        { redis: { realtime: fakeRedis() } },
      ),
    ).toBeDefined();
    // And the wrong name is a miss, not a silent fallback to `default`.
    const thrown = codeOf(() =>
      broadcasterFor(
        { driver: 'redis', connection: 'realtime' },
        { redis: { default: fakeRedis() } },
      ),
    );
    expect(thrown.hint).toContain('bindings.redis.realtime');
  });
});

describe('broadcast registry · memory is refused in production', () => {
  test('production refuses memory, and says what to use instead', () => {
    const thrown = codeOf(() => broadcasterFor({ driver: 'memory' }, {}, { production: true }));
    expect(thrown.code).toBe('CAP_FORBIDDEN_IN_PRODUCTION');
    expect(thrown.hint).toContain('durable-object');
    expect(thrown.hint).toContain('redis');
  });

  test('development accepts it, because one process really is one process', () => {
    expect(broadcasterFor({ driver: 'memory' }, {}, { production: false })).toBeDefined();
  });

  test('a project with no broadcast block gets memory in dev and a refusal in production', () => {
    expect(broadcasterFromConfig({})).toBeDefined();
    expect(codeOf(() => broadcasterFromConfig({ production: true })).code).toBe(
      'CAP_FORBIDDEN_IN_PRODUCTION',
    );
  });
});

describe('broadcast bootstrap · one way in, no silent override', () => {
  test('the tsir.js block is used when given', () => {
    const { broadcaster } = createBroadcastBootstrap({
      broadcast: { driver: 'redis' },
      bindings: { redis: { default: fakeRedis() } },
    });
    expect(broadcaster).toBeDefined();
  });

  test('an instance and a block together is refused rather than resolved by precedence', () => {
    expect(() =>
      createBroadcastBootstrap({
        broadcast: { driver: 'memory' },
        broadcaster: { publish: async () => undefined, subscribe: () => () => undefined },
      }),
    ).toThrow(/not both/u);
  });

  test('no arguments is the development default', () => {
    expect(createBroadcastBootstrap().broadcaster).toBeDefined();
  });
});
