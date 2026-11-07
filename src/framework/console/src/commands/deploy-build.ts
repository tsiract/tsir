/**
 * `tsir deploy:build` — the emitter (`DPL-009`, `DPL-014`, `DPL-018`).
 *
 * The graph says *what* will be deployed; this file writes it down. Three decisions shape
 * everything below:
 *
 *   · **One bundle per unit, and no `fetch` export it did not ask for.** The adapter
 *     (`@tsir/deploy/cloudflare`, `@tsir/deploy/lambda`) decides which exports a unit has,
 *     and the generated entry passes only the handlers the unit's triggers name. A queue
 *     unit is a queue unit because its bundle has no `fetch` in it (`§ 3.1`, `§ 8`).
 *   · **The generated entry is a seam, not a second application.** It imports the entry
 *     module the developer already wrote and hands `handler` / `queue` / `scheduled` to the
 *     adapter. Nothing about the request pipeline changes between `deploy:invoke`, a Worker
 *     and a Lambda, because all three call the same function.
 *   · **The artifact is described by data.** `dist/build.json` lists every file, its bytes,
 *     its gzipped bytes and the budget it is measured against, so a release gate reads a
 *     file instead of re-deriving the build (`DPL-019`). The infrastructure documents —
 *     `wrangler.<unit>.toml`, `template.<unit>.yaml` — are written next to their bundle, and
 *     are deliberately *not* applied by anything here (`§ 6`).
 *
 * Bundling is `Bun.build` in-process rather than `bun build` in a subprocess: same bundler,
 * no shell quoting, and the failure is a thrown object with the module graph's own errors.
 * That is also why this lives in `@tsir/console` and not in `@tsir/deploy` — the deploy
 * package stays runtime-agnostic and bundle-safe for the very targets it emits for.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import type { DeployTarget } from '@tsir/core';
import {
  buildGraph,
  classMissing,
  invalidDeployConfig,
  serializeGraph,
  unitEmpty,
  unsupportedTarget,
  type GraphProblem,
  type TargetConfig,
  type Unit,
  type UnitGraph,
  GRAPH_FILE,
} from '@tsir/deploy';
import { samTemplate } from '@tsir/deploy/sam';
import { migrationFolder } from '@tsir/migrate';

import {
  MIGRATE_FILE,
  migratePlan,
  migrateScriptSource,
  migrateSpec,
  type MigrateConnectionConfig,
} from './deploy-migrate.ts';
import {
  DEFAULT_COMPATIBILITY_DATE,
  wranglerToml,
  type BindingResource,
} from '@tsir/deploy/wrangler';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { EXIT, fail, info, style, UsageError, warn, jsonDocument } from '../output.ts';
import { targetsOf, loadDeployInput } from './deploy.ts';

/** Where the artifacts go, relative to the project root. */
export const DEFAULT_OUT_DIR = 'dist';

/** The build's own document: what was emitted, how big, against which budget. */
export const BUILD_FILE = 'build.json';
export const BUILD_SCHEMA_VERSION = 1;

/**
 * Generated entries are written here and deleted afterwards.
 *
 * They are not artifacts — they are the thin wrapper the adapter needs, and shipping them
 * would put absolute paths (and two copies of the app entry) in `dist/`.
 */
export const STAGING_DIR = join('.tsir', 'build');

/**
 * Default budget per target, in bytes of **gzipped** output.
 *
 * Workers publish a 1 MiB gzipped bundle; Lambda's 50 MiB is
 * the zipped upload limit. `bun` is a long-running process on a machine the operator owns,
 * so there is nothing to enforce — `Infinity` is the honest number.
 */
export const DEFAULT_BUDGETS: Readonly<Record<DeployTarget, number>> = {
  bun: Number.POSITIVE_INFINITY,
  cloudflare: 1_048_576,
  lambda: 52_428_800,
};

/** Warn before the wall, not at it: 80 % of the budget is where people start looking. */
export const SIZE_WARNING_RATIO = 0.8;

const TRIGGER_ORDER = ['fetch', 'queue', 'scheduled'] as const;

/** How the platform names a unit's entry points. The adapter's own vocabulary. */
export type AdapterTrigger = (typeof TRIGGER_ORDER)[number];

/** Which entry export a trigger is wired to. One contract, three names. */
export const TRIGGER_EXPORTS: Readonly<Record<AdapterTrigger, string>> = {
  fetch: 'handler',
  queue: 'queue',
  scheduled: 'scheduled',
};

const RUNTIME_TARGET: Readonly<Record<DeployTarget, 'bun' | 'browser' | 'node'>> = {
  bun: 'bun',
  // Workerd is not Node: a bundle that resolves `node:` builtins for a browser target is
  // the one that fails at `wrangler deploy` instead of at `tsir deploy:build`.
  cloudflare: 'browser',
  lambda: 'node',
};

