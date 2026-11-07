/**
 * Boundary enforcement (FND-009).
 *
 * Implements the package dependency DAG (ADR-0008) by static import
 * analysis of every `src/framework/*` source file. It is deliberately a *source*
 * check (not a build-graph check): it fails fast, explains the allowed arrows,
 * and needs no TypeScript program.
 *
 * Rules enforced:
 *   1. A package may only import `@tsir/*` packages listed in ALLOWED.
 *   2. No deep imports: `@tsir/core/src/...` is always a violation.
 *   3. Runtime-restricted packages may not import `node:` or `bun:` modules,
 *      unless the file is an explicitly declared adapter (see ADAPTER_FILES).
 *
 * Usage: bun src/tools/check-boundaries.ts [--json]
 */

import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

/** `src/tools/` → repository root. */
const ROOT = resolve(import.meta.dir, '..', '..');
const PACKAGES_DIR = join(ROOT, 'src', 'framework');

/** Arrow direction: importer → allowed imports. Anything else fails. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  container: [],
  cache: ['container', 'core', 'config'],
  // `@tsir/queue` is the same shape as `cache` — a port plus drivers that take an app-supplied
  // client (ADR-0027) — and its own errors extend `TsirError`. Runtime-neutral, so `RUNTIME_NEUTRAL`
  // below holds it to Web standards too.
  queue: ['container'],
  // `@tsir/events` sits above the queue on purpose: a listener that runs `queued` *is* a job, so
  // the package builds its deliveries out of `defineJob`/`JobMessage` rather than re-describing
  // what a message is. The arrow only points this way — `queue` cannot see what a delivery means,
  // which is why the outbox writer lives here (`§ 4.5`).
  events: ['container', 'queue'],
  // `@tsir/schedule` is a leaf: a cron parser, a task registry, a scheduler and two lock drivers.
  // It does not import the cache it was once supposed to reuse — a lock needs a conditional write
  // and the cache port has none (`§ 4.6`, `lock.ts`).
  schedule: ['container'],
  // `@tsir/storage` is a leaf as well: bytes, three drivers, and Signing Version 4 written out in
  // WebCrypto so the `s3` driver needs no SDK (`§ 6`).
  storage: ['container'],
  // `@tsir/mail` composes and sends. It needs `storage` for exactly one thing — the SigV4 signer
  // the `ses` transport reuses instead of growing a second copy — and nothing else.
  mail: ['container', 'storage'],
  // `@tsir/notify` is the first capability built on a transport rather than on a driver: notifying
  // through mail means calling a mailer, and queueing a delivery means the queue's own `dispatch`.
  // It imports those two ports and nothing else — a channel of its own is a plain function.
  notify: ['container', 'mail', 'queue'],
  // `@tsir/policy` is a leaf on purpose: a permission check that needs the HTTP layer to run is a
  // check that link, jobs and RPC all skip.
  policy: ['container'],
  // `@tsir/auth` is the second leaf of the same shape. Guards take a structural `{ request }`, so
  // nothing here imports `@tsir/http` — a queue worker builds the same shape (`§ 14-security.md § 4`).
  auth: ['container'],
  // `@tsir/pulse` is a third leaf and the only observability implementation. It needs `container`
  // for `TsirError` and nothing else: a logger that depends on the thing it logs is a cycle.
  pulse: ['container'],
  config: ['container', 'validate'],
  core: ['container', 'config'],
  validate: ['container'],
  router: ['container', 'core', 'validate'],
  http: ['container', 'core', 'config', 'validate', 'router'],
  // `validate` is allowed for the one thing database does with it: its own
  // config schema. `validate` depends on nothing but `container`, so this keeps
  // the graph acyclic (config → validate and database → config are unrelated).
  database: ['container', 'core', 'config', 'validate', 'vault'],
  vault: ['container', 'core', 'config'],
  migrate: ['container', 'core', 'config', 'database', 'vault'],
  seed: ['container', 'core', 'config', 'database'],
  link: ['container', 'core', 'config', 'validate', 'vault'],
  // `schedule` is there for one call: a cron trigger is parsed by the same parser the tasks use,
  // so `deploy.units` cannot smuggle in an expression the runtime would read differently.
  deploy: [
    'container',
    'core',
    'config',
    'http',
    'link',
    'vault',
    'schedule',
    'validate',
    'router',
  ],
  testing: ['container', 'core', 'config', 'validate', 'http', 'router', 'database'],
  // `scout` is a feature-flag / rollout engine: a port, an in-memory engine, and a
  // bootstrap. Leaf on `container` like `policy`.
  scout: ['container'],
  // `nightwatch` is the observability backend (tracing/spans): a port, an in-memory
  // backend, and a bootstrap. Leaf on `container`.
  nightwatch: ['container'],
  // `telemetry` is the structured logging/metrics bootstrap. Leaf on `container`.
  telemetry: ['container'],
  // `broadcast` is the realtime channel port: a port, an in-memory broadcaster, and a
  // bootstrap. Leaf on `container`.
  broadcast: ['container'],
  // `socialize` is the OAuth social-login port: providers use `fetch` and the state
  // token uses Web Crypto, so it stays runtime-neutral.
  socialize: ['container'],
  // `media` is the image/video port: adapters (sharp, ffmpeg, cloudinary, cloudflare,
  // imagekit) live in `adapters/` where runtime imports are allowed; the core is Web
  // standard.
  media: ['container'],
  // `forge` is the deployment engine: a port, a local provider, and a bootstrap.
  forge: ['container'],
  // `cashier` is the payment (Stripe) port: providers use `fetch`, but webhook
  // signature verification uses `node:crypto`, so it is NOT runtime-neutral.
  cashier: ['container'],
  // `pennant` is the feature-flag engine: a port, an in-memory store, and a
  // bootstrap. Leaf on `container`.
  pennant: ['container'],
  // `testing` appears because the CLI *generates* test files that import it;
  // it is a code-generation reference, not a runtime import (see ALLOWED_NOTE).
  console: [
    'container',
    'core',
    'config',
    // `tsir cache:*` builds the registry from `cache.stores` and probes it (`CACHE-9`).
    'cache',
    // `tsir queue:work|failed|retry` builds `queue.connections` and drains a connection
    // (`CAP-004`), which is the console's job and nobody else's.
    'queue',
    // Not imported by the CLI itself: the `events-app` fixture is, because a build rule about
    // the outbox's writer is only proved by a project that has one.
    'events',
    // `tsir schedule:list|run|work|table` builds the task registry and the lock (`SCHED-*`).
    'schedule',
    // `tsir storage:disks|probe|url` builds the disk registry (`STOR-*`).
    'storage',
    // `tsir mail:mailers|test|preview` builds the mailer registry and renders templates (`MAIL-*`).
    'mail',
    // `tsir notify:channels|preview|test` builds the channel registry and renders payloads.
    'notify',
    'validate',
    // `route:list` compiles the registry the app declared (RTR-010).
    'router',
    'database',
    'migrate',
    'seed',
    'vault',
    'deploy',
    'testing',
    // `openapi:generate` builds the document from the same route table `route:list` prints, with
    // the builder the http module owns (DXS-011).
    'http',
    // `link:soap:gen` compiles a WSDL the way `route:list` compiles the registry: the
    // module it emits names the runtime types it is built against (LNK-016).
    'link',
  ],
};

/** Packages that must stay Web-standard: no Node or Bun built-ins. */
const RUNTIME_NEUTRAL = new Set([
  'container',
  // `@tsir/cache` is a port plus drivers that take an app-supplied client (ADR-0027): no
  // `node:` or `bun:` import belongs in it, and the memory driver is a Map.
  'cache',
  // Same for the queue: `queue:work` is the console's process, and every driver here takes a
  // client rather than opening one.
  'queue',
  // And the events bus: ids come from the global `crypto`, the rest is a Map and a listener.
  'events',
  // The scheduler reads a clock it is given and writes to a lock provider it is given.
  'schedule',
  // The disks read bytes they are given and write to a backend they are given.
  'storage',
  // The mailers compose a message and POST it. The one transport that needs a socket (`smtp`)
  // loads `node:net` in `transports/adapters/`, which is why this package can stay neutral.
  'mail',
  // The channels POST JSON, write a row through a port, or push into an array. A webhook's
  // signature is WebCrypto, so none of them needs a Node module a Worker lacks.
  'notify',
  'config',
  'core',
  'validate',
  'router',
  'http',
  'vault',
  'testing',
  // The port-plus-bootstrap packages: core is Web standard, runtime access lives
  // in adapters/ (media/ffmpeg, media/sharp) or not at all.
  'scout',
  'nightwatch',
  'telemetry',
  'broadcast',
  'socialize',
  'media',
  'pennant',
  // `forge` is intentionally NOT runtime-neutral: its `localProvider` runs
  // commands via `node:child_process`. Server provisioning is a Node/VPS
  // concern, not a Workers one.
]);

