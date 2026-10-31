/**
 * `make dist` — build the distributable source tree.
 *
 * The repository is authored in `src/`. Everything in `dist/` is **generated**
 * and gitignored: it is the artifact you would publish, vendor, or hand to a
 * consumer. Nothing is hand-edited there, and `make dist` is idempotent — the
 * directory is removed and rebuilt on every run.
 *
 * What lands in `dist/framework/<pkg>/`:
 *
 *   package.json   rewritten for distribution (export map, `sideEffects: false`, no `private`)
 *   **\/*.js        ES modules, one file in / one file out (not a bundle)
 *   **\/*.d.ts      declarations alongside their implementation
 *   **\/*.map       source maps with sources inlined, so the artifact is self-describing
 *   LICENSE        copied per package (MIT requires the notice to travel with copies)
 *   README.md      generated from the manifest: install, entry points, exports
 *
 * Why per-file ESM and not a bundle: a consumer's bundler can only drop code it
 * can see. One-file-per-module with `sideEffects: false` is what makes
 * `import { token } from '@tsir/container'` cost ~1 KiB instead of the whole
 * container. `make verify-dist` proves that with a real bundler run.
 *
 * Usage: bun src/tools/dist.ts [--out dist] [--no-frontpage]
 */

import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const FRAMEWORK_DIR = join(ROOT, 'src', 'framework');
const DIST = resolve(ROOT, argValue(Bun.argv.slice(2), '--out', 'dist'));
const WITH_FRONTPAGE = !Bun.argv.includes('--no-frontpage');

function argValue(argv: readonly string[], flag: string, fallback: string): string {
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  return value ?? fallback;
}

/**
 * Resolves workspace protocol ranges to concrete versions.
 *
 * `workspace:*` inside the repository means "whatever version the sibling is";
 * outside it means nothing at all — `npm pack` refuses to pack, and an installed
 * tarball would carry an unresolvable dependency. Lockstep versioning across the
 * workspace (ADR-0011) makes this a straight substitution.
 */
function resolveWorkspaceRanges(
  dependencies: Readonly<Record<string, string>> | undefined,
  version: string,
): Record<string, string> | undefined {
  if (dependencies === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [name, range] of Object.entries(dependencies)) {
    if (range === 'workspace:*') out[name] = version;
    else if (range === 'workspace:^') out[name] = `^${version}`;
    else if (range === 'workspace:~') out[name] = `~${version}`;
    else out[name] = range;
  }
  return out;
}

interface SourceManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly bin?: Readonly<Record<string, string>>;
  readonly exports?: Readonly<Record<string, unknown>>;
}

const KB = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out;
}

async function sizeOf(files: readonly string[]): Promise<number> {
  let total = 0;
  for (const file of files) total += (await stat(file)).size;
  return total;
}

/** `index.js` → `.`; `bun.js` → `./bun`; `adapters/bun.js` → `./adapters/bun`. */
function subpathFor(file: string, root: string): string | undefined {
  if (!file.endsWith('.js')) return undefined;
  const rel = relative(root, file).replaceAll('\\', '/');
  if (rel.endsWith('.test.js') || rel.includes('/type-tests/')) return undefined;
  const stem = rel.slice(0, -'.js'.length);
  if (stem === 'index') return '.';
  if (stem.endsWith('/index')) return `./${stem.slice(0, -'/index'.length)}`;
  return `./${stem}`;
}

/**
 * Blocks a package from reaching the consumer's module graph by accident.
 * `./package.json` is always exported so tooling can read metadata.
 */
function exportsMap(files: readonly string[], root: string): Record<string, unknown> {
  const map: Record<string, unknown> = { './package.json': './package.json' };
  for (const file of [...files].sort()) {
    const subpath = subpathFor(file, root);
    if (subpath === undefined) continue;
    const js = `./${relative(root, file).replaceAll('\\', '/')}`;
    const types = js.replace(/\.js$/, '.d.ts');
    map[subpath] = { types, import: js, default: js };
  }
  return map;
}