/**
 * Which adapter triggers a unit needs, from the triggers the graph recorded.
 *
 * `websocket` is a `fetch` with an `Upgrade` header on Workers, and `admin` is HTTP with a
 * private route table, so both land on `fetch`. `manual` is the console: it is not a
 * deployable trigger and produces nothing.
 */
export function adapterTriggers(unit: Unit): readonly AdapterTrigger[] {
  const kinds = new Set(unit.triggers.map((trigger) => trigger.kind));
  const wanted = new Set<AdapterTrigger>();
  if (kinds.has('http') || kinds.has('websocket')) wanted.add('fetch');
  if (kinds.has('queue')) wanted.add('queue');
  if (kinds.has('cron')) wanted.add('scheduled');
  // Filtered through `TRIGGER_ORDER` so the export order is the adapter's, not the unit's:
  // two units with the same triggers must generate the same import line.
  return TRIGGER_ORDER.filter((trigger) => wanted.has(trigger));
}

/** The entry exports a unit needs, in the adapter's order. */
export function requiredExports(triggers: readonly AdapterTrigger[]): readonly string[] {
  return triggers.map((trigger) => TRIGGER_EXPORTS[trigger]);
}

export interface EntrySpec {
  readonly target: DeployTarget;
  readonly unit: string;
  readonly triggers: readonly AdapterTrigger[];
  /**
   * Durable Object classes the unit's bindings name (`DPL-010`).
   *
   * A `[[durable_objects.bindings]]` entry tells the platform "look for a class called Room
   * in this bundle". If the bundle does not export it, `wrangler deploy` fails — so the
   * generated entry re-exports each class from the application entry.
   */
  readonly durables?: readonly string[] | undefined;
  /**
   * Absolute path of the adapter, resolved by the CLI at build time.
   *
   * Absolute **paths**, not `file:` URLs: `Bun.build` resolves the former and refuses the
   * latter ("Could not resolve"), which is a difference worth writing down once.
   */
  readonly adapter: string;
  /** Absolute path of the application entry. */
  readonly entry: string;
}

/**
 * The generated entry module for one unit.
 *
 * Deterministic text: same unit and triggers, same bytes, so a diff of the staging
 * directory is a diff of the deploy shape. The `__`-prefixed locals exist because the
 * entry's own names are the user's — an application that exports `fetch` must not collide
 * with the adapter's destructuring.
 */
export function unitEntrySource(spec: EntrySpec): string {
  const needs = requiredExports(spec.triggers);
  const imports = spec.triggers.map((trigger) => {
    const local = `__${trigger}`;
    return `${TRIGGER_EXPORTS[trigger]} as ${local}`;
  });
  const wiring = spec.triggers.map((trigger) => `  ${trigger}: __${trigger},`).join('\n');
  const destructured = [...spec.triggers].join(', ');

  const adapterImport = spec.target === 'cloudflare' ? 'toCloudflareHandler' : 'toLambdaHandler';
  const call =
    spec.target === 'cloudflare'
      ? `toCloudflareHandler({\n  unit: ${JSON.stringify(spec.unit)},\n${wiring}\n})`
      : `toLambdaHandler({\n  unit: ${JSON.stringify(spec.unit)},\n${wiring}\n})`;

  const exported =
    spec.target === 'cloudflare'
      ? `export const { ${destructured} } = ${call};`
      : `export const handler = ${call};`;

  const durables = [...(spec.durables ?? [])].sort();
  const reExports =
    durables.length === 0
      ? []
      : [
          '',
          `// Durable Object classes the ${JSON.stringify(spec.unit)} bindings name (DPL-010):`,
          ...durables.map((name) => `export { ${name} } from ${JSON.stringify(spec.entry)};`),
        ];

  return [
    `// Generated by \`tsir deploy:build\` for unit ${JSON.stringify(spec.unit)} — do not edit.`,
    `// Triggers: ${spec.triggers.join(', ')} · entry exports: ${[...needs, ...durables].join(', ')}`,
    `import { ${adapterImport} } from ${JSON.stringify(spec.adapter)};`,
    `import { ${imports.join(', ')} } from ${JSON.stringify(spec.entry)};`,
    '',
    exported,
    ...reExports,
    '',
  ].join('\n');
}

/**
 * The Bun target is not per unit.
 *
 * A container runs one process that serves everything, so the artifact is a server, not a
 * function. It calls the entry's `handler` — the same one a Worker calls — and nothing
 * else, so `make start` and `wrangler dev` exercise the same request pipeline.
 */