/** Files allowed to touch runtime built-ins inside a runtime-neutral package. */
const ADAPTER_FILES: readonly RegExp[] = [/\/adapters?\/[^/]+\.ts$/, /\/bun\.ts$/, /\/node\.ts$/];

export interface Violation {
  readonly file: string;
  readonly importer: string;
  readonly rule: 'unknown-package' | 'forbidden-dependency' | 'deep-import' | 'runtime-import';
  readonly specifier: string;
  readonly detail: string;
}

/** Everything `checkSpecifier` needs that is not the specifier itself. */
export interface SpecifierContext {
  /** Package directory name, e.g. `router`. */
  readonly importer: string;
  /** Repository-relative path of the importing file, for messages. */
  readonly file: string;
  readonly allowed: readonly string[];
  readonly runtimeNeutral: boolean;
  readonly isAdapter: boolean;
}

/**
 * The entire rule set as a pure function: one import specifier in, at most one
 * violation out. Kept separate from the filesystem walk so the negative cases
 * ("router may not import database") can be asserted directly instead of by
 * planting a file in the tree.
 */
export function checkSpecifier(
  specifier: string,
  context: SpecifierContext,
): Violation | undefined {
  const base = { file: context.file, importer: context.importer, specifier };

  if (specifier.startsWith('@tsir/')) {
    const rest = specifier.slice('@tsir/'.length);
    const [target, ...subpath] = rest.split('/');
    if (target === undefined || target === '') return undefined;

    if (!(target in ALLOWED)) {
      return {
        ...base,
        rule: 'unknown-package',
        detail: `unknown package '@tsir/${target}' — add it to src/tools/check-boundaries.ts when it exists`,
      };
    }

    if (target !== context.importer && !context.allowed.includes(target)) {
      const allowList =
        context.allowed.length === 0 ? 'nothing (leaf package)' : context.allowed.join(', ');
      return {
        ...base,
        rule: 'forbidden-dependency',
        detail: `${context.importer} → ${target} is not permitted (allowed: ${allowList})`,
      };
    }

    // Public entrypoints only. Subpaths are allowed when declared in the
    // package's exports map, but /src/ and /dist/ are never importable.
    if (subpath.some((segment) => segment === 'src' || segment === 'dist')) {
      return {
        ...base,
        rule: 'deep-import',
        detail: 'import the package entrypoint, not its internal source',
      };
    }
    return undefined;
  }

  if (
    context.runtimeNeutral &&
    (specifier.startsWith('node:') || specifier.startsWith('bun:')) &&
    !context.isAdapter
  ) {
    return {
      ...base,
      rule: 'runtime-import',
      detail: `${context.importer} must stay Web-standard; move runtime access into an adapter file`,
    };
  }

  return undefined;
}

