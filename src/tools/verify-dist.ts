/**
 * `make verify-dist` — prove the distributable actually behaves.
 *
 * A build that produces files is not evidence. This tool copies `dist/` into a
 * throwaway project (no workspace links, no TypeScript, no source tree), then:
 *
 *   1. **Boots an app** from the distributed packages and asserts it reaches
 *      `ready` and shuts down cleanly. If the export map or the emitted imports
 *      are wrong, this fails before any size discussion.
 *   2. **Measures tree shaking** by bundling narrow entries and checking both
 *      the byte budget and the absence of code that should have been dropped.
 *   3. **Bundles for Workers and Lambda** (`target: 'browser'` / `'node'`) and
 *      fails on any `node:*` external, which is what "runtime-neutral" means in
 *      practice rather than in a README.
 *   4. **Compiles the CLI to a single file** (`bun build --compile`) and runs
 *      `tsir new` out of it. A compiled binary has no `package.json` and no
 *      `stubs/` directory, so this is the proof that the templates and the
 *      version reach the bundle instead of being read from disk (Q71).
 *
 * Budgets are *measured baselines plus headroom*, not aspirations: a change that
 * doubles the payload fails here, which is the point.
 *
 * Usage: bun src/tools/verify-dist.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const DIST = join(ROOT, 'dist');
const WORK = join(ROOT, '.verify');

interface Budget {
  readonly name: string;
  readonly entry: string;
  readonly target: 'browser' | 'bun' | 'node';
  readonly maxBytes: number;
  /** Strings that must NOT survive bundling — proof that dead code was dropped. */
  readonly forbidden?: readonly string[];
  /** Built-in module families the bundle must not import (checked as specifiers, not substrings). */
  readonly forbiddenImports?: readonly string[];
  readonly note: string;
}