export function bunServerSource(entry: string): string {
  return [
    '// Generated by `tsir deploy:build` for the bun target — do not edit.',
    '// One process, one fetch handler: the long-running shape (§ 3.3).',
    `import { handler as __fetch } from ${JSON.stringify(entry)};`,
    '',
    // coercion-ok: PORT is the operator's own number, and `Bun.serve` takes one.
    'const port = Number(process.env.PORT ?? 3000);',
    'const server = Bun.serve({ port, fetch: __fetch });',
    'console.log(`tsir: listening on ${server.url.href}`);',
    '',
  ].join('\n');
}

/* ── planning ──────────────────────────────────────────────────────────────────── */

export interface BuildOptions {
  /** `--target cloudflare,lambda`; defaults to the configured targets, else `bun`. */
  readonly targets?: readonly string[] | undefined;
  readonly outDir?: string | undefined;
  readonly minify?: boolean | undefined;
  readonly allowSizeRegression?: boolean | undefined;
}

export interface ResolvedBuild {
  readonly root: string;
  /** Absolute output directory. */
  readonly outDir: string;
  /** Relative to the project root — what the report and `build.json` print. */
  readonly outDirName: string;
  readonly app: string;
  readonly topology: string;
  readonly graph: UnitGraph;
  readonly problems: readonly GraphProblem[];
  readonly targets: readonly DeployTarget[];
  readonly configured: readonly TargetConfig[];
  /** Absolute path of `app.entry`, the module every generated entry imports. */
  readonly entryPath: string;
  /** The entry's own exports. A unit name is a promise the entry has to keep. */
  readonly provided: ReadonlySet<string>;
  /** `database.connections` — driver and journal folder, per migrate unit (`DPL-021`). */
  readonly connections: Readonly<Record<string, MigrateConnectionConfig>>;
  /** `deploy.targets.cloudflare`, kept for `wrangler.*.toml` (date, flags, vars). */
  readonly cloudflare: CloudflareTargetConfig | undefined;
  /** `deploy.targets.lambda`, kept for `template.*.yaml` (runtime, memory, vars). */
  readonly lambda: LambdaTargetConfig | undefined;
  readonly minify: boolean;
  readonly allowSizeRegression: boolean;
}

interface LambdaTargetConfig {
  readonly runtime?: string | undefined;
  readonly memoryMb?: number | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly architecture?: 'x86_64' | 'arm64' | undefined;
  readonly region?: string | undefined;
  readonly vars?: Readonly<Record<string, string>> | undefined;
  /** Custom domain this unit serves (e.g. `admin.product.com`). Emitted in `template.*.yaml`. */
  readonly domain?: string | undefined;
  /** Route 53 hosted zone name (e.g. `product.com`). Defaults to the last two labels of `domain`. */
  readonly zone?: string | undefined;
}

interface CloudflareTargetConfig {
  readonly compatibilityDate?: string | undefined;
  readonly compatibilityFlags?: readonly string[] | undefined;
  readonly vars?: Readonly<Record<string, string>> | undefined;
  /** Domain the Worker serves (e.g. `admin.product.com`). Emits a `routes` entry. */
  readonly domain?: string | undefined;
  /** Cloudflare zone name (e.g. `product.com`). Defaults to the last two labels of `domain`. */
  readonly zone?: string | undefined;
}

/** What a `--target` name may be. Kept explicit so the message can list them. */
const DEPLOY_TARGETS: readonly DeployTarget[] = ['bun', 'cloudflare', 'lambda'];

export function isDeployTarget(value: string): value is DeployTarget {
  return (DEPLOY_TARGETS as readonly string[]).includes(value);
}

/**
 * Resolve the graph **and** the build's own options, without writing anything.
 *
 * Split from `emitArtifacts` so the command can refuse on graph problems before the first
 * byte lands in `dist/`: a build that fails halfway is a `dist/` that looks deployable.
 */
