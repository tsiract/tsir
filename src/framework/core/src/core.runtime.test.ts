/**
 * Runtime-environment coverage for `@tsir/core`.
 *
 * Two things are proven here that the lifecycle tests cannot:
 *
 * 1. `systemClock`/`systemRandom` behave like real clocks and sources of
 *    entropy (monotonic, in-range, unique).
 * 2. Capability detection reports what this process can actually do, rather
 *    than what a target name implies.
 */

import { describe, expect, test } from 'bun:test';

import { defineConfig, env, loadConfig } from '@tsir/config';

import { probeCapabilities, assertCapabilities } from './capabilities.ts';
import { systemClock, systemRandom } from './clock.ts';
import { defineModule } from './module.ts';
import { bootstrap } from './bootstrap.ts';

const config = loadConfig(defineConfig({ APP_NAME: env.string({ default: 'caps' }) }), { env: {} });

describe('core · systemClock', () => {
  test('reports wall-clock time in both shapes', () => {
    const clock = systemClock();
    const before = Date.now();
    const now = clock.now();
    const iso = clock.iso();

    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // `now()` and `iso()` are two reads of a real clock: under load they can straddle
    // a millisecond boundary, so equality here was a flake waiting for a busy CI box.
    expect(Math.abs(new Date(iso).getTime() - now.getTime())).toBeLessThanOrEqual(5);
  });

  test('monotonicMs never goes backwards and advances with real time', async () => {
    const clock = systemClock();
    const first = clock.monotonicMs();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = clock.monotonicMs();

    expect(second).toBeGreaterThan(first);
    expect(first).toBeGreaterThanOrEqual(0);
  });
});

describe('core · systemRandom', () => {
  test('next() is uniform, in [0, 1), and not constant', () => {
    const random = systemRandom();
    const draws = Array.from({ length: 64 }, () => random.next());

    for (const draw of draws) {
      expect(draw).toBeGreaterThanOrEqual(0);
      expect(draw).toBeLessThan(1);
    }
    expect(new Set(draws).size).toBeGreaterThan(60);
  });

  test('uuid() produces version-4 shaped identifiers that do not collide', () => {
    const random = systemRandom();
    const ids = new Set(Array.from({ length: 32 }, () => random.uuid()));

    expect(ids.size).toBe(32);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('bytes() honours the requested length and returns fresh buffers', () => {
    const random = systemRandom();
    const a = random.bytes(16);
    const b = random.bytes(16);

    expect(a).toBeInstanceOf(Uint8Array);
    expect(a).toHaveLength(16);
    expect(a).not.toEqual(b);
    expect(random.bytes(0)).toHaveLength(0);
  });
});

describe('core · capability probing', () => {
  test('the Bun target reports what the process actually provides', () => {
    const caps = probeCapabilities();

    expect(caps.target).toBe('bun');
    expect(caps.list).toContain('node-compat');
    expect(caps.list).toContain('filesystem');
    expect(caps.list).toContain('subprocesses');
    expect(new Set(caps.list).size).toBe(caps.list.length);
    expect(caps.has('raw-sockets')).toBe(true);
    expect(caps.has('durable-state')).toBe(false);
  });

  test('assertCapabilities is silent when everything is present', () => {
    const caps = probeCapabilities();
    const requires =
      defineModule({
        name: 'files',
        requires: [{ module: 'files', capabilities: ['filesystem'] }],
      }).requires ?? [];

    expect(() => {
      assertCapabilities(caps, requires);
    }).not.toThrow();
  });

  test('assertCapabilities names the module, the platform, and the missing feature', () => {
    const caps = probeCapabilities();
    const requires =
      defineModule({
        name: 'grpc-client',
        requires: [{ module: 'grpc-client', capabilities: ['raw-sockets'] }],
      }).requires ?? [];

    try {
      assertCapabilities(probeCapabilities('cloudflare'), requires);
      throw new Error('expected a capability failure');
    } catch (error: unknown) {
      const shaped = error as {
        code: string;
        message: string;
        hint?: string;
        context?: Record<string, unknown>;
      };
      expect(shaped.code).toBe('APP_CAPABILITY_MISSING');
      expect(shaped.message).toContain('raw-sockets');
      expect(shaped.message).toContain('grpc-client');
      expect(shaped.message).toContain('"cloudflare"');
      expect(shaped.context).toEqual({ target: 'cloudflare', missing: 1 });
    }
    expect(caps.target).toBe('bun');
  });

  test('an explicit capability set is respected during boot', async () => {
    const app = await bootstrap({
      appName: 'caps',
      config,
      modules: [defineModule({ name: 'plain' })],
      capabilities: probeCapabilities('cloudflare'),
    });

    expect(app.capabilities.target).toBe('cloudflare');
    await app.shutdown('manual');
  });
});