const BUDGETS: readonly Budget[] = [
  {
    name: 'token-only',
    entry: `import { token } from '@tsir/container';\nexport const T = token<string>('T');\n`,
    target: 'browser',
    // measured 108 B; a barrel without `sideEffects: false` costs ~14 KB here
    maxBytes: 1_500,
    forbidden: ['class Container', 'CTN_CYCLE', 'CTN_DISPOSED'],
    note: 'one symbol from @tsir/container must not drag the container in',
  },
  {
    name: 'core-only',
    entry:
      `import { bootstrap, defineModule } from '@tsir/core';\n` +
      `export async function run() {\n` +
      `  const app = await bootstrap({ appName: 'edge', config: { values: {}, appName: 'edge', masked: {}, warnings: [] }, modules: [defineModule({ name: 'edge' })] });\n` +
      `  const t = app.capabilities.target;\n  await app.shutdown('manual');\n  return t;\n}\n`,
    target: 'browser',
    // measured 13.8 KB. Importing the lifecycle must not drag in any validator.
    maxBytes: 20_000,
    forbidden: ['ZodError', 'ZodMini'],
    note: 'lifecycle alone: no validator, no config',
  },
  {
    name: 'config-only',
    entry:
      `import { defineConfig, env, loadConfig } from '@tsir/config';\n` +
      `const spec = defineConfig({ A: env.string({ default: 'x' }) });\n` +
      `export const config = loadConfig(spec, { env: {} });\n`,
    target: 'browser',
    // measured 21.0 KB after moving config onto zod/mini; it was 75.1 KB on full zod.
    // No `forbidden` list here on purpose: `$ZodError` is part of zod's core and is
    // legitimately present in the mini build, so a substring check would lie. The
    // byte budget is the real guard.
    maxBytes: 28_000,
    note: 'typed config: env parsing builds on zod/mini (ADR-0013)',
  },
  {
    name: 'edge-app',
    entry:
      `import { bootstrap, defineModule } from '@tsir/core';\n` +
      `import { defineConfig, env, loadConfig } from '@tsir/config';\n` +
      `import * as m from '@tsir/validate/mini';\n` +
      `import { validateSync } from '@tsir/validate';\n` +
      `const spec = defineConfig({ APP_ENV: env.string({ default: 'production' }) });\n` +
      `const config = loadConfig(spec, { env: {} });\n` +
      `const Body = m.object({ name: m.string() });\n` +
      `export default {\n` +
      `  async fetch(): Promise<Response> {\n` +
      `    const parsed = validateSync(Body, { name: 'tsir' });\n` +
      `    const app = await bootstrap({ appName: 'edge', config, modules: [defineModule({ name: 'edge' })] });\n` +
      `    await app.shutdown('manual');\n` +
      `    return Response.json({ target: app.capabilities.target, ok: parsed.ok });\n` +
      `  },\n};\n`,
    target: 'browser',
    // measured 38.8 KB. The recommended Workers shape: mini schemas end to end.
    maxBytes: 50_000,
    forbiddenImports: ['node', 'bun'],
    note: 'Workers handler with @tsir/validate/mini — the recommended default',
  },
  {
    name: 'edge-app-zod',
    entry:
      `import { bootstrap, defineModule } from '@tsir/core';\n` +
      `import { defineConfig, env, loadConfig } from '@tsir/config';\n` +
      `import { z, validateSync } from '@tsir/validate';\n` +
      `const spec = defineConfig({ APP_ENV: env.string({ default: 'production' }) });\n` +
      `const config = loadConfig(spec, { env: {} });\n` +
      `const Body = z.object({ name: z.string() });\n` +
      `export default {\n` +
      `  async fetch(): Promise<Response> {\n` +
      `    const parsed = validateSync(Body, { name: 'tsir' });\n` +
      `    const app = await bootstrap({ appName: 'edge', config, modules: [defineModule({ name: 'edge' })] });\n` +
      `    await app.shutdown('manual');\n` +
      `    return Response.json({ target: app.capabilities.target, ok: parsed.ok });\n` +
      `  },\n};\n`,
    target: 'browser',
    // measured 104.4 KB: the same handler opting into full Zod for its own schemas.
    maxBytes: 130_000,
    forbiddenImports: ['node', 'bun'],
    note: 'the same handler using full Zod — costs ~65 KB more, deliberately',
  },
  {
    name: 'http-app',
    entry:
      `import { Controller, Get, compileRoutes, RouteRegistry } from '@tsir/router';\n` +
      `import { createFetchHandler } from '@tsir/http';\n` +
      `const registry = new RouteRegistry();\n` +
      `@Controller(registry, '/api/users')\n` +
      `class Users {\n` +
      `  @Get('/') list(): { ok: boolean } { return { ok: true }; }\n` +
      `}\n` +
      `export default createFetchHandler(compileRoutes(registry.entries()));\n`,
    target: 'browser',
    // measured 23.5 KB: +9.7 KB over core-only for the whole pipeline. `ZodError`
    // is forbidden on purpose — @tsir/http imports @tsir/validate, and this proves
    // the re-exported zod is tree-shaken away unless an app declares a schema.
    maxBytes: 32_000,
    forbidden: ['ZodError'],
    forbiddenImports: ['node', 'bun'],
    note: 'a complete HTTP app: decorators, route table, matcher and pipeline',
  },
  {
    name: 'db-app',
    entry:
      `import { createDatabase, createD1Driver, createDrizzle } from '@tsir/database';\n` +
      `import { eq } from 'drizzle-orm';\n` +
      `import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';\n` +
      `const users = sqliteTable('users', { id: integer('id'), email: text('email').notNull() });\n` +
      `export function app(d1: Parameters<typeof createD1Driver>[0]['binding']) {\n` +
      `  const database = createDatabase({ driver: createD1Driver({ binding: d1 }) });\n` +
      `  return { database, db: createDrizzle(database), users, eq };\n` +
      `}\n`,
    target: 'browser',
    // measured 68.9 KB (was 67.5 KB before the driver gained redacted query
    // logging, DB-009 — ~1.4 KB for `scrubSql`/`paramType`/`shouldLog`).
    // Drizzle's SQLite dialect plus the driver contract; budget keeps ~4 KB of
    // headroom so a real regression is what trips it, not a rebuild.
    maxBytes: 76_000,
    // Proof that the *other* dialect is gone: `jsonb`/`bytea` only exist in
    // `pg-core`, and a D1 application must never pay for Postgres column types.
    forbidden: ['jsonb', 'bytea'],
    forbiddenImports: ['node', 'bun'],
    note: 'Drizzle over the driver: SQLite dialect only, Postgres dialect tree-shaken away',
  },
  {
    name: 'pg-app',
    entry:
      `import { createDatabase } from '@tsir/database';\n` +
      `import { createPostgresDriver } from '@tsir/database/postgres';\n` +
      `import { createPgDrizzle } from '@tsir/database/postgres/drizzle';\n` +
      `import { eq } from 'drizzle-orm';\n` +
      `import { integer, pgTable, text } from 'drizzle-orm/pg-core';\n` +
      `const users = pgTable('users', { id: integer('id'), email: text('email').notNull() });\n` +
      // The client is supplied by the application (ADR-0009), so the probe passes
      // a structural double: no Postgres client can be in this bundle by
      // construction, and the driver still has to compile against the real shape.
      `export function app(client: Parameters<typeof createPostgresDriver>[0]['client']) {\n` +
      `  const database = createDatabase({ driver: createPostgresDriver({ client }) });\n` +
      `  return { database, db: createPgDrizzle(database), users, eq };\n` +
      `}\n`,
    target: 'browser',
    // Measured 84.1 KiB — ~14 KiB more than the SQLite dialect, because
    // `pg-core` carries date/interval/array mappers SQLite does not have. The
    // budget is the Postgres app's own baseline, not a comparison: what it must
    // prove is that the *other* dialect and the client are absent.
    maxBytes: 92_000,
    // The mirror image of `db-app`'s check: a Postgres app must not carry the
    // SQLite dialect, and must not carry a Postgres *client* it never imported.
    forbidden: ['SQLiteSyncDialect', 'sqlite-core', 'BunSQLite'],
    forbiddenImports: ['node', 'bun', 'postgres'],
    note: 'Drizzle over Postgres: pg dialect only, no client bundled (the app supplies it)',
  },
  {
    name: 'openapi-app',
    entry:
      `import { Controller, Get, compileRoutes, RouteRegistry } from '@tsir/router';\n` +
      `import { createOpenApiDocument } from '@tsir/http/openapi';\n` +
      `const registry = new RouteRegistry();\n` +
      `@Controller(registry, '/api/users')\n` +
      `class Users {\n` +
      `  @Get('/:id') findOne(): { ok: boolean } { return { ok: true }; }\n` +
      `}\n` +
      `export default createOpenApiDocument(compileRoutes(registry.entries()), { title: 'acme', version: '1.0.0' });\n`,
    target: 'browser',
    // measured 70.2 KB: the same HTTP app plus schema→JSON Schema conversion, which
    // needs Zod. Opt-in by construction — the `http-app` budget above proves an app
    // that never imports this entry point pays nothing for it.
    maxBytes: 78_000,
    forbiddenImports: ['node', 'bun'],
    note: 'OpenAPI 3.1 generation (opt-in subpath) — pulling Zod is the price of a spec',
  },
  {
    name: 'vault-app',
    entry:
      `import { createKeyring, createVault, formatKeySpec, generateKey } from '@tsir/vault';\n` +
      `const column = { table: 'users', column: 'tax_id' };\n` +
      `export async function run(): Promise<string> {\n` +
      `  const spec = formatKeySpec(generateKey('aes-256-gcm', 'v1'));\n` +
      `  const vault = await createVault({ keyring: createKeyring({ now: spec }) });\n` +
      `  const sealed = await vault.encrypt(column, 'value');\n` +
      `  return await vault.decrypt(column, sealed);\n` +
      `}\n`,
    target: 'browser',
    // measured below; WebCrypto is the platform, so this is our code and nothing else
    maxBytes: 14_000,
    forbiddenImports: ['node', 'bun'],
    note: 'encrypt/decrypt on WebCrypto alone — the Workers budget (VLT-002)',
  },
  {
    name: 'link-rest-app',
    entry:
      `import { createRestClient } from '@tsir/link/rest';\n` +
      `export const billing = createRestClient({ baseUrl: 'https://billing.test', breaker: false });\n`,
    target: 'browser',
    // measured below; `fetch` is the platform, so this is our adapter and nothing else
    maxBytes: 20_000,
    // ADR-0022's companion proof: importing REST must not drag gRPC's runtime in.
    forbidden: ['@grpc/grpc-js', 'protobuf', 'proto-loader'],
    forbiddenImports: ['node', 'bun'],
    note: 'REST client on fetch alone — no gRPC runtime reaches a REST bundle (ADR-0022)',
  },
  {
    name: 'grpc-app',
    entry:
      `import { createCallContext } from '@tsir/link';\n` +
      `import { createGrpcClient } from '@tsir/link/grpc';\n` +
      `import { OrderService } from '@tsir/link/contracts/tsir/orders/v1/orders_pb';\n` +
      `export const orders = createGrpcClient({\n` +
      `  address: '127.0.0.1:50051',\n` +
      `  service: OrderService,\n` +
      `  ctx: createCallContext({ traceId: 'a'.repeat(32) }),\n` +
      `});\n`,
    target: 'node',
    // measured 495.8 KiB: grpc-js's HTTP/2 + HPACK stack and the protobuf runtime. This
    // is the price of the protocol on a Node/Lambda unit and it never reaches a Worker.
    maxBytes: 560_000,
    forbiddenImports: ['bun'],
    note: 'gRPC client and generated contract, bundled for Node/Lambda only',
  },
  {
    name: 'soap-app',
    entry:
      `import { createCallContext } from '@tsir/link';\n` +
      `import { createSoapClient } from '@tsir/link/soap';\n` +
      `export const tax = createSoapClient({\n` +
      `  endpoint: 'https://tax.test/soap',\n` +
      `  ctx: createCallContext({ traceId: 'a'.repeat(32) }),\n` +
      `  operations: { GetTaxRate: { operation: 'GetTaxRate', namespace: 'urn:tax' } },\n` +
      `});\n`,
    target: 'browser',
    // measured below: our own reader, so this is the adapter and nothing else. The claim
    // being proved is that SOAP is a Workers capability (§ 8), not a Node one.
    maxBytes: 30_000,
    forbiddenImports: ['node', 'bun'],
    note: 'SOAP client over fetch with the bounded XML reader — no node: imports (LNK-018)',
  },
  {
    name: 'room-app',
    entry:
      `import { createRoom } from '@tsir/link/ws';\n` +
      `export const room = (state: unknown) =>\n` +
      `  createRoom(state as never, {\n` +
      `    schema: { parse: (value: unknown) => value as { readonly text: string } },\n` +
      `    onMessage: ({ message }) => ({ type: 'echo', text: message.text }),\n` +
      `  });\n`,
    target: 'browser',
    // A room is a Workers capability: the model is the Durable Object API's shape and
    // nothing else, so the bundle is our own code (`LNK-025`).
    maxBytes: 20_000,
    forbiddenImports: ['node', 'bun'],
    note: 'Durable Object room model on the Workers socket API — no node: imports (LNK-025)',
  },
  {
    name: 'lambda-app',
    entry:
      `import { bootstrap, defineModule } from '@tsir/core';\n` +
      `import { defineConfig, env, loadConfig } from '@tsir/config';\n` +
      `const spec = defineConfig({ APP_ENV: env.string({ default: 'production' }) });\n` +
      `const config = loadConfig(spec, { env: {} });\n` +
      `export async function handler(): Promise<{ statusCode: number }> {\n` +
      `  const app = await bootstrap({ appName: 'lambda', config, modules: [defineModule({ name: 'lambda' })] });\n` +
      `  await app.shutdown('manual');\n` +
      `  return { statusCode: 200 };\n}\n`,
    target: 'node',
    maxBytes: 40_000,
    forbiddenImports: ['bun'],
    note: 'an AWS Lambda handler (node target, no bun: imports)',
  },
];