export async function resolveBuild(
  cwd: string,
  options: BuildOptions = {},
): Promise<ResolvedBuild> {
  const { project, input } = await loadDeployInput(cwd);
  const configured = targetsOf(project);
  const { graph, problems } = buildGraph(input, { targets: configured });

  const requested = options.targets ?? (configured.length === 0 ? ['bun'] : graph.targets);
  const targets = requested.map((target) => {
    if (!isDeployTarget(target)) throw unsupportedTarget(target, DEPLOY_TARGETS);
    return target;
  });
  if (targets.length === 0) throw invalidDeployConfig('deploy:build needs at least one target');

  // Already evaluated by `loadProject`, so this is a cache hit: importing the entry is how
  // the CLI learns what the bundle can export, and it costs nothing the second time.
  const entryModule = (await import(pathToFileURL(project.entryPath).href)) as Record<
    string,
    unknown
  >;

  const cloudflare = project.config.deploy?.targets?.cloudflare;
  const lambda = project.config.deploy?.targets?.lambda;

  // Where each connection's journal lives (`MIG-015`): the default connection keeps the
  // unqualified folder, every other one gets a subfolder named after itself.
  const connections: Record<string, MigrateConnectionConfig> = {};
  for (const [name, connection] of Object.entries(project.config.database?.connections ?? {})) {
    connections[name] = {
      driver: connection.driver,
      folder: relative(
        project.root,
        migrationFolder(project.root, name, {
          ...(project.config.paths?.migrations === undefined
            ? {}
            : { base: project.config.paths.migrations }),
          ...(project.config.database?.default === undefined
            ? {}
            : { defaultConnection: project.config.database.default }),
        }),
      ),
    };
  }
  // `--out` is a directory name by default and an absolute path when it looks like one:
  // a build machine writing outside the checkout is normal, and silently joining the two
  // would put the artifacts in `<project>/tmp/build`.
  const outDirName = options.outDir ?? DEFAULT_OUT_DIR;
  const outDir = isAbsolute(outDirName) ? outDirName : join(project.root, outDirName);

  return {
    root: project.root,
    outDir,
    outDirName,
    app: graph.app,
    topology: graph.topology,
    graph,
    problems,
    targets,
    configured,
    entryPath: project.entryPath,
    provided: new Set(Object.keys(entryModule)),
    connections,
    cloudflare,
    lambda,
    minify: options.minify ?? false,
    allowSizeRegression: options.allowSizeRegression ?? false,
  };
}

/* ── emitting ─────────────────────────────────────────────────────────────────── */

export interface Artifact {
  readonly target: DeployTarget;
  readonly unit: string;
  /** POSIX path relative to the output directory, so `build.json` is machine-portable. */
  readonly file: string;
  readonly bytes: number;
  readonly gzipBytes: number;
  /** Gzipped bytes this target allows. `Infinity` is written as `null` in the document. */
  readonly budget: number;
  readonly triggers: readonly AdapterTrigger[];
}

export interface BuildResult {
  readonly app: string;
  readonly topology: string;
  readonly outDirName: string;
  readonly targets: readonly DeployTarget[];
  readonly artifacts: readonly Artifact[];
  readonly warnings: readonly string[];
}

/** The budget for a target: declared in `tsir.js`, else the platform's own limit. */
export function budgetFor(target: DeployTarget, configured: readonly TargetConfig[]): number {
  const declared = configured.find((entry) => entry.target === target)?.sizeBudget;
  return declared ?? DEFAULT_BUDGETS[target];
}

/**
 * The adapter specifier, resolved from **this** package.
 *
 * The application under build is not required to depend on `@tsir/deploy`: it does not
 * import the adapter, the emitter does. The generated entry therefore carries the resolved
 * `file:` URL, which the bundler inlines — after the build nothing refers to it.
 */
function adapterSpecifier(target: DeployTarget): string {
  return fileURLToPath(
    target === 'cloudflare'
      ? import.meta.resolve('@tsir/deploy/cloudflare')
      : import.meta.resolve('@tsir/deploy/lambda'),
  );
}

/** `resource: 'Room'` → the field wrangler wants for that binding kind. */
function bindingResource(binding: Unit['bindings'][number]): BindingResource | undefined {
  const resource = binding.resource;
  if (resource === undefined) return undefined;

  switch (binding.kind) {
    case 'hyperdrive':
    case 'kv':
      return { id: resource };
    case 'queue':
      return { queue: resource };
    case 'r2':
      return { bucket: resource };
    case 'durable-object':
      return { className: resource };
    case 'd1': {
      // D1 needs two values and `deploy.units[].bindings[].resource` carries one, so the
      // convention is `<id>:<name>` — explicit, and loud when someone forgets.
      const [id, database] = resource.split(':');
      if (id === undefined || database === undefined || database === '') {
        throw invalidDeployConfig(
          `binding "${binding.name}" is D1, which needs both an id and a database name — write resource as "<database-id>:<database-name>"`,
          { binding: binding.name, resource },
        );
      }
      return { id, database };
    }
    case 'secret':
    case 'var':
      // Not a resource: a secret is a `wrangler secret put`, a var is a `[vars]` entry.
      return undefined;
  }
}

function resourcesOf(unit: Unit): Record<string, BindingResource> {
  const resources: Record<string, BindingResource> = {};
  for (const binding of unit.bindings) {
    const resource = bindingResource(binding);
    if (resource !== undefined) resources[binding.name] = resource;
  }
  return resources;
}

/**
 * `Bun.build`, with its two failure modes made one.
 *
 * It returns `{ success: false, logs }` for most problems and *throws* `Error('Bundle
 * failed')` when it cannot even resolve the entry points — the detail is on `.errors`.
 * A build tool whose message is "Bundle failed" is a build tool nobody can act on, so
 * both paths end in the same error with the module graph's own words.
 */