function readmeFor(manifest: SourceManifest, exports: Readonly<Record<string, unknown>>): string {
  const entries = Object.keys(exports).filter((key) => key !== './package.json');
  return [
    `# ${manifest.name}`,
    '',
    manifest.description ?? 'Part of the Tsir framework.',
    '',
    '> Generated by `make dist` from the Tsir source tree. Do not edit this file in `dist/`;',
    '> edit the source package and rebuild.',
    '',
    '## Install',
    '',
    '```bash',
    `bun add ${manifest.name}`,
    '```',
    '',
    '## Entry points',
    '',
    ...entries.map((entry) => `- \`${manifest.name}${entry === '.' ? '' : entry.slice(1)}\``),
    '',
    '## What this package guarantees',
    '',
    '- **ES modules only.** One file in, one file out — no bundled blob to tree-shake around.',
    '- **`sideEffects: false`.** Importing a symbol does not execute unrelated modules.',
    '- **Runtime-neutral** unless the README says otherwise: no `node:*` or `bun:*` imports, so the',
    '  same code runs on Bun, Cloudflare Workers and AWS Lambda.',
    '',
    '## License',
    '',
    'MIT — see `LICENSE` in this directory.',
    '',
  ].join('\n');
}

async function buildPackage(
  name: string,
): Promise<{ name: string; bytes: number; exports: string[] }> {
  const sourceDir = join(FRAMEWORK_DIR, name);
  const manifest = JSON.parse(
    await readFile(join(sourceDir, 'package.json'), 'utf8'),
  ) as SourceManifest;

  // tsc emits `dist/framework/<pkg>/src/…` because each package keeps its own `src/`
  // directory in the repository. Distribution flattens that away.
  const emitted = join(DIST, 'framework', name, 'src');
  const target = join(DIST, 'framework', name);
  for (const entry of await readdir(emitted, { withFileTypes: true })) {
    await rename(join(emitted, entry.name), join(target, entry.name));
  }
  await rm(emitted, { recursive: true, force: true });

  const files = await listFiles(target);
  const exportMap = exportsMap(files, target);

  const distributed = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? 'Part of the Tsir framework.',
    license: 'MIT',
    type: 'module',
    // The single most important field for tree shaking: nothing in these
    // packages runs on import.
    sideEffects: false,
    exports: exportMap,
    files: ['**/*.js', '**/*.d.ts', '**/*.map', 'README.md', 'LICENSE', 'package.json'],
    ...(manifest.bin === undefined ? {} : { bin: manifest.bin }),
    engines: { bun: '>=1.2', node: '>=22' },
    publishConfig: { access: 'public' },
    ...(() => {
      const resolved = resolveWorkspaceRanges(manifest.dependencies, manifest.version);
      return resolved === undefined ? {} : { dependencies: resolved };
    })(),
  };

  await writeFile(join(target, 'package.json'), `${JSON.stringify(distributed, null, 2)}\n`);
  await cp(join(ROOT, 'LICENSE'), join(target, 'LICENSE'));
  await writeFile(join(target, 'README.md'), readmeFor(manifest, exportMap));

  return {
    name: manifest.name,
    bytes: await sizeOf(await listFiles(target)),
    exports: Object.keys(exportMap).filter((key) => key !== './package.json'),
  };
}

async function readMeasuredSizes(): Promise<Readonly<Record<string, string>>> {
  try {
    const raw = JSON.parse(await readFile(join(ROOT, '.tsir', 'sizes.json'), 'utf8')) as {
      minified?: Record<string, string>;
    };
    return raw.minified ?? {};
  } catch {
    // No `make verify-dist` run yet: say so rather than invent a number.
    return {};
  }
}

