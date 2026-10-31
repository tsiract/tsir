/**
 * The container.
 *
 * Deliberately small and explicit:
 *   · resolution happens only where an application chooses to call it
 *     (bootstrap, a request scope, a job, a CLI command),
 *   · every failure has its own error code and a remediation hint,
 *   · there is no global instance, so nothing can reach a service locator
 *     through a well-known symbol.

 */

import { TsirError } from './errors.ts';
import type { Provider } from './provider.ts';
import { implSlot } from './provider.ts';
import { describeToken, type Token } from './token.ts';

export type ScopeKind = 'request' | 'job' | 'task';

export interface Disposable {
  readonly name: string;
  dispose(): void | Promise<void>;
}

export type DiagnosticEvent =
  | { readonly type: 'transient-leak'; readonly token: string; readonly count: number }
  | { readonly type: 'slow-dispose'; readonly name: string; readonly ms: number };

export interface ContainerOptions {
  /** Max resolution depth before `CTN_DEPTH` (guards runaway graphs). Default 32. */
  readonly maxResolutionDepth?: number;
  /** Include the resolution chain in `CTN_NO_PROVIDER` errors. Default true. */
  readonly revealChain?: boolean;
  /** Per-disposable timeout during shutdown. Default 5 000 ms. */
  readonly disposalTimeoutMs?: number;
  /** Warning threshold for repeated transient instantiations. Default 100. */
  readonly transientLeakThreshold?: number;
  /** Receives non-fatal diagnostics; defaults to discarding them. */
  readonly onDiagnostic?: (event: DiagnosticEvent) => void;
}

export interface Scope {
  readonly id: string;
  readonly kind: ScopeKind;
  resolve<T>(token: Token<T>): T;
  resolveAsync<T>(token: Token<T>): Promise<T>;
  readonly disposed: boolean;
  dispose(): Promise<void>;
}

interface Registration {
  readonly provider: Provider<unknown>;
  state: 'pending' | 'ready';
  instance: unknown;
  pending: Promise<unknown> | null;
  instantiations: number;
  leakReported: boolean;
}

interface ScopedCache {
  readonly values: Map<symbol, unknown>;
  readonly pending: Map<symbol, Promise<unknown>>;
  readonly owned: Map<symbol, unknown>;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function hasDispose(value: unknown): value is Disposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dispose' in value &&
    typeof value.dispose === 'function'
  );
}

function errorWith(
  code: string,
  message: string,
  hint: string | undefined,
  context: Readonly<Record<string, string | number | boolean>> | undefined,
  cause?: unknown,
): TsirError {
  return new TsirError(code, message, {
    kind: 'container',
    ...(hint === undefined ? {} : { hint }),
    ...(context === undefined ? {} : { context }),
    ...(cause === undefined ? {} : { cause }),
  });
}