async function bundle(options: Parameters<typeof Bun.build>[0]): Promise<void> {
  try {
    const result = await Bun.build(options);
    if (!result.success) {
      throw invalidDeployConfig(
        `bundle failed: ${result.logs.map((log) => log.message).join('; ')}`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof Error && 'kind' in error) throw error;
    const errors = (error as { errors?: readonly { message?: string }[] }).errors ?? [];
    const detail = errors
      .map((entry) => entry.message ?? '')
      .filter(Boolean)
      .join('; ');
    const fallback = error instanceof Error ? error.message : String(error);
    throw invalidDeployConfig(`bundle failed: ${detail === '' ? fallback : detail}`, {
      entry: [...options.entrypoints].join(', '),
    });
  }
}

async function measure(path: string): Promise<{ bytes: number; gzipBytes: number }> {
  const contents = await readFile(path);
  return { bytes: contents.byteLength, gzipBytes: gzipSync(contents, { level: 9 }).byteLength };
}

interface EmitJob {
  readonly unit: Unit;
  readonly target: DeployTarget;
  readonly triggers: readonly AdapterTrigger[];
  /** Durable Object classes the entry must export for this unit (`DPL-010`). */
  readonly durables: readonly string[];
}

async function emitUnit(resolved: ResolvedBuild, job: EmitJob): Promise<Artifact> {
  const { unit, target } = job;
  const directory = join(resolved.outDir, target, unit.name);
  const naming = target === 'lambda' ? 'index.mjs' : 'index.js';
  const staging = join(resolved.root, STAGING_DIR, target, `${unit.name}.js`);

  await mkdir(dirname(staging), { recursive: true });
  await mkdir(directory, { recursive: true });
  await writeFile(
    staging,
    unitEntrySource({
      target,
      unit: unit.name,
      triggers: job.triggers,
      durables: job.durables,
      adapter: adapterSpecifier(target),
      entry: resolved.entryPath,
    }),
    'utf8',
  );

  await bundle({
    entrypoints: [staging],
    outdir: directory,
    naming,
    target: RUNTIME_TARGET[target],
    format: 'esm',
    minify: resolved.minify,
    // Cloudflare Workers use the `workerd` export condition so packages like
    // `postgres` ship their edge-compatible entry (no `tls`/`net` builtins).
    ...(target === 'cloudflare'
      ? {
          conditions: ['workerd', 'browser', 'default'],
        }
      : {}),
  });

  const file = join(directory, naming);
  if (!existsSync(file)) {
    throw invalidDeployConfig(`the ${target} bundle for unit "${unit.name}" was not written`, {
      unit: unit.name,
      target,
    });
  }

  const size = await measure(file);
  return {
    target,
    unit: unit.name,
    file: `${target}/${unit.name}/${naming}`,
    bytes: size.bytes,
    gzipBytes: size.gzipBytes,
    budget: budgetFor(target, resolved.configured),
    triggers: job.triggers,
  };
}

async function emitBunServer(resolved: ResolvedBuild): Promise<Artifact> {
  const directory = join(resolved.outDir, 'bun');
  const staging = join(resolved.root, STAGING_DIR, 'bun', 'server.js');

  await mkdir(dirname(staging), { recursive: true });
  await mkdir(directory, { recursive: true });
  await writeFile(staging, bunServerSource(resolved.entryPath), 'utf8');

  await bundle({
    entrypoints: [staging],
    outdir: directory,
    naming: 'server.mjs',
    target: 'bun',
    format: 'esm',
    minify: resolved.minify,
  });

  const size = await measure(join(directory, 'server.mjs'));
  return {
    target: 'bun',
    // A Bun deployment is one process, not one function per unit (§ 3.3).
    unit: 'server',
    file: 'bun/server.mjs',
    bytes: size.bytes,
    gzipBytes: size.gzipBytes,
    budget: budgetFor('bun', resolved.configured),
    triggers: ['fetch'],
  };
}

/**
 * Write every artifact.
 *
 * Two passes on purpose. The first **validates** — does the entry export what the unit's
 * triggers need, does every Cloudflare binding resolve to a resource — and it happens
 * before the first byte is written, so a typo cannot leave a half-populated `dist/` that
 * looks deployable. The second writes: graph, bundle, wrangler config, one unit at a time.
 */
export async function emitArtifacts(resolved: ResolvedBuild): Promise<BuildResult> {
  const warnings: string[] = [];
  const jobs = planJobs(resolved, warnings);

  if (resolved.targets.includes('bun') && !resolved.provided.has('handler')) {
    throw unitEmpty(
      'server',
      `the bun target serves every route through the entry's \`handler\` — export one from ${relative(resolved.root, resolved.entryPath)}`,
    );
  }

  // Migrate units are emitted before the function targets: a bad connection should stop the
  // build before it has spent time bundling, and the artifact is small.
  const migrateArtifacts = await emitMigrateUnits(resolved);

  const wrangler = new Map<string, string>();
  const templates = new Map<string, string>();
  for (const job of jobs) {
    if (job.target === 'lambda') {
      // Same pre-flight as the wrangler configs: an environment that would exceed Lambda's
      // 4 KB budget fails the build before anything is written (`DPL_ENV_LIMIT`).
      templates.set(
        job.unit.name,
        samTemplate(job.unit, resolved.app, {
          ...(resolved.lambda?.runtime === undefined ? {} : { runtime: resolved.lambda.runtime }),
          ...(resolved.lambda?.memoryMb === undefined
            ? {}
            : { memoryMb: resolved.lambda.memoryMb }),
          ...(resolved.lambda?.timeoutSeconds === undefined
            ? {}
            : { timeoutSeconds: resolved.lambda.timeoutSeconds }),
          ...(resolved.lambda?.architecture === undefined
            ? {}
            : { architecture: resolved.lambda.architecture }),
          ...(resolved.lambda?.vars === undefined ? {} : { vars: resolved.lambda.vars }),
          ...(resolved.lambda?.domain === undefined ? {} : { domain: resolved.lambda.domain }),
          ...(resolved.lambda?.zone === undefined ? {} : { zone: resolved.lambda.zone }),
        }),
      );
      continue;
    }
    if (job.target !== 'cloudflare') continue;
    wrangler.set(
      job.unit.name,
      wranglerToml(job.unit, resolved.app, {
        compatibilityDate: resolved.cloudflare?.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
        ...(resolved.cloudflare?.compatibilityFlags === undefined
          ? {}
          : { compatibilityFlags: resolved.cloudflare.compatibilityFlags }),
        ...(resolved.cloudflare?.vars === undefined ? {} : { vars: resolved.cloudflare.vars }),
        ...(resolved.cloudflare?.domain === undefined
          ? {}
          : { domain: resolved.cloudflare.domain }),
        ...(resolved.cloudflare?.zone === undefined ? {} : { zone: resolved.cloudflare.zone }),
        resources: resourcesOf(job.unit),
      }),
    );
  }

  const artifacts: Artifact[] = [...migrateArtifacts];
  try {
    for (const target of resolved.targets) {
      const targetDir = join(resolved.outDir, target);
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, GRAPH_FILE), serializeGraph(resolved.graph), 'utf8');

      if (target === 'bun') {
        artifacts.push(await emitBunServer(resolved));
        continue;
      }

      for (const job of jobs) {
        if (job.target !== target) continue;
        const artifact = await emitUnit(resolved, job);
        // The config sits next to the bundle because both resolve neighbours by name:
        // `main = "index.js"` for wrangler, `CodeUri: .` for SAM.
        if (target === 'cloudflare') {
          await writeFile(
            join(resolved.outDir, 'cloudflare', job.unit.name, `wrangler.${job.unit.name}.toml`),
            wrangler.get(job.unit.name) ?? '',
            'utf8',
          );
        }
        if (target === 'lambda') {
          await writeFile(
            join(resolved.outDir, 'lambda', job.unit.name, `template.${job.unit.name}.yaml`),
            templates.get(job.unit.name) ?? '',
            'utf8',
          );
        }
        artifacts.push(artifact);
      }
    }

    await writeFile(
      join(resolved.outDir, BUILD_FILE),
      `${JSON.stringify(buildJson(resolved, artifacts, warnings, templates), null, 2)}\n`,
      'utf8',
    );
  } finally {
    await rm(join(resolved.root, STAGING_DIR), { recursive: true, force: true });
    // `.tsir/` also holds the boot manifest; only a directory this build created is ours
    // to remove, and `rmdir` refuses anything non-empty.
    await rmdir(join(resolved.root, '.tsir')).catch(() => undefined);
  }

  return {
    app: resolved.app,
    topology: resolved.topology,
    outDirName: resolved.outDirName,
    targets: resolved.targets,
    artifacts,
    warnings,
  };
}

