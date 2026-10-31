import { describe, expect, test } from 'bun:test';
import { token, valueProvider } from '@tsir/container';
import { defineConfig, env, loadConfig } from '@tsir/config';

import { bootstrap } from './bootstrap.ts';
import { createManifest, diffManifest, hashModules, isManifestStale } from './manifest.ts';
import { defineModule } from './module.ts';
import { probeCapabilities } from './capabilities.ts';
import { defineApp } from './define-app.ts';
import type { App, AppDiagnosticEvent, BootstrapOptions } from './types.ts';

const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
  SERVICE_NAME: env.string({ default: 'acme' }),
  SECRET_TOKEN: env.secret({ minLength: 8 }),
});
const config = loadConfig(spec, { env: { SECRET_TOKEN: 'super-secret-value' } });

interface Greeter {
  greet(): string;
}
const GreeterToken = token<Greeter>('Greeter');
const NameToken = token<string>('ServiceName');

function options(overrides: Partial<BootstrapOptions<unknown>> = {}): BootstrapOptions<unknown> {
  return {
    appName: 'test-app',
    config,
    modules: [defineModule({ name: 'core' })],
    ...overrides,
  };
}

/** Asserts a rejected promise carries a specific Tsir code (not a message). */
async function rejectsWithCode(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error: unknown) {
    const actual = (error as { code?: string }).code;
    if (actual !== code) {
      throw new Error(`expected code ${code}, received ${actual ?? String(error)}`);
    }
    return;
  }
  throw new Error(`expected code ${code}, but the promise resolved`);
}

async function makeApp(overrides: Partial<BootstrapOptions<unknown>> = {}): Promise<App<unknown>> {
  return bootstrap(options(overrides));
}

describe('core · bootstrap', () => {
  test('a minimal application reaches the ready state', async () => {
    const app = await makeApp();
    expect(app.state.kind).toBe('ready');
    expect((app.config.values as { SERVICE_NAME: string }).SERVICE_NAME).toBe('acme');
    expect(app.capabilities.list.length).toBeGreaterThan(0);

    await app.shutdown('manual');
    expect(app.state.kind).toBe('stopped');
  });

  test('an empty module list fails loudly', async () => {
    await rejectsWithCode(() => makeApp({ modules: [] }), 'APP_MODULES_INVALID');
  });

  test('duplicate module names are rejected before composition', async () => {
    await rejectsWithCode(
      () => makeApp({ modules: [defineModule({ name: 'a' }), defineModule({ name: 'a' })] }),
      'APP_MODULES_INVALID',
    );
  });

  test('providers from every module are registered exactly once', async () => {
    const app = await makeApp({
      modules: [
        defineModule({ name: 'one', providers: [valueProvider(NameToken, 'acme')] }),
        defineModule({
          name: 'two',
          providers: [valueProvider(GreeterToken, { greet: () => 'hi' })],
        }),
      ],
    });
    expect(app.container.describe()).toHaveLength(2);
    expect(app.container.resolve(NameToken)).toBe('acme');
    await app.shutdown('manual');
  });

  test('overrides replace providers before any singleton is constructed', async () => {
    const app = await makeApp({
      modules: [
        defineModule({
          name: 'greeting',
          providers: [valueProvider(GreeterToken, { greet: () => 'original' })],
        }),
      ],
      overrides: [valueProvider(GreeterToken, { greet: () => 'overridden' })],
    });
    expect(app.container.resolve(GreeterToken).greet()).toBe('overridden');
    await app.shutdown('manual');
  });

  test('a failing provider registration surfaces as a container error', async () => {
    await rejectsWithCode(
      () =>
        makeApp({
          modules: [
            defineModule({ name: 'a', providers: [valueProvider(NameToken, 'one')] }),
            defineModule({ name: 'b', providers: [valueProvider(NameToken, 'two')] }),
          ],
        }),
      'CTN_DUPLICATE',
    );
  });
});

