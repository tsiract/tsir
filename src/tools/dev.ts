/**
 * Tsir development server.
 *
 * Serves the framework frontpage (`src/apps/frontpage/public`) and the static
 * documentation under `/docs/`. Responsibilities are deliberately small:
 *
 *   1. Resolve runtime metadata (version, runtimes, env, port).
 *   2. Record its own PID + ports in `.tsir/` so `make kill` can stop it
 *      without ever killing unrelated processes.
 *   3. Serve static files with token injection and safe path handling.
 *   4. Shut down gracefully on SIGINT/SIGTERM and remove its record.
 *
 * Usage:
 *   bun src/tools/dev.ts [--port 3000] [--host 0.0.0.0] [--root .]
 *
 * See the `dev` target in the Makefile for the workflow contract.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { arch, platform } from 'node:os';
import { buildDocs } from './docs-site.ts';
import { renderFrontpage } from '../apps/frontpage/build.ts';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Constants and types
// ─────────────────────────────────────────────────────────────────────────────

const RUNTIME_DIR = '.tsir';
const RECORD_JSON = 'dev.json';
const RECORD_TSV = 'dev.pids';
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 3000;
const SHUTDOWN_DRAIN_MS = 5_000;

/** Bumped when the record shape changes; `kill-dev.sh` reads it defensively. */
const RECORD_SCHEMA_VERSION = 1;

interface DevRecord {
  readonly schemaVersion: number;
  readonly pid: number;
  readonly startedAt: string;
  readonly script: string;
  readonly command: string;
  readonly version: string;
  readonly host: string;
  readonly ports: readonly number[];
}

interface Options {
  readonly root: string;
  readonly host: string;
  readonly port: number;
}

interface RuntimeInfo {
  readonly version: string;
  readonly bun: string;
  readonly node: string;
  readonly os: string;
  readonly env: string;
  readonly port: string;
  readonly startedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small terminal helpers (no dependencies)
// ─────────────────────────────────────────────────────────────────────────────

const useColor = Bun.enableANSIColors;
const paint = (code: string, text: string): string =>
  useColor ? `\u001B[${code}m${text}\u001B[0m` : text;
const bold = (text: string): string => paint('1', text);
const dim = (text: string): string => paint('2', text);
const green = (text: string): string => paint('32', text);
const red = (text: string): string => paint('31', text);
const cyan = (text: string): string => paint('36', text);

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string, hint?: string): never {
  process.stderr.write(`${red('✗')} ${message}\n`);
  if (hint !== undefined) process.stderr.write(`  ${dim(hint)}\n`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing (explicit, no implicit coercion)
// ─────────────────────────────────────────────────────────────────────────────

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) fail(`--port expects an integer, received "${raw}"`);
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 1 || value > 65_535) {
    fail(`--port must be between 1 and 65535, received ${String(value)}`);
  }
  return value;
}

function parseArgs(argv: readonly string[], cwd: string): Options {
  let host = process.env['HOST'] ?? DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let root = resolve(cwd);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) fail(`missing value for ${String(arg)}`);
      index += 1;
      return value;
    };

    switch (arg) {
      case '--port':
        port = parsePort(next());
        break;
      case '--host':
        host = next();
        break;
      case '--root':
        root = resolve(cwd, next());
        break;
      case '--help':
      case '-h':
        log(`${bold('tsir dev')} — development server\n`);
        log('  --port <n>    port to bind (default 3000, or $PORT)');
        log('  --host <addr> interface to bind (default 0.0.0.0)');
        log('  --root <dir>  project root (default cwd)\n');
        process.exit(0);
      default:
        fail(`unknown argument "${String(arg)}"`, 'run with --help to see supported flags');
    }
  }

  const envPort = process.env['PORT'];
  if (envPort !== undefined) port = parsePort(envPort);

  return { root, host, port };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime metadata
// ─────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is { version?: unknown } =>
  typeof value === 'object' && value !== null && 'version' in value;

async function readVersion(root: string): Promise<string> {
  try {
    const raw: unknown = await Bun.file(join(root, 'package.json')).json();
    if (isRecord(raw) && typeof raw.version === 'string') return raw.version;
  } catch {
    // A missing or malformed package.json must not block local development.
  }
  return '0.0.0';
}