/** Which unit goes to which target, and whether the entry can back it. */
function planJobs(resolved: ResolvedBuild, warnings: string[]): readonly EmitJob[] {
  const jobs: EmitJob[] = [];
  for (const target of resolved.targets) {
    if (target === 'bun') continue;
    for (const unit of resolved.graph.units) {
      // A migrate unit is a one-off script, not a function (`DPL-021`): it has no platform
      // trigger by design, and warning about that would train people to ignore warnings.
      if (unit.kind === 'migrate') continue;

      const triggers = adapterTriggers(unit);
      if (triggers.length === 0) {
        const kinds = unit.triggers.map((trigger) => trigger.kind).join(', ') || 'none';
        warnings.push(`${unit.name}: no deployable triggers (${kinds}) — skipped`);
        continue;
      }

      for (const needed of requiredExports(triggers)) {
        if (resolved.provided.has(needed)) continue;
        throw unitEmpty(
          unit.name,
          `unit "${unit.name}" is triggered by ${triggers.join(', ')}, so its entry must export \`${needed}\` — export it from ${relative(resolved.root, resolved.entryPath)}` +
            // The one export an app cannot guess the shape of, so the hint gives the shape.
            (needed === 'scheduled' && resolved.provided.has('tasks')
              ? ': `export const scheduled = (controller) => scheduler.scheduled({ at: controller.scheduledTime })`, built from `createScheduler({ tasks, lock })`'
              : ''),
        );
      }

      // A Durable Object binding is a promise about the bundle's exports (`DPL-010`).
      const durables =
        target === 'cloudflare'
          ? unit.bindings
              .filter(
                (binding) => binding.kind === 'durable-object' && binding.resource !== undefined,
              )
              .map((binding) => ({ binding: binding.name, className: binding.resource ?? '' }))
          : [];
      for (const durable of durables) {
        if (resolved.provided.has(durable.className)) continue;
        throw classMissing({
          unit: unit.name,
          className: durable.className,
          binding: durable.binding,
        });
      }

      jobs.push({
        unit,
        target,
        triggers,
        durables: durables.map((durable) => durable.className),
      });
    }
  }
  return jobs;
}

