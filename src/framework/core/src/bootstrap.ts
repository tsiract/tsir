/**
 * Bootstrap and lifecycle.
 *
 *   validate → compose → start hooks → ready → (running) → stop hooks → dispose
 *
 * Every stage is attempted at most once, every failure is a `TsirError` with a
 * code, and a failure at any stage disposes whatever was already built.
 */

import { Container, TsirError, type Provider, type Scope } from '@tsir/container';
import { loadConfig, type ConfigSpec, type InferConfig } from '@tsir/config';

import { assertCapabilities, probeCapabilities } from './capabilities.ts';
import { systemClock, systemRandom } from './clock.ts';
import { isManifestStale } from './manifest.ts';
import { validateModules } from './module.ts';
import type { ModuleDefinition } from './module.ts';
import type {
  App,
  AppDiagnosticEvent,
  AppState,
  BootstrapOptions,
  ShutdownReason,
} from './types.ts';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

function appError(
  code: string,
  message: string,
  hint?: string,
  context?: Readonly<Record<string, string | number | boolean>>,
  cause?: unknown,
): TsirError {
  return new TsirError(code, message, {
    kind: 'internal',
    ...(hint === undefined ? {} : { hint }),
    ...(context === undefined ? {} : { context }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Internal marker so a budget overrun is distinguishable from a hook failure. */
class DeadlineError extends Error {
  constructor(ms: number) {
    super(`exceeded ${String(Math.round(ms))}ms`);
    this.name = 'DeadlineError';
  }
}

class AppImpl<TConfig> implements App<TConfig> {
  readonly appName: string;
  readonly config: BootstrapOptions<TConfig>['config'];
  readonly manifest: BootstrapOptions<TConfig>['manifest'];
  readonly clock: NonNullable<BootstrapOptions<TConfig>['clock']>;
  readonly random: NonNullable<BootstrapOptions<TConfig>['random']>;
  readonly capabilities: NonNullable<BootstrapOptions<TConfig>['capabilities']>;
  readonly container: Container;

  #state: AppState<TConfig> = { kind: 'created' };
  #shutdown: Promise<void> | null = null;
  #readyAt = 0;
  readonly #modules: NonNullable<BootstrapOptions<TConfig>['modules']>;
  readonly #appSpec: ConfigSpec;
  readonly #moduleDefaults: NonNullable<BootstrapOptions<TConfig>['moduleDefaults']>;
  readonly #env: BootstrapOptions<TConfig>['env'];
  readonly #shutdownTimeoutMs: number;
  readonly #signal: AbortSignal | undefined;
  readonly #onDiagnostic: (event: AppDiagnosticEvent) => void;
  readonly #stoppedHooks: (() => Promise<void>)[] = [];

  constructor(options: BootstrapOptions<TConfig>, container: Container) {
    this.appName = options.appName;
    this.config = options.config;
    this.manifest = options.manifest;
    this.clock = options.clock ?? systemClock();
    this.random = options.random ?? systemRandom();
    this.capabilities = options.capabilities ?? probeCapabilities();
    this.container = container;
    this.#modules = options.modules;
    this.#appSpec = options.appSpec ?? {};
    this.#moduleDefaults = options.moduleDefaults ?? {};
    this.#env = options.env;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.#signal = options.signal;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
  }

  get state(): AppState<TConfig> {
    return this.#state;
  }

  createScope(kind: 'request' | 'job' | 'task', id?: string): Scope {
    if (this.#state.kind !== 'ready') {
      throw appError(
        'APP_ILLEGAL_TRANSITION',
        `Cannot create a ${kind} scope while the app is "${this.#state.kind}"`,
        'scopes are only valid once the application is ready',
      );
    }
    return this.container.createScope(kind, id);
  }

  // ── Stage transitions ─────────────────────────────────────────────────────

  markConfigured(): void {
    this.#state = { kind: 'configured', config: this.config };
  }

  async compose(
    providers: readonly Provider<unknown>[],
    overrides: readonly Provider<unknown>[],
  ): Promise<void> {
    const started = performance.now();
    this.#assertNotAborted();
    if (providers.length > 0) this.container.register(...providers);
    for (const override of overrides) this.container.override(override);
    const providerCount = this.container.describe().length;
    this.#state = { kind: 'composed', providerCount };
    this.#onDiagnostic({
      type: 'stage',
      stage: 'compose',
      durationMs: performance.now() - started,
    });
  }

  async start(): Promise<void> {
    const started = performance.now();
    for (const module of this.#modules) {
      this.#assertNotAborted();
      const signal = this.#signal ?? new AbortController().signal;
      const config = this.#resolveModuleConfig(module);
      const ctx = { module: module.name, config, clock: this.clock, signal };
      if (module.onStart !== undefined) {
        const hookStarted = performance.now();
        await this.#runHook(module.name, 'onStart', () => module.onStart?.(ctx));
        this.#onDiagnostic({
          type: 'module',
          module: module.name,
          hook: 'onStart',
          durationMs: performance.now() - hookStarted,
        });
      }
      if (module.onReady !== undefined) {
        const hookStarted = performance.now();
        await this.#runHook(module.name, 'onReady', () => module.onReady?.(ctx));
        this.#onDiagnostic({
          type: 'module',
          module: module.name,
          hook: 'onReady',
          durationMs: performance.now() - hookStarted,
        });
      }
      if (module.onStop !== undefined) {
        this.#stoppedHooks.push(() =>
          this.#runHook(module.name, 'onStop', () => module.onStop?.(ctx)),
        );
      }
    }
    this.#readyAt = performance.now();
    this.#state = { kind: 'ready', readyAt: this.clock.iso() };
    this.#onDiagnostic({ type: 'stage', stage: 'ready', durationMs: performance.now() - started });
  }

  /**
   * Resolve a module's config.
   *
   * Merges the app spec with the module's own spec (module defaults win over app
   * defaults for shared keys), then applies root-level `tsir.js` defaults as the
   * floor. Environment variables win at every level.
   */
  #resolveModuleConfig(module: ModuleDefinition): InferConfig<ConfigSpec> {
    const merged: ConfigSpec = { ...this.#appSpec, ...(module.config ?? {}) };
    const baseDefaults = this.#moduleDefaults[module.name];
    const loaded = loadConfig(merged, {
      appName: this.appName,
      ...(this.#env === undefined ? {} : { env: this.#env }),
      ...(baseDefaults === undefined ? {} : { baseDefaults }),
    });
    return loaded.values;
  }

  shutdown(reason: ShutdownReason): Promise<void> {
    this.#shutdown ??= this.#performShutdown(reason);
    return this.#shutdown;
  }

  async #performShutdown(reason: ShutdownReason): Promise<void> {
    const started = performance.now();
    const previous = this.#state.kind;
    this.#state = { kind: 'stopping', reason };

    const deadline = started + this.#shutdownTimeoutMs;
    const pending: string[] = [];
    let timedOut = false;

    // Stop hooks run in reverse registration order: dependents before dependencies.
    for (const hook of [...this.#stoppedHooks].reverse()) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        timedOut = true;
        pending.push('hook(s) after deadline');
        break;
      }
      try {
        await this.#withDeadline(hook(), remaining);
      } catch (error: unknown) {
        if (error instanceof DeadlineError) timedOut = true;
        pending.push(describe(error));
      }
    }

    try {
      await this.container.dispose();
    } catch (error: unknown) {
      pending.push(`container: ${describe(error)}`);
    }

    const durationMs = Math.round(performance.now() - started);
    this.#state = { kind: 'stopped', reason, durationMs };
    this.#onDiagnostic({ type: 'stage', stage: 'stop', durationMs });

    if (timedOut) {
      throw appError(
        'APP_SHUTDOWN_TIMEOUT',
        `Shutdown exceeded ${String(this.#shutdownTimeoutMs)}ms (previous state: ${previous})`,
        'increase lifecycle.shutdownTimeoutMs or fix the hook that never settles',
        { reason, durationMs, pending: pending.length },
      );
    }

    if (pending.length > 0) {
      throw appError(
        'APP_SHUTDOWN_INCOMPLETE',
        `${String(pending.length)} step(s) failed during shutdown`,
        'shutdown completed for everything else; inspect the listed failures in logs',
        { reason, failures: pending.length },
      );
    }
  }

  /** Milliseconds since the app became ready; used by adapters for uptime reporting. */
  get uptimeMs(): number {
    return this.#readyAt === 0 ? 0 : performance.now() - this.#readyAt;
  }

  markFailed(code: string): void {
    this.#state = { kind: 'failed', code };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #assertNotAborted(): void {
    if (this.#signal?.aborted === true) {
      throw appError(
        'APP_BOOT_ABORTED',
        'Bootstrap aborted by signal',
        'whatever was composed has been disposed',
      );
    }
  }

  async #runHook(module: string, hook: string, run: () => Promise<void> | void): Promise<void> {
    try {
      await run();
    } catch (error: unknown) {
      throw appError(
        'APP_HOOK_FAILED',
        `Module "${module}" failed in ${hook}: ${describe(error)}`,
        'fix the hook; the application will not start in a partially initialised state',
        { module, hook },
        error,
      );
    }
  }

  #withDeadline(promise: Promise<void>, ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DeadlineError(ms));
      }, ms);
      promise.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}