describe('core · manifests', () => {
  const modules = [
    defineModule({ name: 'a' }),
    defineModule({ name: 'b', providers: [valueProvider(NameToken, 'x')] }),
  ];

  test('hash ignores declaration order', () => {
    expect(hashModules(modules)).toBe(hashModules([...modules].reverse()));
  });

  test('hash changes when the provider graph changes', () => {
    const changed = [modules[0]!, defineModule({ name: 'b' })];
    expect(hashModules(modules)).not.toBe(hashModules(changed));
  });

  test('diff reports added and removed modules', () => {
    const manifest = createManifest('app', [modules[0]!], '2026-01-01T00:00:00.000Z');
    const drift = diffManifest(manifest, modules);
    expect(drift.added).toEqual(['b']);
    expect(drift.removed).toEqual([]);
  });

  test('production requires a manifest', async () => {
    await rejectsWithCode(() => makeApp({ mode: 'production' }), 'APP_MANIFEST_MISSING');
  });

  test('a stale manifest fails boot instead of reflecting', async () => {
    const stale = createManifest(
      'test-app',
      [defineModule({ name: 'other' })],
      '2026-01-01T00:00:00.000Z',
    );
    await rejectsWithCode(
      () => makeApp({ mode: 'production', manifest: stale }),
      'APP_MANIFEST_STALE',
    );
  });

  test('a matching manifest boots in production', async () => {
    const modules = [defineModule({ name: 'core' })];
    const manifest = createManifest('test-app', modules, '2026-01-01T00:00:00.000Z');
    const app = await bootstrap({
      appName: 'test-app',
      config,
      modules,
      manifest,
      mode: 'production',
    });
    expect(app.state.kind).toBe('ready');
    expect(isManifestStale(manifest, modules)).toBe(false);
    await app.shutdown('manual');
  });

  test('development tolerates a missing manifest', async () => {
    const app = await makeApp({ mode: 'development' });
    expect(app.manifest).toBeUndefined();
    await app.shutdown('manual');
  });
});

describe('core · lifecycle hooks', () => {
  test('hooks run in declaration order and stop in reverse', async () => {
    const order: string[] = [];
    const app = await makeApp({
      modules: [
        defineModule({
          name: 'a',
          onStart: () => void order.push('a:start'),
          onReady: () => void order.push('a:ready'),
          onStop: () => void order.push('a:stop'),
        }),
        defineModule({
          name: 'b',
          onStart: () => void order.push('b:start'),
          onReady: () => void order.push('b:ready'),
          onStop: () => void order.push('b:stop'),
        }),
      ],
    });
    expect(order).toEqual(['a:start', 'a:ready', 'b:start', 'b:ready']);
    await app.shutdown('manual');
    expect(order.slice(4)).toEqual(['b:stop', 'a:stop']);
  });

  test('a failing start hook aborts boot with a stable code', async () => {
    await rejectsWithCode(
      () =>
        makeApp({
          modules: [
            defineModule({
              name: 'broken',
              onStart: () => {
                throw new Error('nope');
              },
            }),
          ],
        }),
      'APP_HOOK_FAILED',
    );
  });

  test('shutdown is idempotent', async () => {
    const app = await makeApp();
    const first = app.shutdown('manual');
    const second = app.shutdown('manual');
    expect(first).toBe(second);
    await first;
  });

  test('a hanging stop hook times out with a distinct code', async () => {
    const app = await makeApp({
      shutdownTimeoutMs: 30,
      modules: [defineModule({ name: 'hangs', onStop: () => new Promise<void>(() => undefined) })],
    });
    await rejectsWithCode(() => app.shutdown('manual'), 'APP_SHUTDOWN_TIMEOUT');
  });

  test('shutdown continues past a failing hook and reports it', async () => {
    const order: string[] = [];
    const app = await makeApp({
      modules: [
        defineModule({
          name: 'a',
          onStop: () => {
            throw new Error('stop failed');
          },
        }),
        defineModule({ name: 'b', onStop: () => void order.push('b:stop') }),
      ],
    });
    await rejectsWithCode(() => app.shutdown('manual'), 'APP_SHUTDOWN_INCOMPLETE');
    expect(order).toEqual(['b:stop']);
  });
});

