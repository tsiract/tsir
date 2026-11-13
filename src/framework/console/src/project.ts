/**
 * Project discovery and loading.
 *
 * `tsir.js` is the canonical project file.
 * Phase 1 implements the subset needed to find and boot an application:
 * `app.name`, `app.entry`, and optional `console` settings. Unknown keys are
 * refused with a suggestion (CFG_UNKNOWN_KEY) unless the file sets `strict: false`.
 * Registries are checked before the zod shape (CFG-121).
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative as relativePath, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { TsirError } from '@tsir/container';
import { applyPresets, checkProjectFile, presetModuleError, presetModules } from '@tsir/config';

import type { AppManifest, CreateAppOptions, TsirApp } from '@tsir/core';
import { z } from '@tsir/validate';

import { CliError } from './output.ts';

export const CONFIG_CANDIDATES = ['tsir.config.js', 'tsir.js', 'tsir.mjs'] as const;

/** A literal, or `{ fromEnv: 'NAME' }` — the shape every secret in `tsir.js` uses. */
const envRef = z.union([z.string().min(1), z.object({ fromEnv: z.string().min(1) })]);

const projectSchema = z.object({
  // CFG-113: the packages the app uses. Each must be installed, or the load refuses with the bun add line.
  modules: z.array(z.string()).optional(),
  // Root-level per-module defaults (tsir.js modules.<name>). Lowest precedence.
  moduleDefaults: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  app: z.object({
    name: z.string().min(1),
    entry: z.string().min(1),
  }),
  console: z
    .object({
      commands: z.array(z.string()).optional(),
    })
    .optional(),
  // The deploy block. Every key is optional: a project that
  // never deploys to a cloud target needs no deploy section at all, and `deploy:plan`
  // still resolves the default (`separate`) topology from what the app declares.
  deploy: z
    .object({
      topology: z.enum(['separate', 'single']).optional(),
      includeModules: z.array(z.string()).optional(),
      units: z
        .array(
          z.object({
            name: z.string().min(1),
            kind: z.enum(['http', 'ws', 'queue', 'schedule', 'admin', 'migrate']),
            triggers: z
              .array(
                z.object({
                  kind: z.enum(['http', 'websocket', 'queue', 'cron', 'manual']),
                  detail: z.array(z.string()),
                }),
              )
              .optional(),
            modules: z.array(z.string()).optional(),
            requires: z
              .array(
                z.enum([
                  'node-compat',
                  'raw-sockets',
                  'filesystem',
                  'durable-state',
                  'background-tasks',
                  'subprocesses',
                  'long-running-process',
                ]),
              )
              .optional(),
            bindings: z
              .array(
                z.object({
                  kind: z.enum([
                    'hyperdrive',
                    'queue',
                    'kv',
                    'r2',
                    'd1',
                    'durable-object',
                    'secret',
                    'var',
                  ]),
                  name: z.string().min(1),
                  resource: z.string().optional(),
                }),
              )
              .optional(),
            private: z.boolean().optional(),
            memoryMb: z.number().int().positive().optional(),
            timeoutSeconds: z.number().int().positive().optional(),
          }),
        )
        .optional(),
      publishes: z.array(z.string().min(1)).optional(),
      invokes: z
        .array(
          z.object({
            unit: z.string().min(1),
            task: z.string().min(1),
          }),
        )
        .optional(),
      targets: z
        .partialRecord(
          z.enum(['bun', 'cloudflare', 'lambda']),
          z.object({
            bindings: z
              .record(z.string(), z.object({ kind: z.string(), resource: z.string().optional() }))
              .optional(),
            sizeBudget: z.number().int().positive().optional(),
            // `wrangler.toml` knobs (`DPL-009`). The date is pinned here rather than in the
            // emitter so a project that needs a newer one says so in review.
            compatibilityDate: z.string().optional(),
            compatibilityFlags: z.array(z.string()).optional(),
            // Non-secret configuration. Secrets are `wrangler secret put`, never `[vars]`.
            vars: z.record(z.string(), z.string()).optional(),
            // `template.<unit>.yaml` knobs (`DPL-016`). Defaults are the framework's, not
            // AWS's smallest: 1024 MB / 30 s / arm64 / nodejs22.x, per `08-deploy.md § 3.2`.
            runtime: z.string().optional(),
            memoryMb: z.number().int().positive().optional(),
            timeoutSeconds: z.number().int().positive().optional(),
            architecture: z.enum(['x86_64', 'arm64']).optional(),
            region: z.string().optional(),
            // Custom domain the unit serves. Cloudflare emits a `routes` entry;
            // Lambda emits a `DomainName` parameter for API Gateway / ALB wiring.
            domain: z.string().optional(),
            zone: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  // Named connections (ADR-0019). The CLI reads this much of
  // the block: a connection with a journal becomes a `migrate:<name>` unit (`DPL-021`).
  database: z
    .object({
      default: z.string().min(1).optional(),
      connections: z
        .record(
          z.string(),
          z.object({
            driver: z.enum(['d1', 'postgres', 'mysql']),
            binding: z.string().optional(),
            url: z.object({ fromEnv: z.string() }).optional(),
            // `false` for a replica that must not gate a release (ADR-0019 § 4). Default true:
            // a connection someone declared almost always has a journal.
            journal: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  // Named cache stores (ADR-0019 shape). `driver` is a
  // string, not an enum, so an unknown name fails in `@tsir/cache` with `CAP_DRIVER_MISSING`
  // listing the drivers this build actually ships — a message a person can act on, instead of
  // a schema union of names that a future phase has to keep editing.
  cache: z
    .object({
      default: z.string().min(1).optional(),
      stores: z
        .record(
          z.string(),
          z.object({
            driver: z.string().min(1),
            /** Which connection/binding backs it (`database`, `redis`, `cloudflare-kv`). */
            connection: z.string().optional(),
            table: z.string().optional(),
            tagTable: z.string().optional(),
            prefix: z.string().optional(),
            roundTtlUp: z.boolean().optional(),
            ttlMs: z.number().int().positive().optional(),
            required: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  // Named queue connections (ADR-0019 shape). `driver` is a
  // string for the same reason `cache.stores[*].driver` is: an unknown name fails in
  // `@tsir/queue` with `CAP_DRIVER_MISSING` listing the drivers this build ships.
  queue: z
    .object({
      default: z.string().min(1).optional(),
      connections: z
        .record(
          z.string(),
          z.object({
            driver: z.string().min(1),
            /** Which database connection backs a `database` queue. */
            connection: z.string().optional(),
            table: z.string().optional(),
            deadTable: z.string().optional(),
            /** The transactional outbox is mandatory for non-transactional drivers. */
            outbox: z.boolean().optional(),
            required: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  // Named storage disks (ADR-0019 shape). `driver` is a string
  // for the same reason the cache and queue drivers are: an unknown name fails in `@tsir/storage`
  // with `STO_DRIVER_MISSING` listing the drivers this build ships.
  storage: z
    .object({
      default: z.string().min(1).optional(),
      disks: z
        .record(
          z.string(),
          z.object({
            driver: z.string().min(1),
            root: z.string().optional(),
            bucket: z.string().optional(),
            region: z.string().optional(),
            endpoint: z.string().optional(),
            publicBaseUrl: z.string().optional(),
            forcePathStyle: z.boolean().optional(),
            credentials: z
              .object({
                accessKeyId: envRef.optional(),
                secretAccessKey: envRef.optional(),
                sessionToken: envRef.optional(),
              })
              .optional(),
            temporaryUrlTtlMs: z.number().int().positive().optional(),
            required: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  // Named mailers (`MAIL-9`). `driver` is a string for the same
  // reason the cache, queue and storage drivers are: an unknown name fails in `@tsir/mail` with
  // `MAIL_DRIVER_MISSING` listing the drivers this build ships.
  mail: z
    .object({
      default: z.string().min(1).optional(),
      mailers: z
        .record(
          z.string(),
          z.object({
            driver: z.string().min(1),
            from: z
              .union([
                z.string().min(3),
                z.object({ email: z.string().min(3), name: z.string().optional() }),
              ])
              .optional(),
            replyTo: z.string().optional(),
            apiKey: envRef.optional(),
            serverToken: envRef.optional(),
            messageStream: z.string().optional(),
            binding: z.string().optional(),
            region: z.string().optional(),
            credentials: z
              .object({
                accessKeyId: envRef.optional(),
                secretAccessKey: envRef.optional(),
                sessionToken: envRef.optional(),
              })
              .optional(),
            host: z.string().optional(),
            port: z.number().int().positive().optional(),
            secure: z.boolean().optional(),
            user: z.string().optional(),
            password: envRef.optional(),
            endpoint: z.string().optional(),
            required: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  // Notification channels. A named channel per destination, each
  // with the driver that reaches it — and every secret as an `envRef`, never a literal, exactly as
  // the mailers above. `allowHosts` is required for `webhook` because the URL comes from data.
  notify: z
    .object({
      channels: z
        .record(
          z.string(),
          z.object({
            driver: z.string().min(1),
            mailer: z.string().optional(),
            table: z.string().optional(),
            allowHosts: z.array(z.string().min(1)).optional(),
            secret: envRef.optional(),
            allowHttp: z.boolean().optional(),
            headers: z.record(z.string(), z.string()).optional(),
            provider: z.string().optional(),
            url: envRef.optional(),
            accountSid: envRef.optional(),
            authToken: envRef.optional(),
            from: z.string().optional(),
            endpoint: z.string().optional(),
            timeoutMs: z.number().int().positive().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  // The broadcaster (`CAP-014`). `driver` is a string for the reason every driver here is: an
  // unknown name fails in `@tsir/broadcast` with `CAP_DRIVER_MISSING` listing what this build
  // ships. `broadcast` reads this block, and reading it is what lets the production check refuse
  // `memory` — a broadcaster constructed in `app.ts` never passes through a guard at all.
  broadcast: z
    .object({
      default: z.string().min(1).optional(),
      connections: z
        .record(
          z.string(),
          z.object({
            driver: z.string().min(1),
            connection: z.string().optional(),
            prefix: z.string().optional(),
            required: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  // The search engine (`CAP-015`). The hosted three take a host and a collection and a key; the
  // SQL two take a connection name and borrow the database port's own query function.
  search: z
    .object({
      default: z.string().min(1).optional(),
      engines: z
        .record(
          z.string(),
          z.object({
            driver: z.string().min(1),
            connection: z.string().optional(),
            collection: z.string().optional(),
            host: z.string().optional(),
            apiKey: envRef.optional(),
            searchApiKey: envRef.optional(),
            required: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  // Media adapters (`CAP-017`). Named per destination, because a project usually wants images at
  // one service and video at another; the first declared adapter of each kind is the default.
  media: z
    .object({
      default: z.string().min(1).optional(),
      adapters: z
        .record(
          z.string(),
          z.object({
            driver: z.string().min(1),
            accountId: z.string().optional(),
            apiToken: envRef.optional(),
            cloudName: z.string().optional(),
            uploadPreset: z.string().optional(),
            publicKey: z.string().optional(),
            privateKey: envRef.optional(),
            urlEndpoint: z.string().optional(),
            imageVariant: z.string().optional(),
            defaultFormat: z.string().optional(),
            defaultQuality: z.number().int().positive().optional(),
            ffmpegPath: z.string().optional(),
            required: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  // The scheduler's lock. One lock for the project, because
  // a scheduler takes one provider — and `driver` is a string for the same reason the cache and
  // queue drivers are: an unknown name is a message that lists the real ones.
  schedule: z
    .object({
      lock: z
        .object({
          driver: z.string().min(1),
          /** Which database connection backs a `database` lock. */
          connection: z.string().optional(),
          table: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  paths: z
    .object({
      controllers: z.array(z.string()).optional(),
      routes: z.string().optional(),
      /** Where `drizzle-kit` writes migrations; defaults to `drizzle`. */
      migrations: z.string().optional(),
      seeders: z.string().optional(),
    })
    .optional(),
});

export type ProjectConfig = z.infer<typeof projectSchema>;

export interface LoadedProject {
  readonly root: string;
  readonly configPath: string;
  readonly config: ProjectConfig;
  readonly entryPath: string;
  readonly app: TsirApp<never>;
  /**
   * The entry module's own exports — `queues`, `jobs`, `database`, `events`, …
   *
   * Kept from the import the loader already performs, because "does this project export an
   * events registry?" is a question the deploy graph has to answer and re-importing the entry to
   * ask it would be a second import of code with import-time side effects (`RTR_DUPLICATE`).
   */
  readonly exports: Readonly<Record<string, unknown>>;
}

/**
 * The files that identify a distribution root (`make dist`). `manifest.json` is
 * generated only by the dist build, and `framework/console/package.json` proves
 * the framework was emitted — a plain app directory has neither.
 */
const DIST_MARKERS = ['manifest.json', 'framework/console/package.json'] as const;

/**
 * Walks up from `startDir` looking for a Tsir distribution root. Returns the
 * root path, or `undefined` when the start directory is not inside a dist.
 *
 * Used so commands that fail for lack of a project can give a dist-aware hint:
 * the distribution ships runnable examples under `apps/`, and a new
 * application must be created from outside the dist (the next `make dist` wipes
 * everything under it).
 */
export function findDistRoot(startDir: string): string | undefined {
  let current = resolve(startDir);
  for (;;) {
    if (DIST_MARKERS.every((marker) => existsSync(join(current, marker)))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * The hint for "no tsir.js found". When the working directory sits inside a
 * distribution, the generic hint is actively misleading: `tsir bootstrap` has
 * nothing to edit and `tsir new` is refused inside the dist. Point instead at
 * the bundled examples and the correct place to run `tsir new`.
 */
function noConfigHint(startDir: string): string {
  const dist = findDistRoot(startDir);
  if (dist === undefined) {
    return 'run `tsir bootstrap` inside an existing application, or `tsir new <name>` to scaffold one';
  }
  const launcher = join(dist, 'tsir');
  const rel = (path: string): string => {
    const r = relativePath(startDir, path);
    return r === '' ? '.' : r;
  };
  const examples = ['frontpage']
    .filter((name) => existsSync(join(dist, 'apps', name, 'tsir.js')))
    .map((name) => rel(join(dist, 'apps', name)));
  const exampleHint =
    examples.length === 0
      ? ''
      : `to test the bundled modules, run ${rel(launcher)} dev --app ${examples[0] ?? 'apps/frontpage'} · `;
  return `${exampleHint}to create an app, cd out of the distribution and run ${launcher} new <name>`;
}

export function findConfigFile(startDir: string): string {
  let current = resolve(startDir);
  const found: string[] = [];

  for (;;) {
    const matches = CONFIG_CANDIDATES.map((candidate) => join(current, candidate)).filter((path) =>
      existsSync(path),
    );
    if (matches.length > 1) {
      throw new CliError(
        `ambiguous project configuration: ${matches.map((path) => path.slice(current.length + 1)).join(', ')}`,
        3,
        'keep exactly one of tsir.config.js / tsir.js / tsir.mjs',
        'CFG_AMBIGUOUS_CONFIG_FILE',
      );
    }
    const first = matches[0];
    if (first !== undefined) {
      found.push(first);
      return first;
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new CliError('no tsir.js found', 3, noConfigHint(startDir));
}

/** Whether a package resolves from the project root: the test a preset's modules must pass. */
function isInstalled(root: string, name: string): boolean {
  try {
    createRequire(join(root, 'package.json')).resolve(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * The top-level `modules` the app declares that are not installed (`CFG_MODULE_NOT_INSTALLED`,
 * CFG-113). The hint is the exact `bun add` line. Duplicates are reported once.
 */
export function checkDeclaredModules(root: string, modules: readonly string[]): void {
  const missing = [...new Set(modules)].filter((name) => !isInstalled(root, name));
  if (missing.length === 0) return;
  throw new CliError(
    `tsir.js declares ${missing.length === 1 ? 'a module' : 'modules'} that ${missing.length === 1 ? 'is' : 'are'} not installed: ${missing.join(', ')}`,
    3,
    `bun add ${missing.join(' ')}`,
    'CFG_MODULE_NOT_INSTALLED',
  );
}

/**
 * Applies `presets` to a project file (`CFG-102`) and refuses a preset whose modules are not
 * installed (`CFG_PRESET_MODULE_MISSING`). The check comes first, so the error names every
 * missing package at once rather than the first one.
 */
export function resolveProjectPresets(
  root: string,
  raw: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const declared = Array.isArray(raw['presets']) ? (raw['presets'] as unknown[]) : [];
  const missing = presetModules(declared).filter((name) => !isInstalled(root, name));
  if (missing.length > 0) {
    const error = presetModuleError(missing);
    throw new CliError(error.message, 3, error.hint, error.code);
  }
  try {
    return applyPresets(raw);
  } catch (error: unknown) {
    if (error instanceof TsirError) throw new CliError(error.message, 3, error.hint, error.code);
    throw error;
  }
}

export async function loadProject(cwd: string): Promise<LoadedProject> {
  const configPath = findConfigFile(cwd);
  const root = dirname(configPath);

  let module: unknown;
  try {
    module = await import(`${pathToFileURL(configPath).href}?t=${String(Date.now())}`);
  } catch (error: unknown) {
    throw new CliError(
      `could not load ${configPath.slice(root.length + 1)}: ${error instanceof Error ? error.message : String(error)}`,
      3,
      'the project configuration must be a valid ES module',
    );
  }

  const exported = (module as { default?: unknown }).default;
  // The checks run on the effective file: a preset's defaults (CFG-122, for example a default
  // database connection) are part of the configuration, so they are checked like any other key.
  const effective =
    typeof exported === 'object' && exported !== null && !Array.isArray(exported)
      ? resolveProjectPresets(root, exported as Readonly<Record<string, unknown>>)
      : exported;
  if (typeof effective === 'object' && effective !== null && !Array.isArray(effective)) {
    checkProjectFile(effective as Readonly<Record<string, unknown>>);
  }
  const declared =
    typeof effective === 'object' &&
    effective !== null &&
    Array.isArray((effective as { modules?: unknown }).modules)
      ? (effective as { modules: unknown[] }).modules.filter(
          (name): name is string => typeof name === 'string',
        )
      : [];
  checkDeclaredModules(root, declared);
  const parsed = projectSchema.safeParse(effective);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CliError(
      `invalid project configuration at ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'unknown error'}`,
      3,
      'expected { app: { name, entry } }',
      'CFG_INVALID',
    );
  }

  const entryPath = resolve(root, parsed.data.app.entry);
  if (!existsSync(entryPath)) {
    throw new CliError(
      `application entry not found: ${parsed.data.app.entry}`,
      3,
      'check `app.entry` in tsir.js; it is resolved relative to the project root',
    );
  }

  let entryModule: unknown;
  try {
    // **No cache-buster here, deliberately.** The application entry has import-time side
    // effects — decorators register controllers — so importing it twice in one process
    // registers every route twice and `compileRoutes` correctly reports `RTR_DUPLICATE`.
    // `tsir.js` above *is* re-imported fresh because it is data: a config edit should be
    // visible without a restart. The entry is code: once per process.
    entryModule = await import(pathToFileURL(entryPath).href);
  } catch (error: unknown) {
    throw new CliError(
      `could not load application entry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const entry: Record<string, unknown> = { ...(entryModule as Record<string, unknown>) };
  const app = entry['default'];
  const isTsirApp =
    typeof app === 'object' &&
    app !== null &&
    'createApp' in app &&
    typeof app.createApp === 'function';

  if (!isTsirApp) {
    throw new CliError(
      `application entry must default-export defineApp({...}): ${parsed.data.app.entry}`,
      3,
      'see src/framework/core/src/define-app.ts for the contract',
    );
  }

  return {
    root,
    configPath,
    config: parsed.data,
    entryPath,
    app: app as TsirApp<never>,
    exports: entry,
  };
}

export interface BootedProject {
  readonly project: LoadedProject;
  readonly app: Awaited<ReturnType<TsirApp<never>['createApp']>>;
}

export async function bootProject(
  project: LoadedProject,
  options: CreateAppOptions,
): Promise<BootedProject> {
  const manifestPath = join(project.root, '.tsir', 'manifest.json');

  let manifest: AppManifest | undefined;
  if (existsSync(manifestPath)) {
    manifest = (await Bun.file(manifestPath).json()) as AppManifest;
  }

  const app = await project.app.createApp({
    ...options,
    ...(project.config.moduleDefaults === undefined
      ? {}
      : { moduleDefaults: project.config.moduleDefaults }),
    ...(manifest === undefined || options.mode !== 'production' ? {} : { manifest }),
  });

  return { project, app };
}