/**
 * Every `migrate:<connection>` unit, as a runnable script plus its plan (`DPL-021`).
 *
 * Nothing here is per-target: a migration belongs to the connection, not to Workers or
 * Lambda, and the same file is what a pipeline runs whichever target it then promotes.
 */
async function emitMigrateUnits(resolved: ResolvedBuild): Promise<readonly Artifact[]> {
  const artifacts: Artifact[] = [];

  for (const unit of resolved.graph.units) {
    if (unit.kind !== 'migrate') continue;

    const spec = migrateSpec({
      unit: unit.name,
      app: resolved.app,
      entry: resolved.entryPath,
      root: resolved.root,
      connections: resolved.connections,
    });

    const directory = join(resolved.outDir, 'migrate', spec.connection);
    const staging = join(resolved.root, STAGING_DIR, 'migrate', `${spec.connection}.js`);

    await mkdir(dirname(staging), { recursive: true });
    await mkdir(directory, { recursive: true });
    await writeFile(staging, migrateScriptSource(spec), 'utf8');

    await bundle({
      entrypoints: [staging],
      outdir: directory,
      naming: 'migrate.mjs',
      // `node`, so the same file runs under `bun` and under `node` on a deploy machine.
      target: 'node',
      format: 'esm',
      minify: resolved.minify,
    });

    const file = join(directory, 'migrate.mjs');
    const size = await measure(file);
    await writeFile(
      join(directory, MIGRATE_FILE),
      `${JSON.stringify(migratePlan(spec), null, 2)}\n`,
      'utf8',
    );

    artifacts.push({
      target: 'bun',
      // The unit *is* the connection; keeping the graph's name makes `build.json` greppable
      // for `migrate:primary` rather than for a second, invented one.
      unit: `migrate:${spec.connection}`,
      file: `migrate/${spec.connection}/migrate.mjs`,
      bytes: size.bytes,
      gzipBytes: size.gzipBytes,
      // A one-off script that runs for seconds has no bundle budget: the number would be
      // true and meaningless, which is worse than absent.
      budget: Number.POSITIVE_INFINITY,
      triggers: [],
    });
  }

  return artifacts;
}

/** `dist/build.json` — the release gate reads this, not the graph. */
export function buildJson(
  resolved: ResolvedBuild,
  artifacts: readonly Artifact[],
  warnings: readonly string[],
  templates: ReadonlyMap<string, string> = new Map(),
): unknown {
  return {
    schemaVersion: BUILD_SCHEMA_VERSION,
    app: resolved.app,
    topology: resolved.topology,
    outDir: resolved.outDirName,
    minify: resolved.minify,
    targets: resolved.targets,
    templates: [...templates.keys()].sort().map((unit) => ({
      unit,
      file: `lambda/${unit}/template.${unit}.yaml`,
    })),
    artifacts: artifacts.map((artifact) => ({
      target: artifact.target,
      unit: artifact.unit,
      file: artifact.file,
      bytes: artifact.bytes,
      gzipBytes: artifact.gzipBytes,
      budget: Number.isFinite(artifact.budget) ? artifact.budget : null,
      triggers: artifact.triggers,
    })),
    warnings,
  };
}