async function listSourceFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    // Test files and shared conformance suites are test infrastructure, not
    // runtime source: they may import `bun:test`/`node:test` and runtime
    // built-ins without violating the runtime-neutral rule.
    if (entry.name.endsWith('.test.ts')) continue;
    if (entry.name.startsWith('conformance')) continue;
    const parent = entry.parentPath;
    files.push(join(parent, entry.name));
  }
  return files;
}

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_PATTERN = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

function collectSpecifiers(source: string): readonly string[] {
  const found = new Set<string>();
  for (const pattern of [IMPORT_PATTERN, DYNAMIC_IMPORT_PATTERN, REQUIRE_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.add(specifier);
    }
  }
  return [...found];
}

function isAdapterFile(file: string): boolean {
  return ADAPTER_FILES.some((pattern) => pattern.test(file));
}

async function checkPackage(name: string, dir: string, violations: Violation[]): Promise<void> {
  const files = await listSourceFiles(dir);
  const allowed = ALLOWED[name] ?? [];

  for (const file of files) {
    const source = await Bun.file(file).text();
    const rel = relative(ROOT, file);

    for (const specifier of collectSpecifiers(source)) {
      const violation = checkSpecifier(specifier, {
        importer: name,
        file: rel,
        allowed,
        runtimeNeutral: RUNTIME_NEUTRAL.has(name),
        isAdapter: isAdapterFile(rel),
      });
      if (violation !== undefined) violations.push(violation);
    }
  }
}

async function main(): Promise<void> {
  const json = Bun.argv.includes('--json');
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true }).catch(() => []);

  const violations: Violation[] = [];
  const seen: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(PACKAGES_DIR, entry.name);
    const manifest = Bun.file(join(dir, 'package.json'));
    if (!(await manifest.exists())) continue;
    seen.push(entry.name);
    await checkPackage(entry.name, join(dir, 'src'), violations);
  }

  const unknown = seen.filter((name) => !(name in ALLOWED));
  for (const name of unknown) {
    violations.push({
      file: `src/framework/${name}`,
      importer: name,
      rule: 'unknown-package',
      specifier: name,
      detail: 'package is not registered in the dependency graph',
    });
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: violations.length === 0, checked: seen, violations }, null, 2)}\n`,
    );
    process.exit(violations.length === 0 ? 0 : 1);
  }

  if (violations.length === 0) {
    process.stdout.write(`✓ boundaries clean (${seen.length} packages: ${seen.join(', ')})\n`);
    process.exit(0);
  }

  const red = Bun.enableANSIColors ? '\u001B[31m' : '';
  const dim = Bun.enableANSIColors ? '\u001B[2m' : '';
  const reset = Bun.enableANSIColors ? '\u001B[0m' : '';

  process.stderr.write(`${red}✗ ${String(violations.length)} boundary violation(s)${reset}\n\n`);
  for (const violation of violations) {
    process.stderr.write(`  ${violation.file}\n`);
    process.stderr.write(`    ${violation.rule}: ${violation.specifier}\n`);
    process.stderr.write(`    ${dim}${violation.detail}${reset}\n\n`);
  }
  process.exit(1);
}

// Only run when executed directly: importing this module (the tests do) must not
// walk the filesystem or exit the process.
if (import.meta.main) await main();