describe('core · guards', () => {
  test('an aborted signal prevents startup', async () => {
    const controller = new AbortController();
    controller.abort();
    await rejectsWithCode(() => makeApp({ signal: controller.signal }), 'APP_BOOT_ABORTED');
  });

  test('scopes cannot be created after shutdown', async () => {
    const app = await makeApp();
    await app.shutdown('manual');
    expect(() => app.createScope('request')).toThrow(
      expect.objectContaining({ code: 'APP_ILLEGAL_TRANSITION' }),
    );
  });

  test('scopes can be created once ready', async () => {
    const app = await makeApp();
    const scope = app.createScope('request', 'req-1');
    expect(scope.id).toBe('req-1');
    expect(scope.kind).toBe('request');
    await scope.dispose();
    await app.shutdown('manual');
  });

  test('missing capabilities name the module and the capability', async () => {
    const capabilities = probeCapabilities('cloudflare');
    await rejectsWithCode(
      () =>
        makeApp({
          capabilities,
          modules: [
            defineModule({
              name: 'grpc-client',
              requires: [{ module: 'grpc-client', capabilities: ['raw-sockets'] }],
            }),
          ],
        }),
      'APP_CAPABILITY_MISSING',
    );
  });

  test('boot failures never leak configuration secrets', async () => {
    try {
      await makeApp({ modules: [] });
      throw new Error('expected failure');
    } catch (error: unknown) {
      const shaped = error as { toLogObject?: () => unknown; message: string };
      const serialized = JSON.stringify(shaped.toLogObject?.() ?? { message: shaped.message });
      expect(serialized).not.toContain('super-secret-value');
    }
  });
});

describe('core · defineApp', () => {
  const secretEnv = { SECRET_TOKEN: 'super-secret-value' } as const;

  // `defineApp` is the front door: every real application, the CLI and the test
  // harness go through it, so its own behaviour is asserted rather than assumed
  // from an integration test three packages away.
  const app = defineApp({
    name: 'defined',
    config: spec,
    modules: () => [
      defineModule({ name: 'root', providers: [valueProvider(NameToken, 'from-module')] }),
      defineModule({ name: 'second' }),
    ],
    shutdownTimeoutMs: 500,
  });

  test('load() validates configuration and reports the app name', () => {
    const loaded = app.load({ env: secretEnv });
    expect(loaded.values.SERVICE_NAME).toBe('acme');
    expect(loaded.appName).toBe('defined');

    // The configuration type survives `defineApp`: a misspelled key is a compile
    // error, not `undefined` discovered in production.
    // @ts-expect-error — SERVICE_NAMNE is not a declared key
    expect(loaded.values.SERVICE_NAMNE).toBeUndefined();
  });

  test('production loads strictly, development tolerates unrelated variables', () => {
    const noisy = { ...secretEnv, TSIR_UNRELATED: 'x' };
    expect(app.load({ mode: 'development', env: noisy }).values.SERVICE_NAME).toBe('acme');
    expect(() => app.load({ mode: 'production', env: noisy })).toThrow();
  });

  test('modulesFor() accepts a fixed list or a factory that reads configuration', () => {
    const fixed = defineApp({
      name: 'fixed',
      config: spec,
      modules: [defineModule({ name: 'a' })],
    });
    expect(fixed.modulesFor(fixed.load({ env: secretEnv }))).toHaveLength(1);

    const derived = defineApp({
      name: 'derived',
      config: spec,
      modules: (config) => [defineModule({ name: String(config.values.SERVICE_NAME) })],
    });
    expect(derived.modulesFor(derived.load({ env: secretEnv }))[0]?.name).toBe('acme');
  });

  test('manifest() describes the module set without booting anything', () => {
    const first = app.manifest({ env: secretEnv });
    expect(first.appName).toBe('defined');
    expect(first.modules).toEqual(['root', 'second']);
    expect(first.providerCount).toBe(1);

    const second = app.manifest({ env: secretEnv });
    expect(second.sourceHash).toBe(first.sourceHash);
  });

  test('createApp() boots through the single bootstrap path and stops on shutdown', async () => {
    const instance = await app.createApp({ env: secretEnv });
    expect(instance.state.kind).toBe('ready');
    expect(instance.appName).toBe('defined');

    await instance.shutdown('manual');
    expect(instance.state.kind).toBe('stopped');
  });

  test('createApp() forwards overrides, diagnostics, the signal and the manifest', async () => {
    const diagnostics: AppDiagnosticEvent[] = [];
    const controller = new AbortController();
    const manifest = app.manifest({ env: secretEnv });

    const instance = await app.createApp({
      env: secretEnv,
      manifest,
      signal: controller.signal,
      onDiagnostic: (event) => diagnostics.push(event),
      overrides: [valueProvider(NameToken, 'from-override')],
    });

    expect(instance.manifest?.sourceHash).toBe(manifest.sourceHash);
    expect(instance.container.resolve(NameToken)).toBe('from-override');
    expect(diagnostics.some((event) => event.type === 'stage' && event.stage === 'ready')).toBe(
      true,
    );
    expect(instance.state.kind).toBe('ready');

    await instance.shutdown('manual');
  });
});