export function kibibytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** The human view: one line per artifact, and the budget in the same units. */
export function formatBuild(result: BuildResult): string {
  if (result.artifacts.length === 0) return '  no artifacts — nothing to build\n';

  const fileWidth = Math.max(...result.artifacts.map((artifact) => artifact.file.length));
  const lines = result.artifacts.map((artifact) => {
    const budget = Number.isFinite(artifact.budget)
      ? `budget ${kibibytes(artifact.budget)}`
      : 'no budget';
    const over = artifact.gzipBytes > artifact.budget;
    const near =
      !over && artifact.gzipBytes > artifact.budget * SIZE_WARNING_RATIO ? ' (near budget)' : '';
    const mark = over ? style.red('✗') : style.green('✓');
    return (
      `  ${mark} ${artifact.file.padEnd(fileWidth)}  ${kibibytes(artifact.bytes).padStart(10)}` +
      `  ${kibibytes(artifact.gzipBytes).padStart(10)} gz  ${budget}${over ? ' — over' : near}`
    );
  });

  const summary =
    `\n  ${String(result.artifacts.length)} artifact(s) · ${result.app} · ` +
    `${result.topology} topology · ${result.targets.join(', ')} → ${result.outDirName}/`;

  return `${lines.join('\n')}\n${summary}\n`;
}

/* ── the command ──────────────────────────────────────────────────────────────── */

export async function deployBuildCommand(argv: readonly string[]): Promise<number> {
  return build(argv, process.cwd());
}

/**
 * `deploy:build [--target cloudflare,lambda] [--out dist] [--minify] [--json]`.
 *
 * Exit codes: `0` when every artifact was written within budget, `1` when one exceeded its
 * budget (unless `--allow-size-regression`) or the graph has a blocking problem, `2` for a
 * usage error such as an unknown target — the same contract as `deploy:plan`.
 */
export async function build(argv: readonly string[], cwd: string): Promise<number> {
  const args = parseArgs(argv, {
    '--target': {
      type: 'string',
      description: 'comma-separated targets (bun, cloudflare, lambda)',
    },
    '--out': { type: 'string', description: `output directory (default ${DEFAULT_OUT_DIR})` },
    '--minify': { type: 'boolean', description: 'minify the bundles' },
    '--json': { type: 'boolean', description: 'machine-readable build document' },
    '--allow-size-regression': {
      type: 'boolean',
      description: 'write over-budget artifacts instead of failing',
    },
  });

  const json = boolFlag(args, '--json');
  const targetFlag = stringFlag(args, '--target');
  const outFlag = stringFlag(args, '--out');

  const requested =
    targetFlag === undefined ? undefined : targetFlag.split(',').map((target) => target.trim());
  // A misspelled target is a usage error (2), not a build failure (1): nothing was
  // attempted, and `--target cloudflare,lamda` should say so before it reads `tsir.js`.
  for (const target of requested ?? []) {
    if (!isDeployTarget(target)) {
      throw new UsageError(
        `unknown target "${target}"`,
        `expected one of ${DEPLOY_TARGETS.join(', ')}`,
      );
    }
  }

  let resolved: ResolvedBuild;
  try {
    resolved = await resolveBuild(cwd, {
      ...(requested === undefined ? {} : { targets: requested }),
      ...(outFlag === undefined ? {} : { outDir: outFlag }),
      minify: boolFlag(args, '--minify'),
      allowSizeRegression: boolFlag(args, '--allow-size-regression'),
    });
  } catch (error: unknown) {
    return fail(error, json);
  }

  // Blocking problems stop the build before anything is written: `DPL_UNIT_EMPTY` is the
  // one code that is a warning here (§ 7), and `deploy:plan --strict` is where it escalates.
  const blocking = resolved.problems.filter((problem) => problem.code !== 'DPL_UNIT_EMPTY');
  if (blocking.length > 0) {
    if (json) {
      info(jsonDocument({ ok: false, problems: blocking }));
    } else {
      for (const problem of blocking) {
        info(`  ${style.red('✗')} ${problem.code} · ${problem.message}`);
        info(`    ${problem.hint}`);
      }
    }
    return EXIT.failure;
  }

  let result: BuildResult;
  try {
    result = await emitArtifacts(resolved);
  } catch (error: unknown) {
    return fail(error, json);
  }

  for (const warning of result.warnings) warn(warning);

  const over = resolved.allowSizeRegression
    ? []
    : result.artifacts.filter((artifact) => artifact.gzipBytes > artifact.budget);

  if (json) {
    info(
      jsonDocument({
        ok: over.length === 0,
        app: result.app,
        topology: result.topology,
        outDir: result.outDirName,
        artifacts: result.artifacts,
        warnings: result.warnings,
      }),
    );
  } else {
    info(formatBuild(result));
    if (over.length > 0) {
      for (const artifact of over) {
        info(
          `  ${style.red('✗')} DPL_SIZE_BUDGET · ${artifact.file} is ${kibibytes(artifact.gzipBytes)} gzipped, budget ${kibibytes(artifact.budget)}`,
        );
      }
      info(
        '    budgets live in deploy.targets.<target>.sizeBudget; --allow-size-regression writes anyway',
      );
    }
  }

  return over.length === 0 ? EXIT.ok : EXIT.failure;
}