export async function bootstrap<TConfig>(
  options: BootstrapOptions<TConfig>,
): Promise<App<TConfig>> {
  const mode = options.mode ?? 'development';
  const container = new Container({
    ...(options.onDiagnostic === undefined
      ? {}
      : { onDiagnostic: (event) => options.onDiagnostic?.({ type: 'container', event }) }),
  });

  const app = new AppImpl(options, container);

  try {
    // ── validate ────────────────────────────────────────────────────────────
    try {
      validateModules(options.modules);
    } catch (error: unknown) {
      throw appError(
        'APP_MODULES_INVALID',
        describe(error),
        'register at least one uniquely named module',
      );
    }

    const requirements = options.modules.flatMap((module) => module.requires ?? []);
    assertCapabilities(app.capabilities, requirements);

    if (mode === 'production') {
      if (options.manifest === undefined) {
        throw appError(
          'APP_MANIFEST_MISSING',
          'Production bootstrap requires a generated manifest',
          'run `tsir build` before starting the application',
        );
      }
      if (isManifestStale(options.manifest, options.modules)) {
        throw appError(
          'APP_MANIFEST_STALE',
          `Manifest for "${options.appName}" does not match the imported modules`,
          'run `tsir build`; production never reflects over modules at boot',
          { appName: options.appName, generatedAt: options.manifest.generatedAt },
        );
      }
    }

    app.markConfigured();

    // ── compose ─────────────────────────────────────────────────────────────
    const providers = options.modules.flatMap((module) => module.providers ?? []);
    await app.compose(providers, options.overrides ?? []);

    // ── start ───────────────────────────────────────────────────────────────
    await app.start();

    return app;
  } catch (error: unknown) {
    const tsirError =
      error instanceof TsirError
        ? error
        : appError('APP_BOOTSTRAP_FAILED', describe(error), undefined, undefined, error);
    app.markFailed(tsirError.code);
    try {
      await app.shutdown('bootstrap-failed');
    } catch {
      // Disposal problems during a failed bootstrap must not mask the root cause.
    }
    throw tsirError;
  }
}
