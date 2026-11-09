/**
 * @tsir/testing — harness for application tests.
 *
 * The harness boots a **real** application through `defineApp.createApp`, so a
 * test exercises the same path production does. There is no test-only branch
 * inside the framework; the only test-specific affordances are deterministic
 * time/randomness and provider overrides.
 */

import { TsirError, type Provider, type Token } from '@tsir/container';
import type { ConfigSpec } from '@tsir/config';
import type { App, Clock, ModuleDefinition, Random, TsirApp } from '@tsir/core';
import { beginHandleTracking, type LeakedHandle } from './handles.ts';
import { collectRouteEntries, compileRoutes, routeModules, type RouteTable } from '@tsir/router';

export interface TestApp {
  readonly app: App<unknown>;
  /** Resolves from the container. Tests only — application code never does this. */
  get<T>(token: Token<T>): T;
  /**
   * The route table for one module (`MOD-006`), or the union of everything
   * declared when called without a name.
   *
   * A handler built from a single module's table cannot accidentally answer with
   * a neighbour's route, which is what makes a per-module test an actual test of
   * that module:
   *
   * ```ts
   * const harness = await createTestApp(app, { only: ['users'] });
   * const handler = createFetchHandler(harness.routes('users'));
   * ```
   */
  routes(name: string): RouteTable;
  routes(): RouteTable;
  dispose(): Promise<void>;
}

export interface CreateTestAppOptions {
  readonly overrides?: readonly Provider<unknown>[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly clock?: Clock;
  readonly random?: Random;
  /**
   * Boot only these modules, by name (`MOD-006`).
   *
   * Names are resolved against the modules the application actually declares, so
   * `only` can narrow a test but never overstate what production runs. A name
   * with no module behind it fails loudly rather than booting an empty app.
   */
  readonly only?: readonly string[];
}

/** Names of the controllers registered at this instant. Used by the leak check. */
function registeredControllers(): readonly unknown[] {
  return collectRouteEntries().map((entry) => entry.controller);
}

export async function createTestApp<S extends ConfigSpec>(
  app: TsirApp<S>,
  options: CreateTestAppOptions = {},
): Promise<TestApp> {
  // Snapshot before boot: registration is declaration-time, so a controller that
  // appears while the app runs is a leak, not a feature (`MOD-004`).
  const before = registeredControllers();
  // Timers started from here until dispose belong to this app (TST-007).
  const endHandles = beginHandleTracking();

  let created: App;
  try {
    created = await app.createApp({
      mode: 'test',
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.only === undefined ? {} : { modules: selectorFor(options.only) }),
    });
  } catch (error: unknown) {
    endHandles();
    throw error;
  }

  // Scope everything to the modules *this* app declares: another fixture in the
  // same process may declare a module with the same name and must not bleed in.
  const booted = new Set(
    app.modulesFor(
      app.load({ mode: 'test', ...(options.env === undefined ? {} : { env: options.env }) }),
    ),
  );
  const named = new Map(
    routeModules()
      .filter((declared) => booted.has(declared.module))
      .map((declared) => [declared.module.name, declared]),
  );
  const scope = [...named.values()];

  /**
   * The module's own table, or everything this app declares.
   *
   * Declared as a local function, not a method on the returned object: a method body is a closure
   * over that object's *own* properties, so `routes` resolved `scope` and `named` to
   * `this.scope`/`this.named`... which for an object literal means the properties of the literal,
   * read before the literal finished evaluating. The observable symptom was a silent one:
   * `routes('home')` threw `TEST_UNKNOWN_MODULE` with "declared modules: (none)" while `routes()`
   * answered with an empty table — a per-module test that proved nothing.
   */
  function routes(name?: string): RouteTable {
    if (name === undefined) return compileRoutes(collectRouteEntries(scope));
    const declared = named.get(name);
    if (declared === undefined) {
      throw new TsirError('TEST_UNKNOWN_MODULE', `no route module named "${name}"`, {
        kind: 'internal',
        hint: `declared modules: ${[...named.keys()].join(', ') || '(none)'}`,
        context: { module: name },
      });
    }
    return declared.routes();
  }