export class Container {
  readonly #registrations = new Map<symbol, Registration>();
  readonly #options: Required<Omit<ContainerOptions, 'onDiagnostic'>> & {
    readonly onDiagnostic: (event: DiagnosticEvent) => void;
  };
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(options: ContainerOptions = {}) {
    this.#options = {
      maxResolutionDepth: options.maxResolutionDepth ?? 32,
      revealChain: options.revealChain ?? true,
      disposalTimeoutMs: options.disposalTimeoutMs ?? 5_000,
      transientLeakThreshold: options.transientLeakThreshold ?? 100,
      onDiagnostic: options.onDiagnostic ?? (() => undefined),
    };
  }

  // ── Registration ──────────────────────────────────────────────────────────

  register(...providers: readonly Provider<unknown>[]): void {
    this.#assertUsable('register');
    for (const provider of providers) {
      if (this.#registrations.has(provider.token.key)) {
        throw errorWith(
          'CTN_DUPLICATE',
          `Provider for ${describeToken(provider.token)} is registered twice`,
          'use `override` for test substitutions; production graphs must be unambiguous',
          { token: describeToken(provider.token) },
        );
      }
      this.#registrations.set(provider.token.key, {
        provider,
        state: 'pending',
        instance: undefined,
        pending: null,
        instantiations: 0,
        leakReported: false,
      });
    }
  }

  /** Replaces an existing registration. Intended for tests only. */
  override(provider: Provider<unknown>): void {
    this.#assertUsable('override');
    if (!this.#registrations.has(provider.token.key)) {
      throw errorWith(
        'CTN_OVERRIDE_UNKNOWN',
        `Cannot override ${describeToken(provider.token)}: it is not registered`,
        'an override that matches no provider is almost always a typo in the token',
        { token: describeToken(provider.token) },
      );
    }
    this.#registrations.set(provider.token.key, {
      provider,
      state: 'pending',
      instance: undefined,
      pending: null,
      instantiations: 0,
      leakReported: false,
    });
  }

  has(token: Token<unknown>): boolean {
    return this.#registrations.has(token.key);
  }

  /** Descriptions of everything registered — for diagnostics, never for resolution. */
  describe(): readonly { token: string; kind: string; lifetime: string }[] {
    return [...this.#registrations.values()].map((registration) => ({
      token: describeToken(registration.provider.token),
      kind: registration.provider.kind,
      lifetime: registration.provider.lifetime,
    }));
  }

  // ── Resolution ────────────────────────────────────────────────────────────

  resolve<T>(token: Token<T>): T {
    this.#assertUsable('resolve');
    const value = this.#resolve(token, [], undefined);
    if (isThenable(value)) {
      throw errorWith(
        'CTN_ASYNC_PROVIDER',
        `${describeToken(token)} resolves asynchronously`,
        'use `resolveAsync` at this boundary (bootstrap, job start, CLI command)',
        { token: describeToken(token) },
      );
    }
    return value as T;
  }

  async resolveAsync<T>(token: Token<T>): Promise<T> {
    this.#assertUsable('resolveAsync');
    const value = await this.#resolve(token, [], undefined);
    return value as T;
  }

  // ── Scopes ────────────────────────────────────────────────────────────────

  createScope(kind: ScopeKind, id: string = crypto.randomUUID()): Scope {
    this.#assertUsable('createScope');
    const cache: ScopedCache = { values: new Map(), pending: new Map(), owned: new Map() };
    let disposed = false;

    // Arrow functions so `this` stays bound to the container.
    const resolve = <T>(token: Token<T>): T => {
      if (disposed) {
        throw errorWith('CTN_DISPOSED', `Scope ${id} is already disposed`, undefined, {
          scope: id,
        });
      }
      const value = this.#resolve(token, [], cache);
      if (isThenable(value)) {
        throw errorWith(
          'CTN_ASYNC_PROVIDER',
          `${describeToken(token)} resolves asynchronously`,
          'use `resolveAsync` for asynchronous providers',
          { token: describeToken(token) },
        );
      }
      return value as T;
    };

    const resolveAsync = async <T>(token: Token<T>): Promise<T> => {
      if (disposed) {
        throw errorWith('CTN_DISPOSED', `Scope ${id} is already disposed`, undefined, {
          scope: id,
        });
      }
      return (await this.#resolve(token, [], cache)) as T;
    };

    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      const disposables = [...cache.owned.values()].filter(hasDispose).reverse();
      cache.values.clear();
      cache.pending.clear();
      cache.owned.clear();
      await this.#disposeAll(disposables, `scope ${id}`);
    };

    return {
      id,
      kind,
      get disposed(): boolean {
        return disposed;
      },
      resolve,
      resolveAsync,
      dispose,
    };
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────

  dispose(): Promise<void> {
    this.#disposePromise ??= (async (): Promise<void> => {
      this.#disposed = true;
      const owned = [...this.#registrations.values()]
        .filter((registration) => registration.state === 'ready')
        .map((registration) => registration.instance)
        .filter(hasDispose)
        .reverse();
      this.#registrations.clear();
      await this.#disposeAll(owned, 'container');
    })();
    return this.#disposePromise;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #assertUsable(operation: string): void {
    if (this.#disposed) {
      throw errorWith(
        'CTN_DISPOSED',
        `Cannot ${operation}: the container is disposed`,
        'resolve everything you need before shutdown begins',
        undefined,
      );
    }
  }

  #resolve(
    token: Token<unknown>,
    stack: readonly Token<unknown>[],
    scope: ScopedCache | undefined,
  ): unknown {
    const registration = this.#registrations.get(token.key);

    if (registration === undefined) {
      const chain = stack.map(describeToken);
      const trail = chain.length === 0 ? '' : ` (required by ${chain.join(' → ')})`;
      throw errorWith(
        'CTN_NO_PROVIDER',
        `No provider registered for ${describeToken(token)}${this.#options.revealChain ? trail : ''}`,
        'register it in the owning module, or add a test override',
        { token: describeToken(token), depth: stack.length },
      );
    }

    if (stack.some((entry) => entry.key === token.key)) {
      const cycle = [...stack.map(describeToken), describeToken(token)];
      throw errorWith(
        'CTN_CYCLE',
        `Circular dependency: ${cycle.join(' → ')}`,
        'break the cycle with a factory that takes the collaborator late, or publish an event instead',
        { cycle: cycle.join(' → ') },
      );
    }

    if (stack.length >= this.#options.maxResolutionDepth) {
      throw errorWith(
        'CTN_DEPTH',
        `Resolution exceeded the maximum depth of ${String(this.#options.maxResolutionDepth)} at ${describeToken(token)}`,
        'a chain this deep usually means an accidental cycle through factories',
        { token: describeToken(token), maxDepth: this.#options.maxResolutionDepth },
      );
    }

    const { provider } = registration;

    if (provider.kind === 'value') {
      return provider[implSlot];
    }

    if (provider.lifetime === 'scoped') {
      if (scope === undefined) {
        throw errorWith(
          'CTN_NO_SCOPE',
          `${describeToken(token)} is scoped but was resolved outside a scope`,
          'resolve scoped providers from a request, job, or task scope',
          { token: describeToken(token) },
        );
      }
      if (scope.values.has(token.key)) return scope.values.get(token.key);
      const existing = scope.pending.get(token.key);
      if (existing !== undefined) return existing;

      const built = this.#instantiate(registration, stack, scope);
      if (isThenable(built)) {
        const promise = Promise.resolve(built).then((value) => {
          scope.values.set(token.key, value);
          scope.pending.delete(token.key);
          if (hasDispose(value)) scope.owned.set(token.key, value);
          return value;
        });
        scope.pending.set(token.key, promise);
        return promise;
      }
      scope.values.set(token.key, built);
      if (hasDispose(built)) scope.owned.set(token.key, built);
      return built;
    }

    if (provider.lifetime === 'transient') {
      return this.#instantiate(registration, stack, scope);
    }

    // singleton
    if (registration.state === 'ready') return registration.instance;
    if (registration.pending !== null) return registration.pending;

    const built = this.#instantiate(registration, stack, scope);
    if (isThenable(built)) {
      registration.pending = Promise.resolve(built).then((value) => {
        registration.instance = value;
        registration.state = 'ready';
        registration.pending = null;
        return value;
      });
      return registration.pending;
    }
    registration.instance = built;
    registration.state = 'ready';
    return built;
  }

  #instantiate(
    registration: Registration,
    stack: readonly Token<unknown>[],
    scope: ScopedCache | undefined,
  ): unknown {
    const { provider } = registration;
    const impl = provider[implSlot];
    const nextStack = [...stack, provider.token];

    const args = provider.inject.map((dependency) => this.#resolve(dependency, nextStack, scope));

    registration.instantiations += 1;
    if (
      provider.lifetime === 'transient' &&
      stack.length > 0 &&
      !registration.leakReported &&
      registration.instantiations > this.#options.transientLeakThreshold
    ) {
      registration.leakReported = true;
      this.#options.onDiagnostic({
        type: 'transient-leak',
        token: describeToken(provider.token),
        count: registration.instantiations,
      });
    }

    const callWith = (resolved: readonly unknown[]): unknown => {
      try {
        if (provider.kind === 'class') {
          const ctor = impl as new (...params: unknown[]) => unknown;
          return Reflect.construct(ctor, [...resolved]);
        }
        const factory = impl as (...params: unknown[]) => unknown;
        return factory(...resolved);
      } catch (error: unknown) {
        throw errorWith(
          'CTN_FACTORY_FAILED',
          `Provider for ${describeToken(provider.token)} failed to construct`,
          'the underlying error is attached as `cause`',
          { token: describeToken(provider.token) },
          error,
        );
      }
    };

    if (args.some(isThenable)) {
      return Promise.all(args).then((resolved) => callWith(resolved));
    }
    return callWith(args);
  }

  async #disposeAll(disposables: readonly Disposable[], owner: string): Promise<void> {
    const failures: string[] = [];
    for (const disposable of disposables) {
      const started = performance.now();
      try {
        await this.#withTimeout(
          Promise.resolve(disposable.dispose()),
          this.#options.disposalTimeoutMs,
          disposable.name,
        );
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`${disposable.name}: ${reason}`);
      }
      const elapsed = performance.now() - started;
      if (elapsed > this.#options.disposalTimeoutMs / 2) {
        this.#options.onDiagnostic({
          type: 'slow-dispose',
          name: disposable.name,
          ms: Math.round(elapsed),
        });
      }
    }
    if (failures.length > 0) {
      throw errorWith(
        'CTN_DISPOSE_FAILED',
        `${String(failures.length)} disposable(s) failed during ${owner} shutdown`,
        'fix or isolate the failing disposable; the process should still exit',
        { owner, failures: failures.length },
      );
    }
  }

  #withTimeout(promise: Promise<void>, ms: number, name: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`dispose of "${name}" exceeded ${String(ms)}ms`));
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
