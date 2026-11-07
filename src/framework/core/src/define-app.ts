/**
 * `defineApp` — the contract between an application and the tooling.
 *
 * An application file exports one of these. The CLI (`tsir dev`, `tsir build`,
 * `tsir config:dump`) and the test harness both go through it, so there is a
 * single boot path and no test-only branch inside the framework.
 *
 *   // src/app.ts
 *   export default defineApp({
 *     name: 'minimal',
 *     config: spec,
 *     modules: (config) => [httpModule(config)],
 *   });
 */

import {
  defineConfig,
  loadConfig,
  type ConfigSpec,
  type EnvRecord,
  type InferConfig,
  type LoadedConfig,
} from '@tsir/config';
import type { Provider } from '@tsir/container';

import { bootstrap } from './bootstrap.ts';
import { createManifest, type AppManifest } from './manifest.ts';
import type { ModuleDefinition } from './module.ts';
import type { App, AppDiagnosticEvent } from './types.ts';

export type AppMode = 'development' | 'production' | 'test';

/** Either a fixed module list or a factory that reads typed configuration. */
export type ModuleFactory<TConfig> =
  readonly ModuleDefinition[] | ((config: LoadedConfig<TConfig>) => readonly ModuleDefinition[]);

export interface DefineAppOptions<S extends ConfigSpec = Record<string, never>> {
  readonly name: string;
  /** Application config spec. Optional — defaults to an empty spec (`{}`) when omitted.
   *
   * Modules may extend it with `moduleConfig(appConfig, { ... })`.
   */
  readonly config?: S;
  readonly modules: ModuleFactory<InferConfig<S>>;
  /** Extra capability declarations applied to every module set. */
  readonly shutdownTimeoutMs?: number;
}

export interface CreateAppOptions {
  readonly mode?: AppMode;
  /** Environment overrides for tests and the CLI; never used to bypass validation. */
  readonly env?: EnvRecord;
  readonly overrides?: readonly Provider<unknown>[];
  readonly manifest?: AppManifest;
  readonly signal?: AbortSignal;
  readonly onDiagnostic?: (event: AppDiagnosticEvent) => void;
  /**
   * Root-level per-module defaults from the project file (`tsir.js`).
   * Lowest precedence: env > module default > app default > these.
   */
  readonly moduleDefaults?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Narrows the resolved module set — a **filter**, never a replacement.
   *
   * `MOD-006`: a test boots one module without booting the neighbours it does not
   * exercise. It receives what `modulesFor` produced, so a filter can only remove
   * modules the application actually declares; it cannot introduce one the
   * production path does not have, which is what keeps a narrowed test honest.
   */
  readonly modules?: (modules: readonly ModuleDefinition[]) => readonly ModuleDefinition[];
}

/**
 * The typed handle an application file exports. `InferConfig<S>` is threaded
 * through deliberately: `app.load().values.APP_ENV` stays a literal union in
 * application code, and a module factory receives the validated config rather
 * than `unknown`. Erasing it to `unknown` here would push a cast into every
 * caller — which is the one place a cast is least affordable.
 */
export interface TsirApp<S extends ConfigSpec = Record<string, never>> {
  readonly name: string;
  readonly configSpec: S;
  /** Loads and validates configuration without booting the application. */
  load(options?: Pick<CreateAppOptions, 'env' | 'mode'>): LoadedConfig<InferConfig<S>>;
  /** Resolves the module set for a given configuration. */
  modulesFor(config: LoadedConfig<InferConfig<S>>): readonly ModuleDefinition[];
  /** Boots the application through the single bootstrap path. */
  createApp(options?: CreateAppOptions): Promise<App<InferConfig<S>>>;
  /** Builds the manifest consumed by production boot. */
  manifest(options?: Pick<CreateAppOptions, 'env'>): AppManifest;
}

export function defineApp<S extends ConfigSpec = Record<string, never>>(
  options: DefineAppOptions<S>,
): TsirApp<S> {
  const spec = (options.config ?? defineConfig({})) as S;
  const loadFor = (input?: { env?: EnvRecord; mode?: AppMode }): LoadedConfig<InferConfig<S>> => {
    const mode = input?.mode ?? 'development';
    const loaded = loadConfig(spec, {
      appName: options.name,
      ...(input?.env === undefined ? {} : { env: input.env }),
      strictEnv: mode === 'production',
    });
    return loaded;
  };

  const modulesFor = (config: LoadedConfig<InferConfig<S>>): readonly ModuleDefinition[] =>
    typeof options.modules === 'function' ? options.modules(config) : options.modules;

  return {
    name: options.name,
    configSpec: spec,
    load: loadFor,
    modulesFor,
    manifest: (input) => {
      const config = loadFor(input);
      return createManifest(options.name, modulesFor(config), new Date().toISOString());
    },
    createApp: async (createOptions: CreateAppOptions = {}) => {
      const mode = createOptions.mode ?? 'development';
      const config = loadFor({
        mode,
        ...(createOptions.env === undefined ? {} : { env: createOptions.env }),
      });
      const declared = modulesFor(config);
      const modules =
        createOptions.modules === undefined ? declared : createOptions.modules(declared);

      return bootstrap({
        appName: options.name,
        appSpec: spec,
        config,
        ...(createOptions.env === undefined ? {} : { env: createOptions.env }),
        ...(createOptions.moduleDefaults === undefined
          ? {}
          : { moduleDefaults: createOptions.moduleDefaults }),
        modules,
        mode,
        ...(options.shutdownTimeoutMs === undefined
          ? {}
          : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
        ...(createOptions.overrides === undefined ? {} : { overrides: createOptions.overrides }),
        ...(createOptions.manifest === undefined ? {} : { manifest: createOptions.manifest }),
        ...(createOptions.signal === undefined ? {} : { signal: createOptions.signal }),
        ...(createOptions.onDiagnostic === undefined
          ? {}
          : { onDiagnostic: createOptions.onDiagnostic }),
      });
    },
  };
}