async function bakeFrontpage(): Promise<number> {
  const source = join(ROOT, 'src', 'apps', 'frontpage', 'public', 'index.html');
  const html = await readFile(source, 'utf8');
  const sizes = await readMeasuredSizes();
  const tokens: Readonly<Record<string, string>> = {
    __TSIR_VERSION__: '0.0.0',
    __TSIR_BUN__: `${Bun.version} (build)`,
    __TSIR_NODE__: 'n/a (static build)',
    __TSIR_OS__: `${process.platform} ${process.arch}`,
    __TSIR_ENV__: 'production',
    __TSIR_PORT__: '3000',
    __TSIR_STARTED__: new Date().toISOString(),
    __TSIR_STARTED_SHORT__: 'build',
    __TSIR_SIZE_TOKEN__: sizes['token-only'] ?? 'not measured',
    __TSIR_SIZE_CORE__: sizes['core-only'] ?? 'not measured',
    __TSIR_SIZE_EDGE__: sizes['edge-app'] ?? 'not measured',
    __TSIR_SIZE_HTTP__: sizes['http-app'] ?? 'not measured',
    __TSIR_SIZE_CONFIG__: sizes['config-only'] ?? 'not measured',
    __TSIR_SIZE_EDGE_ZOD__: sizes['edge-app-zod'] ?? 'not measured',
    __TSIR_SIZE_LAMBDA__: sizes['lambda-app'] ?? 'not measured',
  };
  // An unknown token used to bake to an em dash, which reads as "measured, but
  // zero" — the exact class of false claim the frontpage check exists to stop.
  // Fail the build instead: a token in the page with no value is a bug here.
  const baked = html.replace(/__TSIR_[A-Z_]+__/g, (token) => {
    const value = tokens[token];
    if (value === undefined) {
      throw new Error(`frontpage/index.html uses ${token}, which bakeFrontpage() does not provide`);
    }
    return value;
  });
  const target = join(DIST, 'frontpage', 'index.html');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, baked);
  return new TextEncoder().encode(baked).byteLength;
}

async function main(): Promise<void> {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(join(DIST, 'framework'), { recursive: true });

  const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
  // `--outDir` follows `--out`: tsconfig.dist.json hard-codes dist/framework, which breaks any other --out.
  const compile = Bun.spawnSync(
    [tsc, '-p', join(ROOT, 'tsconfig.dist.json'), '--outDir', join(DIST, 'framework')],
    {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (compile.exitCode !== 0) {
    process.stderr.write(compile.stderr.toString() || 'tsc failed\n');
    process.exit(1);
  }

  const names = (await readdir(FRAMEWORK_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const results: { name: string; bytes: number; exports: string[] }[] = [];
  for (const name of names) results.push(await buildPackage(name));

  const frontpageBytes = WITH_FRONTPAGE ? await bakeFrontpage() : 0;

  const summary = {
    generatedAt: new Date().toISOString(),
    packages: results.map((result) => ({
      name: result.name,
      bytes: result.bytes,
      exports: result.exports,
    })),
    frontpage: frontpageBytes,
  };
  await writeFile(join(DIST, 'manifest.json'), `${JSON.stringify(summary, null, 2)}\n`);
  // Until the packages are on a registry, a consumer installs from dist/ with these overrides:
  // every @tsir/* range resolves to its folder here, relative to the directory holding dist/.
  const overrides = Object.fromEntries(
    results.map((result) => [
      result.name,
      `file:./dist/framework/${result.name.replace('@tsir/', '')}`,
    ]),
  );
  await writeFile(join(DIST, 'overrides.json'), `${JSON.stringify(overrides, null, 2)}\n`);

  const width = Math.max(...results.map((result) => result.name.length));
  process.stdout.write('\n  distributable source\n\n');
  for (const result of results) {
    process.stdout.write(
      `  ${result.name.padEnd(width)}  ${KB(result.bytes).padStart(9)}   ${String(result.exports.length)} export(s)\n`,
    );
  }
  if (frontpageBytes > 0) {
    process.stdout.write(`  ${'frontpage'.padEnd(width)}  ${KB(frontpageBytes).padStart(9)}\n`);
  }
  process.stdout.write(`\n  ✓ ${DIST}/ (gitignored — rebuild with \`make dist\`)\n\n`);
}

await main();