const failures: string[] = [];
const rows: string[] = [];
/** Measured sizes, keyed by budget name; written to `.tsir/` for the dev server. */
const measured = new Map<string, number>();

/**
 * Finds built-in module imports in bundled code.
 *
 * A substring search for `node:` is useless here: `{ bun: [...] }` in the
 * capability table and error hints like "run `bun x`" both match. Only real
 * specifiers count.
 */
function builtinImports(code: string): string[] {
  const patterns = [
    /\bfrom\s*["']((?:node|bun):[^"']+)["']/g,
    /\bimport\s*\(\s*["']((?:node|bun):[^"']+)["']/g,
    /\brequire\s*\(\s*["']((?:node|bun):[^"']+)["']/g,
    /\bimport\s*["']((?:node|bun):[^"']+)["']/g,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.add(specifier);
    }
  }
  return [...found];
}

/** A size a reader can act on: KiB for bundles, MiB for a compiled binary, which is ~120 of them. */
const KB = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${(bytes / 1024).toFixed(1)} KiB`;

async function prepareSandbox(): Promise<string> {
  await rm(WORK, { recursive: true, force: true });
  const modules = join(WORK, 'node_modules', '@tsir');
  await mkdir(modules, { recursive: true });

  const names = (await readdir(join(DIST, 'framework'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  // Real copies, not links: resolution must walk up from the package itself, so
  // a missing dependency in a distributed manifest fails here as it would for a
  // consumer.
  for (const name of names) {
    await cp(join(DIST, 'framework', name), join(modules, name), {
      recursive: true,
      filter: (path) => basename(path) !== 'node_modules',
    });
  }
  // Third-party runtime dependencies must be resolvable from the sandbox exactly
  // as a consumer would resolve them. Bun hoists per-workspace-package copies, so
  // both locations are tried; a package that is not installed here fails the
  // budget loudly rather than silently bundling nothing.
  // `@opentui/core` is here for the compiled launcher: `@tsir/tui` imports it at the top level, so a
  // bundle cannot be produced without it resolved — and its per-platform native libraries are the
  // reason the compile has to pass `--external` (a `.so` is not inlineable).
  for (const name of [
    'zod',
    'drizzle-orm',
    '@bufbuild/protobuf',
    '@grpc/grpc-js',
    '@opentui/core',
  ]) {
    const candidates = [
      join(ROOT, 'node_modules', name),
      join(ROOT, 'src', 'framework', 'database', 'node_modules', name),
      join(ROOT, 'src', 'framework', 'link', 'node_modules', name),
      join(DIST, 'node_modules', name),
    ];
    const source = candidates.find((candidate) => existsSync(candidate));
    if (source === undefined) continue;
    await symlink(source, join(WORK, 'node_modules', name), 'dir').catch(async () => {
      await cp(source, join(WORK, 'node_modules', name), { recursive: true });
    });
  }
  await writeFile(
    join(WORK, 'package.json'),
    `${JSON.stringify({ name: 'tsir-verify', type: 'module' }, null, 2)}\n`,
  );
  return WORK;
}

/** The consumer-facing tree must be usable, not only the library packages. */
function verifyLayout(): void {
  const required = [
    'tsir',
    'bin/tsir',
    'README.md',
    'src/docs/index.html',
    'apps/frontpage/index.html',
    'apps/admin.product.com/app.ts',
    'apps/admin.product.com/modules/users/index.ts',
    'apps/admin.product.com/modules/auth/index.ts',
    'framework/console/cli.js',
  ];
  const missing = required.filter((path) => !existsSync(join(DIST, path)));
  if (missing.length > 0) {
    failures.push(`distribution layout missing: ${missing.join(', ')}`);
    return;
  }
  const cli = join(DIST, 'tsir');
  const example = join(DIST, 'apps', 'admin.product.com');
  const env = { ...process.env };
  for (const [cwd, args, marker] of [
    [DIST, ['--help'], 'usage: tsir'],
    [example, ['route:list'], 'UsersController'],
  ] as const) {
    const run = Bun.spawnSync([cli, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
    const out = `${run.stdout.toString()}${run.stderr.toString()}`;
    if (run.exitCode !== 0 || !out.includes(marker)) {
      failures.push(`distribution ${args.join(' ')} failed\n${out}`);
      return;
    }
  }
  rows.push('  ✓ layout           root CLI and modular example work from dist/');
}

async function smokeTest(sandbox: string): Promise<void> {
  const entry = join(sandbox, 'smoke.ts');
  await writeFile(
    entry,
    `import { bootstrap, defineModule } from '@tsir/core';\n` +
      `import { defineConfig, env, loadConfig } from '@tsir/config';\n` +
      `import { z, validateSync } from '@tsir/validate';\n` +
      `import { createKeyring, createVault, formatKeySpec, generateKey } from '@tsir/vault';\n` +
      `const spec = defineConfig({ APP_ENV: env.enum(['development', 'production'], { default: 'production' }) });\n` +
      `const config = loadConfig(spec, { env: { APP_ENV: 'production' } });\n` +
      `const ok = validateSync(z.object({ name: z.string() }), { name: 'tsir' });\n` +
      `const app = await bootstrap({ appName: 'dist-smoke', config, modules: [defineModule({ name: 'smoke' })] });\n` +
      `if (app.state.kind !== 'ready') throw new Error('not ready: ' + app.state.kind);\n` +
      `await app.shutdown('manual');\n` +
      `if (app.state.kind !== 'stopped') throw new Error('not stopped: ' + app.state.kind);\n` +
      `if (!ok.ok) throw new Error('validation failed');\n` +
      `const keySpec = formatKeySpec(generateKey('aes-256-gcm', 'v1'));\n` +
      `const vault = await createVault({ keyring: createKeyring({ now: keySpec }) });\n` +
      `const column = { table: 'users', column: 'tax_id' };\n` +
      `const sealed = await vault.encrypt(column, 'smoke');\n` +
      `if (!sealed.startsWith('tsir:v1:')) throw new Error('bad envelope: ' + sealed);\n` +
      `if ((await vault.decrypt(column, sealed)) !== 'smoke') throw new Error('round-trip failed');\n` +
      `console.log('DIST_SMOKE_OK ' + app.config.values.APP_ENV);\n`,
  );

  const run = Bun.spawnSync([process.execPath, 'run', entry], {
    cwd: sandbox,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = `${run.stdout.toString()}${run.stderr.toString()}`;
  if (run.exitCode !== 0 || !out.includes('DIST_SMOKE_OK')) {
    failures.push(
      `smoke: distributed packages did not boot\n${out.split('\n').slice(0, 6).join('\n')}`,
    );
  } else {
    rows.push(`  ✓ smoke            booted from dist/ only (state ready → stopped)`);
  }
}

/**
 * The **Node** half of `VLT-002`: bundle the vault for the `node` target, then run
 * that bundle under `node` and check the round-trip.
 *
 * Bundling alone proves nothing about a runtime — WebCrypto exists in Node 20 as
 * `globalThis.crypto`, but that is a claim until a process actually encrypts and
 * decrypts. Bun is covered by `smokeTest` (which runs the same round-trip under
 * `bun run`); Workers are covered by the `vault-app` budget, whose `browser` target
 * fails on any `node:`/`bun:` specifier.
 */
async function nodeVaultProof(sandbox: string): Promise<void> {
  const node = Bun.which('node');
  if (node === null) {
    rows.push('  · vault/node       skipped: no `node` on PATH (Bun and Workers still proven)');
    return;
  }

  const entry = join(sandbox, 'vault-node.ts');
  await writeFile(
    entry,
    `import { createKeyring, createVault, formatKeySpec, generateKey } from '@tsir/vault';\n` +
      `const column = { table: 'users', column: 'tax_id' };\n` +
      `const vault = await createVault({ keyring: createKeyring({ now: formatKeySpec(generateKey('aes-256-gcm', 'v1')) }) });\n` +
      `const sealed = await vault.encrypt(column, 'node-round-trip');\n` +
      `const opened = await vault.decrypt(column, sealed);\n` +
      `if (opened !== 'node-round-trip') throw new Error('round-trip failed');\n` +
      `process.stdout.write('VAULT_NODE_OK ' + (typeof globalThis.crypto?.subtle) + '\\n');\n`,
  );

  const built = await Bun.build({
    entrypoints: [entry],
    target: 'node',
    format: 'esm',
    minify: false,
    outdir: join(sandbox, 'build'),
  });
  if (!built.success) {
    failures.push(
      `vault/node: bundling failed\n${built.logs.map((log) => `  ${log.message}`).join('\n')}`,
    );
    return;
  }
  const bundle = built.outputs[0];
  if (bundle === undefined) {
    failures.push('vault/node: no bundle output');
    return;
  }

  const run = Bun.spawnSync([node, bundle.path], { cwd: sandbox, stdout: 'pipe', stderr: 'pipe' });
  const out = `${run.stdout.toString()}${run.stderr.toString()}`;
  if (run.exitCode !== 0 || !out.includes('VAULT_NODE_OK object')) {
    failures.push(
      `vault/node: round-trip under node failed\n${out.split('\n').slice(0, 6).join('\n')}`,
    );
    return;
  }
  rows.push('  ✓ vault/node       encrypt + decrypt under node (WebCrypto, no bun: imports)');
}

async function checkBudget(sandbox: string, budget: Budget): Promise<void> {
  const entry = join(sandbox, `${budget.name}.ts`);
  await writeFile(entry, budget.entry);

  const result = await Bun.build({
    entrypoints: [entry],
    target: budget.target,
    format: 'esm',
    minify: true,
    outdir: join(sandbox, 'build'),
  });

  if (!result.success) {
    failures.push(
      `${budget.name}: bundling for target "${budget.target}" failed\n` +
        result.logs.map((log) => `  ${log.message}`).join('\n'),
    );
    return;
  }

  const output = result.outputs[0];
  if (output === undefined) {
    failures.push(`${budget.name}: no output`);
    return;
  }
  const code = await output.text();
  const bytes = new TextEncoder().encode(code).byteLength;

  for (const needle of budget.forbidden ?? []) {
    if (code.includes(needle)) {
      failures.push(
        `${budget.name}: bundle still contains "${needle}" — dead code was not dropped`,
      );
    }
  }

  const imports = builtinImports(code);
  for (const family of budget.forbiddenImports ?? []) {
    const offending = imports.filter((specifier) => specifier.startsWith(`${family}:`));
    if (offending.length > 0) {
      failures.push(
        `${budget.name}: bundle imports ${offending.join(', ')} — not portable to target "${budget.target}"`,
      );
    }
  }
  if (bytes > budget.maxBytes) {
    failures.push(
      `${budget.name}: ${KB(bytes)} exceeds the ${KB(budget.maxBytes)} budget (${budget.target} target)`,
    );
    return;
  }
  measured.set(budget.name, bytes);
  const pct = Math.round((bytes / budget.maxBytes) * 100);
  rows.push(
    `  ✓ ${budget.name.padEnd(16)} ${KB(bytes).padStart(9)} / ${KB(budget.maxBytes).padStart(9)} ` +
      `(${String(pct).padStart(3)}%)  ${budget.target.padEnd(7)} ${budget.note}`,
  );
}

/**
 * The compiled single-file launcher (Q71).
 *
 * `make dist` ships a `bun`-driven script, so every earlier proof in this file exercises a layout
 * with a `package.json` and a `stubs/` directory on disk. `bun build --compile` has neither — the
 * module graph is inside the binary and `import.meta.dir` points into the bundled filesystem — and
 * three separate things broke when it was first tried: `tsir new` read templates from a directory
 * that is not there, `--version` and `about` answered "unknown", and the packed manifest's `files`
 * list left the inlined templates out of the tarball.
 *
 * What is proven here is the *distribution*, not the source tree: the entry is the built
 * `node_modules/@tsir/console/cli.js` a developer actually runs. The per-platform OpenTUI libraries
 * stay external (a `.so` or `.dylib` is not something a bundler can inline), so the compile passes
 * `--external` for every platform package the console does not install.
 */
async function compiledLauncherProof(sandbox: string): Promise<void> {
  const out = join(sandbox, 'tsir-compiled');
  const entry = join(sandbox, 'node_modules', '@tsir', 'console', 'cli.js');
  if (!existsSync(entry)) {
    failures.push(`compiled launcher: ${entry} is missing — nothing to compile`);
    return;
  }

  const externals = [
    '@opentui/core-linux-x64-musl',
    '@opentui/core-linux-arm64-musl',
    '@opentui/core-linux-arm64',
    '@opentui/core-darwin-x64',
    '@opentui/core-darwin-arm64',
    '@opentui/core-win32-x64',
    '@opentui/core-win32-arm64',
  ].flatMap((name) => ['--external', name]);

  const version = JSON.parse(readFileSync(join(entry, '..', 'package.json'), 'utf8')) as {
    version?: string;
  };
  const expected = version.version ?? 'unknown';

  const compile = Bun.spawnSync(
    [
      process.execPath,
      'build',
      '--compile',
      '--define',
      `TSIR_BUILT_VERSION="${expected}"`,
      ...externals,
      '--outfile',
      out,
      entry,
    ],
    { cwd: sandbox, stdout: 'pipe', stderr: 'pipe' },
  );
  if (compile.exitCode !== 0) {
    failures.push(`compiled launcher: bun build --compile failed\n${tail(compile.stderr)}`);
    return;
  }

  // The binary must report a real version. `unknown` is the exact string the CLI printed before the
  // define existed, so it is asserted against rather than merely preferred.
  const reported = Bun.spawnSync([out, '--version'], {
    cwd: sandbox,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const line = reported.stdout.toString().trim();
  if (reported.exitCode !== 0 || !line.startsWith(expected)) {
    failures.push(
      `compiled launcher: --version answered "${line || tail(reported.stderr)}", expected "${expected} …"`,
    );
    return;
  }

  // Scaffolding reads every template. A missing one is an ENOENT naming the bundled filesystem.
  const project = join(sandbox, 'compiled-app');
  await mkdir(project, { recursive: true });
  // `TSIR_DIST` is removed rather than blanked: an empty string is still *set*, and `tsir new`
  // would (correctly) refuse to scaffold inside the directory it names. A compiled binary must not
  // need the distribution it was built from, so the variable is absent here on purpose.
  const scaffoldEnv = { ...process.env };
  delete scaffoldEnv['TSIR_DIST'];
  const scaffold = Bun.spawnSync([out, 'new', 'compiled-app', '--no-interactive'], {
    cwd: project,
    stdout: 'pipe',
    stderr: 'pipe',
    env: scaffoldEnv,
  });
  if (scaffold.exitCode !== 0) {
    failures.push(
      `compiled launcher: tsir new failed\n${tail(scaffold.stderr) || tail(scaffold.stdout)}`,
    );
    return;
  }
  const created = join(project, 'apps', 'compiled-app', 'app.ts');
  if (!existsSync(created)) {
    failures.push(`compiled launcher: tsir new wrote no ${created}`);
    return;
  }

  rows.push(
    '  ✓ compiled launcher   ' +
      `${KB(readFileSync(out).byteLength).padStart(9)}  one file · ` +
      `--version ${expected} · tsir new scaffolds`,
  );
}

/** The last few lines of a failed subprocess, for a failure that names its cause. */
function tail(output: Uint8Array | string | undefined): string {
  return (output === undefined ? '' : output.toString()).trim().split('\n').slice(-4).join('\n');
}

/**
 * `--only compiled-launcher` runs one proof.
 *
 * The compile proof is the slowest single step here and the one most likely to need iterating on, so
 * `make compile-cli` runs it alone. Every other proof is unaffected: the flag narrows this run, it
 * does not skip anything by default.
 */
const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : undefined;

async function main(): Promise<void> {
  verifyLayout();
  const sandbox = await prepareSandbox();
  if (only === undefined) {
    await smokeTest(sandbox);
    await nodeVaultProof(sandbox);
    for (const budget of BUDGETS) await checkBudget(sandbox, budget);
  }
  await compiledLauncherProof(sandbox);
  await rm(WORK, { recursive: true, force: true });

  // The frontpage shows these numbers. Hand-typed statistics rot; a file that a
  // `make verify-dist` run rewrites does not.
  if (failures.length === 0 && measured.size > 0) {
    const sizes: Record<string, string> = {};
    for (const [name, bytes] of measured) {
      sizes[name] = bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(1)} KiB`;
    }
    await mkdir(join(ROOT, '.tsir'), { recursive: true });
    await writeFile(
      join(ROOT, '.tsir', 'sizes.json'),
      `${JSON.stringify({ measuredAt: new Date().toISOString(), minified: sizes }, null, 2)}\n`,
    );
  }

  process.stdout.write('\n  distributable verification\n\n');
  process.stdout.write(`${rows.join('\n')}\n\n`);

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`  ✗ ${failure}\n`);
    process.stderr.write('\n');
    process.exit(1);
  }
  process.stdout.write(
    '  ✓ dist/ boots, tree-shakes, bundles for Workers and Lambda, and compiles to one file\n\n',
  );
}

await main();