  return {
    app: created,
    get<T>(token: Token<T>): T {
      return created.container.resolve(token);
    },
    routes,
    async dispose(): Promise<void> {
      const after = registeredControllers();
      const added = after.filter((controller) => !before.includes(controller));
      if (added.length > 0) {
        endHandles();
        throw new TsirError(
          'TEST_ROUTE_LEAK',
          `${String(added.length)} controller(s) registered after boot: ${controllerNames(added)}`,
          {
            kind: 'internal',
            hint: 'register controllers by importing them; a module that registers during boot leaks into the next test',
            context: { count: added.length },
          },
        );
      }
      let leaked: readonly LeakedHandle[] = [];
      try {
        await created.shutdown('manual');
      } finally {
        leaked = endHandles();
      }
      if (leaked.length > 0) {
        const summary = leaked
          .map((handle) => `${handle.kind} (${String(handle.delayMs)} ms)`)
          .join(', ');
        throw new TsirError(
          'TEST_HANDLE_LEAK',
          `${String(leaked.length)} timer(s) still running after dispose: ${summary}`,
          {
            kind: 'internal',
            hint: "stop the timer in the module's shutdown hook, or call unref() if it must not keep the process alive",
            context: { count: leaked.length },
          },
        );
      }
    },
  };
}

/** Turns `only` into the filter `createApp` applies to the resolved module set. */
function selectorFor(
  only: readonly string[],
): (modules: readonly ModuleDefinition[]) => readonly ModuleDefinition[] {
  const wanted = new Set(only);
  return (modules) => {
    const selected = modules.filter((module) => wanted.has(module.name));
    const missing = only.filter((name) => !modules.some((module) => module.name === name));
    if (missing.length > 0) {
      throw new TsirError(
        'TEST_UNKNOWN_MODULE',
        `the application declares no module named ${missing.map((name) => `"${name}"`).join(', ')}`,
        {
          kind: 'internal',
          hint: `declared modules: ${modules.map((module) => module.name).join(', ') || '(none)'}`,
          context: { module: missing[0] ?? '' },
        },
      );
    }
    return selected;
  };
}

function controllerNames(controllers: readonly unknown[]): string {
  return controllers.map((controller) => (controller as { name?: string }).name ?? '?').join(', ');
}

/** A clock that never advances unless told to. */
export interface FixedClock extends Clock {
  advance(ms: number): void;
  set(iso: string): void;
}

export function fixedClock(start = '2026-01-01T00:00:00.000Z'): FixedClock {
  let current = new Date(start).getTime();
  let monotonic = 0;
  return {
    now: () => new Date(current),
    iso: () => new Date(current).toISOString(),
    monotonicMs: () => monotonic,
    advance: (ms: number) => {
      current += ms;
      monotonic += ms;
    },
    set: (iso: string) => {
      current = new Date(iso).getTime();
    },
  };
}

/** Deterministic PRNG (mulberry32) — the same seed always yields the same sequence. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  const nextFloat = (): number => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };

  return {
    next: nextFloat,
    uuid: () => {
      const bytes = new Uint8Array(16);
      for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(nextFloat() * 256);
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    bytes: (length: number) => {
      const buffer = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) buffer[index] = Math.floor(nextFloat() * 256);
      return buffer;
    },
  };
}

/** A deterministic id source (TST-005). Same seed and prefix give the same ids, in the same order. */
export interface IdGenerator {
  /** The next id, `<prefix>_<32 hex digits>`. */
  next(): string;
  /** Starts the sequence again, so a fixture can be rebuilt with identical ids. */
  reset(): void;
}

/**
 * Ids for fixtures that must not change between runs (TST-005). Built on `seededRandom`, so a
 * failing test prints the same ids on every run and snapshots stay stable.
 */
export function seededIds(seed: number, prefix = 'id'): IdGenerator {
  let random = seededRandom(seed);
  return {
    next(): string {
      return `${prefix}_${random.uuid().replaceAll('-', '')}`;
    },
    reset(): void {
      random = seededRandom(seed);
    },
  };
}

/**
 * Asserts that a promise rejects with a specific Tsir error code.
 * Asserting on the code (not the message) keeps tests honest when wording changes.
 */
export async function expectTsirError(run: () => unknown, code: string): Promise<TsirError> {
  try {
    await run();
  } catch (error: unknown) {
    if (!(error instanceof TsirError)) {
      throw new Error(`expected TsirError "${code}", received ${String(error)}`);
    }
    if (error.code !== code) {
      throw new Error(`expected TsirError "${code}", received "${error.code}" (${error.message})`);
    }
    return error;
  }
  throw new Error(`expected TsirError "${code}", but nothing was thrown`);
}

export { TsirError };

export * from './client.ts';
export * from './network.ts';
export * from './handles.ts';