async function collectRuntime(root: string, port: number): Promise<RuntimeInfo> {
  return {
    version: await readVersion(root),
    bun: Bun.version,
    node: process.versions.node ?? 'n/a',
    os: `${platform()} ${arch()}`,
    env: process.env['APP_ENV'] ?? 'development',
    port: String(port),
    startedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Process record (consumed by tools/kill-dev.sh)
// ─────────────────────────────────────────────────────────────────────────────

/** `ps -o lstart=` is used to detect PID reuse; absent output is tolerated. */
function processStartLabel(pid: number): string {
  try {
    const result = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    return result.stdout.toString().trim().replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}

async function writeRecord(root: string, options: Options, version: string): Promise<void> {
  const runtimeDir = join(root, RUNTIME_DIR);
  await mkdir(runtimeDir, { recursive: true });

  const record: DevRecord = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    script: 'src/tools/dev.ts',
    command: `bun src/tools/dev.ts --port ${String(options.port)}`,
    version,
    host: options.host,
    ports: [options.port],
  };

  await Bun.write(join(runtimeDir, RECORD_JSON), `${JSON.stringify(record, null, 2)}\n`);

  const tsv = `${String(process.pid)}\t${String(options.port)}\t${processStartLabel(process.pid)}\n`;
  await Bun.write(join(runtimeDir, RECORD_TSV), tsv);
}

async function removeRecord(root: string): Promise<void> {
  const runtimeDir = join(root, RUNTIME_DIR);
  await Promise.all([
    rm(join(runtimeDir, RECORD_JSON), { force: true }),
    rm(join(runtimeDir, RECORD_TSV), { force: true }),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Static file serving
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_PATTERN = /__TSIR_[A-Z_]+__/g;

interface MeasuredSizes {
  readonly minified?: Readonly<Record<string, string>>;
}

/**
 * Reads the numbers written by `make verify-dist`.
 *
 * The frontpage quotes real bundle sizes; typing them by hand guarantees they
 * are wrong within a week. When the file is absent the tokens fall back to an
 * honest "not measured", not to a made-up number.
 */
async function readMeasuredSizes(): Promise<Readonly<Record<string, string>>> {
  try {
    const raw: unknown = await Bun.file(join(RUNTIME_DIR, 'sizes.json')).json();
    if (typeof raw === 'object' && raw !== null && 'minified' in raw) {
      const minified = (raw as MeasuredSizes).minified;
      if (typeof minified === 'object' && minified !== null) return { ...minified };
    }
  } catch {
    // no sizes yet — fall through
  }
  return {};
}

function renderTokens(
  html: string,
  info: RuntimeInfo,
  sizes: Readonly<Record<string, string>>,
): string {
  const tokens: Readonly<Record<string, string>> = {
    __TSIR_VERSION__: info.version,
    __TSIR_BUN__: info.bun,
    __TSIR_NODE__: info.node,
    __TSIR_OS__: info.os,
    __TSIR_ENV__: info.env,
    __TSIR_PORT__: info.port,
    __TSIR_STARTED__: info.startedAt,
    __TSIR_STARTED_SHORT__: `${info.startedAt.slice(11, 19)} UTC`,
    __TSIR_SIZE_TOKEN__: sizes['token-only'] ?? 'run make verify-dist',
    __TSIR_SIZE_CORE__: sizes['core-only'] ?? 'run make verify-dist',
    __TSIR_SIZE_EDGE__: sizes['edge-app'] ?? 'run make verify-dist',
    __TSIR_SIZE_HTTP__: sizes['http-app'] ?? 'run make verify-dist',
    __TSIR_SIZE_CONFIG__: sizes['config-only'] ?? 'run make verify-dist',
    __TSIR_SIZE_EDGE_ZOD__: sizes['edge-app-zod'] ?? 'run make verify-dist',
    __TSIR_SIZE_LAMBDA__: sizes['lambda-app'] ?? 'run make verify-dist',
  };
  // Unresolved tokens render as an em dash rather than leaking the raw marker.
  return html.replace(TOKEN_PATTERN, (match) => tokens[match] ?? '—');
}

interface StaticResult {
  readonly response: Response;
}

/**
 * Resolves a request path to a file inside `publicDir`.
 * Returns `null` when the path escapes the public directory.
 */
function resolveStaticPath(publicDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  // Reject NUL bytes and traversal attempts before touching the filesystem.
  if (decoded.includes('\0')) return null;
  if (decoded.split('/').some((segment) => segment === '..')) return null;

  const candidate = normalize(join(publicDir, decoded));
  const inside = relative(publicDir, candidate);
  if (inside.startsWith('..') || inside.startsWith(sep)) return null;

  return candidate;
}

async function serveStatic(
  publicDir: string,
  pathname: string,
  info: RuntimeInfo,
  sizes: Readonly<Record<string, string>>,
): Promise<StaticResult> {
  let requested = pathname === '/' ? '/index.html' : pathname;
  // Support clean, directory-style URLs: `/docs/installation/` serves
  // `installation/index.html`, and `/docs/installation` (no trailing slash)
  // redirects to the slashed form so relative links resolve correctly.
  if (!requested.endsWith('/') && extname(requested) === '') {
    return {
      response: new Response(null, {
        status: 308,
        headers: { location: `${requested}/` },
      }),
    };
  }
  if (requested.endsWith('/')) {
    requested = `${requested}index.html`;
  }
  const filePath = resolveStaticPath(publicDir, requested);

  if (filePath === null) {
    return { response: new Response('Forbidden', { status: 403 }) };
  }

  if (extname(filePath) === '.html') {
    if (!(await Bun.file(filePath).exists())) {
      return { response: new Response('Not Found', { status: 404 }) };
    }
    const html = await Bun.file(filePath).text();
    return {
      response: new Response(renderTokens(html, info, sizes), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      }),
    };
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return { response: new Response('Not Found', { status: 404 }) };
  }

  return {
    response: new Response(file, { headers: { 'cache-control': 'no-store' } }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// File watcher — rebuild docs and frontpage without restarting `make dev`
// ─────────────────────────────────────────────────────────────────────────────

const WATCH_DEBOUNCE_MS = 150;

/**
 * Debounces a rebuild so a burst of saves produces one build, not one per file.
 * If a change arrives while a rebuild is running, a follow-up rebuild is queued
 * via the `dirty` flag so the latest state is always reflected.
 */
function debouncedRebuild(label: string, rebuild: () => Promise<void>): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let dirty = false;

  const run = async (): Promise<void> => {
    timer = null;
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    try {
      await rebuild();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${red('✗')} ${label} rebuild failed: ${reason}\n`);
    } finally {
      running = false;
      if (dirty) {
        dirty = false;
        timer = setTimeout(() => {
          void run();
        }, WATCH_DEBOUNCE_MS);
      }
    }
  };

  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      void run();
    }, WATCH_DEBOUNCE_MS);
  };
}

/** Whether a changed file lives under an output directory and must be ignored. */
function isOutputPath(root: string, filename: string | null): boolean {
  if (filename === null) return false;
  const full = join(root, filename);
  return (
    full.includes(`${sep}build${sep}`) ||
    full.endsWith(`${sep}build`) ||
    full.includes(`${sep}public${sep}`) ||
    full.endsWith(`${sep}public`)
  );
}

function startWatchers(root: string): void {
  const frontpageDir = join(root, 'src', 'apps', 'frontpage');
  const docsDir = join(root, 'src', 'docs');
  const docsRouterDir = join(root, 'src', 'tools', 'docs-router');

  const rebuildDocs = debouncedRebuild('docs', async () => {
    const start = performance.now();
    if ((await buildDocs(root)) === 0) {
      log(`  ${dim('·')} docs rebuilt in ${Math.round(performance.now() - start)}ms`);
    }
  });

  const rebuildFrontpage = debouncedRebuild('frontpage', async () => {
    const start = performance.now();
    const html = await renderFrontpage(root);
    await writeFile(join(frontpageDir, 'public', 'index.html'), html);
    log(
      `  ${dim('·')} frontpage rebuilt in ${Math.round(performance.now() - start)}ms (${String(new TextEncoder().encode(html).byteLength)} bytes)`,
    );
  });

  // Docs markdown, assets and copied data files.
  const docsWatcher = watch(docsDir, { recursive: true }, (_event, filename) => {
    if (isOutputPath(root, filename)) return;
    rebuildDocs();
    // Prose examples feed the frontpage code samples too.
    if (filename !== null && filename.includes(`${sep}prose${sep}`)) {
      rebuildFrontpage();
    }
  });

  // Docs client-side router (compiled and inlined by buildDocs).
  const docsRouterWatcher = watch(docsRouterDir, { recursive: true }, () => {
    rebuildDocs();
  });

  // Frontpage template, styles, client script and package inventory.
  const frontpageWatcher = watch(frontpageDir, { recursive: true }, (_event, filename) => {
    if (isOutputPath(root, filename)) return;
    rebuildFrontpage();
  });

  const shutdown = (): void => {
    docsWatcher.close();
    docsRouterWatcher.close();
    frontpageWatcher.close();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// ─────────────────────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2), process.cwd());

  const publicDir = join(options.root, 'src', 'apps', 'frontpage', 'public');
  if (!(await Bun.file(join(publicDir, 'index.html')).exists())) {
    fail(
      `frontpage not found at ${relative(options.root, publicDir)}/index.html`,
      'run this from the repository root, or pass --root <dir>',
    );
  }

  if ((await buildDocs(options.root)) !== 0)
    fail('documentation build failed', 'fix the reported documentation links before starting dev');

  const info = await collectRuntime(options.root, options.port);
  const sizes = await readMeasuredSizes();
  // Record before binding so a crash during startup still leaves a trace.
  await writeRecord(options.root, options, info.version);

  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({
      hostname: options.host,
      port: options.port,
      development: true,
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/__tsir/health') {
          return Response.json({
            ok: true,
            service: 'tsir-dev',
            version: info.version,
            uptimeSeconds: Math.round(process.uptime()),
          });
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return new Response('Method Not Allowed', {
            status: 405,
            headers: { allow: 'GET, HEAD' },
          });
        }

        if (url.pathname === '/docs') {
          return new Response(null, {
            status: 308,
            headers: { location: `/docs/${url.search}` },
          });
        }
        const isDocs = url.pathname.startsWith('/docs/');
        const staticRoot = isDocs ? join(options.root, 'build', 'docs-site') : publicDir;
        const staticPath = isDocs ? url.pathname.slice('/docs'.length) : url.pathname;
        const { response } = await serveStatic(staticRoot, staticPath, info, sizes);
        return response;
      },
      error(error: Error): Response {
        process.stderr.write(`${red('✗')} request failed: ${error.message}\n`);
        return new Response('Internal Server Error', { status: 500 });
      },
    });
  } catch (error: unknown) {
    await removeRecord(options.root);
    const reason = error instanceof Error ? error.message : String(error);
    if (
      /EADDRINUSE|address already in use|is port .* in use|failed to start server/i.test(reason)
    ) {
      fail(
        `port ${String(options.port)} is already in use — Tsir will not kill an unknown process`,
        `run \`make kill\` to stop a Tsir dev server, or choose another port with --port`,
      );
    }
    fail(`could not start dev server: ${reason}`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    log(`\n${dim('·')} ${signal} received — draining (max ${String(SHUTDOWN_DRAIN_MS)}ms)`);
    const timer = setTimeout(() => {
      process.stderr.write(
        `${red('✗')} drain exceeded ${String(SHUTDOWN_DRAIN_MS)}ms — forcing exit\n`,
      );
      process.exit(1);
    }, SHUTDOWN_DRAIN_MS);
    timer.unref();

    try {
      await server.stop();
      await removeRecord(options.root);
      clearTimeout(timer);
      log(`${green('✓')} dev server stopped`);
      process.exit(0);
    } catch (error: unknown) {
      clearTimeout(timer);
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${red('✗')} shutdown error: ${reason}\n`);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  // Watch source files so docs and the frontpage rebuild in place.
  startWatchers(options.root);

  const displayHost = options.host === '0.0.0.0' ? 'localhost' : options.host;

  log('');
  log(`  ${bold('tsir')} ${dim('· dev')}`);
  log('');
  log(
    `  ${green('➜')}  local    ${cyan(`http://${displayHost}:${String(server.port ?? options.port)}/`)}`,
  );
  log(
    `  ${green('➜')}  health   ${cyan(`http://${displayHost}:${String(server.port ?? options.port)}/__tsir/health`)}`,
  );
  log(`  ${dim(`➜  runtime  bun ${Bun.version} · node ${info.node} · ${info.os}`)}`);
  log(`  ${dim(`➜  version  ${info.version} · env ${info.env}`)}`);
  log('');
  log(`  ${dim('press ctrl-c to stop · `make kill` stops owned processes only')}`);
  log('');
}

await main();
