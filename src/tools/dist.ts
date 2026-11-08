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
 * `--packages` cuts the build short after the packages themselves: no application copy, no docs
 * site, no launcher, no root manifest, no `bun install`. That is the core engineering build
 * (`make build`) — proving the framework compiles and emits — while the full run is the
 * distribution assembly (`make dist`). One tool, one compile, two products, so the two can never
 * disagree about how a package is emitted.
 *
 * Usage: bun src/tools/dist.ts [--out dist] [--no-frontpage] [--packages]
 */

import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { buildDocs } from './docs-site.ts';

const ROOT = resolve(import.meta.dir, '..', '..');
const FRAMEWORK_DIR = join(ROOT, 'src', 'framework');
const DIST = resolve(ROOT, argValue(Bun.argv.slice(2), '--out', 'dist'));
const WITH_FRONTPAGE = !Bun.argv.includes('--no-frontpage');
/** Emit the packages only: the core build. The full run assembles the distribution. */
const PACKAGES_ONLY = Bun.argv.includes('--packages');

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

/**
 * Files a package needs at run time that the TypeScript compiler does not emit.
 *
 * Keyed by **directory name** (`buildPackage` is called with the directory, not the manifest
 * name); values are paths relative to that package's root. Keep the list small and
 * justified — every entry is an asset someone can forget to update. `@tsir/console` is the one
 * package with such an asset: `tsir new` renders its project templates from `stubs/new/*.slug`,
 * which are data, not code. Without them the distribution ships a `tsir new` that fails with
 * `ENOENT: … framework/console/stubs/new/tsir.js.slug`, and nothing upstream notices, because a
 * missing template is not a type error.
 */
const RUNTIME_ASSETS: Readonly<Record<string, readonly string[]>> = {
  console: ['src/stubs'],
};

/** Directories inside a package that exist only for framework development. */
const ENGINEERING_ONLY_DIRECTORIES: readonly string[] = ['commands/fixtures'];

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
 * Rewrites a source package's `exports` map for the flattened distribution.
 *
 * Source paths are `./src/<rest>.ts` (each package keeps its own `src/` in the
 * repository). The distribution flattens `src/` away and emits JavaScript, so
 * every path becomes `./<rest>.js` — but the *export keys* are preserved, so a
 * consumer importing `@tsir/queue/memory` still resolves even though the file
 * lives at `drivers/memory.js`.
 */
function rewriteExports(sourceExports: Record<string, unknown>): Record<string, unknown> {
  const rewritePath = (value: unknown, isTypes: boolean): unknown => {
    if (typeof value !== 'string') return value;
    if (value === './package.json') return value;
    if (!/^\.\/src\/.+\.ts$/u.test(value) || value.includes('..')) return value;
    const ext = isTypes ? '.d.ts' : '.js';
    return `./${value.slice('./src/'.length).replace(/\.ts$/u, ext)}`;
  };

  const map: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sourceExports)) {
    if (typeof value === 'string') {
      map[key] = rewritePath(value, false);
    } else if (value !== null && typeof value === 'object') {
      const rewritten: Record<string, unknown> = {};
      for (const [cond, path] of Object.entries(value as Record<string, unknown>)) {
        rewritten[cond] = rewritePath(path, cond === 'types');
      }
      map[key] = rewritten;
    } else {
      map[key] = value;
    }
  }
  return map;
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
    'Packages are not published yet. After setting up the Tsir distribution workspace,',
    'add this package to your application:',
    '',
    '```bash',
    `bun add '${manifest.name}@workspace:*'`,
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

  // **Non-TypeScript runtime assets.** `tsc` emits JavaScript and declarations, so anything a
  // package reads at run time that is not TypeScript disappears here. `@tsir/console` is the one
  // such package: `tsir new` renders its project templates from `src/stubs/**/*.slug`, which are
  // data. Without them the distribution ships a `tsir new` that fails with
  // `ENOENT: ... framework/console/stubs/new/tsir.js.slug` — the command is half the point of the
  // distribution, and a missing template is not a type error, so nothing upstream notices.
  for (const asset of RUNTIME_ASSETS[name] ?? []) {
    // `asset` is `src/stubs` in the source tree; the distribution has no `src/` level, so the copy
    // lands beside the emitted JavaScript (`stubs/`), which is where `stub.ts` resolves it from.
    await cp(join(sourceDir, asset), join(target, asset.replace(/^src\//u, '')), {
      recursive: true,
    });
  }

  // **Engineering-only emitted output.** `tsconfig.dist.json` compiles every `.ts` under a
  // package, which includes the fixtures and the tests' helpers — those exist so the framework can
  // be *developed*, and a distribution that ships them ships a product containing its own test
  // harness (`make dist-check` catches it, and this is what removes it). `*.test.ts` is already
  // excluded from the compile; these directories are the part tsc cannot know about.
  for (const engineeringOnly of ENGINEERING_ONLY_DIRECTORIES) {
    await rm(join(target, engineeringOnly), { recursive: true, force: true });
  }

  const files = await listFiles(target);
  // Preserve the source package's export keys (e.g. `@tsir/queue/memory` maps
  // to `drivers/memory.js`); only the paths get rewritten for the flattened
  // distribution. Packages without an explicit exports map fall back to the
  // file-tree-derived map.
  const exportMap =
    manifest.exports !== undefined ? rewriteExports(manifest.exports) : exportsMap(files, target);
  // Source package bin paths point under src/ at TypeScript. Distribution flattens
  // src/ and emits JavaScript, so preserve a runnable CLI rather than a dangling link.
  const bin =
    manifest.bin === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(manifest.bin).map(([command, path]) => {
            if (!/^\.\/src\/.+\.ts$/u.test(path) || path.includes('..')) {
              throw new Error(`${manifest.name}: unsupported bin path ${path}`);
            }
            return [command, `./${path.slice('./src/'.length).replace(/\.ts$/u, '.js')}`];
          }),
        );
  for (const file of Object.values(bin ?? {})) {
    const fullPath = join(target, file);
    if (!files.includes(fullPath))
      throw new Error(`${manifest.name}: missing emitted binary ${file}`);
    await chmod(fullPath, 0o755);
  }

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
    ...(bin === undefined ? {} : { bin }),
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
  const target = join(DIST, 'apps', 'frontpage', 'index.html');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, baked);
  if ((await buildDocs()) !== 0)
    throw new Error('Cannot distribute a frontpage with broken documentation links.');
  await cp(join(ROOT, 'build', 'docs-site'), join(DIST, 'apps', 'frontpage', 'docs'), {
    recursive: true,
  });
  return new TextEncoder().encode(baked).byteLength;
}

export function compilerDiagnostics(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): string {
  return `${stdout}${stderr}` || `tsc failed (exit ${String(exitCode)})\n`;
}

async function main(): Promise<void> {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(join(DIST, 'framework'), { recursive: true });

  // Run TypeScript with the same Bun executable as this script. The `tsc` shim
  // has a Node shebang, but Node is not required to build this Bun project.
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    await stat(tsc);
  } catch {
    throw new Error('TypeScript is not installed. Run `make install` from the repository root.');
  }
  // `--outDir` follows `--out`: tsconfig.dist.json hard-codes dist/framework, which breaks any other --out.
  const compile = Bun.spawnSync(
    [
      process.execPath,
      tsc,
      '-p',
      join(ROOT, 'tsconfig.dist.json'),
      '--outDir',
      join(DIST, 'framework'),
    ],
    {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (compile.exitCode !== 0) {
    // TypeScript writes diagnostics to stdout, not stderr, on both macOS and Linux.
    process.stderr.write(
      compilerDiagnostics(compile.stdout.toString(), compile.stderr.toString(), compile.exitCode),
    );
    process.exit(1);
  }

  const names = (await readdir(FRAMEWORK_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const results: { name: string; bytes: number; exports: string[] }[] = [];
  for (const name of names) results.push(await buildPackage(name));

  if (PACKAGES_ONLY) {
    const width = Math.max(...results.map((result) => result.name.length));
    process.stdout.write('\n  framework packages\n\n');
    for (const result of results) {
      process.stdout.write(
        `  ${result.name.padEnd(width)}  ${KB(result.bytes).padStart(9)}   ${String(result.exports.length)} export(s)\n`,
      );
    }
    process.stdout.write(
      `\n  ✓ ${DIST}/framework/ — packages only (\`make dist\` assembles the distribution)\n\n`,
    );
    return;
  }

  const frontpageBytes = WITH_FRONTPAGE ? await bakeFrontpage() : 0;

  // Ship the actual applications. They are runnable TypeScript examples, not
  // published framework packages.
  const apps = join(DIST, 'apps');
  for (const name of ['admin.product.com']) {
    await cp(join(ROOT, 'src', 'apps', name), join(apps, name), {
      recursive: true,
      /**
       * What a *runnable* application needs, not what developing it needs.
       *
       * `e2e/` and `playwright.config.ts` are development-only: they drive a browser against a
       * running server. Shipping them made `tsir test` inside the archive pick up Playwright
       * specs and fail with "Playwright Test did not expect test.describe() to be called here" —
       * a distribution that cannot run its own test command. `migrations/meta/` is Drizzle's
       * local bookkeeping and is regenerated, so it stays behind with the rest.
       */
      filter: (path) =>
        ![
          'node_modules',
          '.tsir',
          'dist',
          'coverage',
          '.env',
          '.build',
          // Development-only test runners and browser suites.
          'e2e',
          'playwright.config.ts',
          // Editor / tooling state.
          '.eslintcache',
        ].includes(basename(path)),
    });
    await writeFile(
      join(apps, name, 'README.md'),
      `# ${name} example

A complete admin panel application demonstrating authentication, RBAC, i18n, email,
and a Svelte 5 SPA frontend.

Requirements: Postgres (set \`DATABASE_URL\`).

Run from this directory after installing the distribution dependencies:

    bun run ../../framework/console/src/cli.ts migrate
    bun run ../../framework/console/src/cli.ts dev

The frontend is prebuilt in \`public/\`. Rebuild it with \`bun run client/build.ts\`.
The distribution is generated. Copy an example elsewhere before making changes: rebuilding it removes dist/.
`,
    );
  }
  if (WITH_FRONTPAGE) {
    await cp(join(DIST, 'apps', 'frontpage'), join(DIST, 'src', 'frontpage'), { recursive: true });
    await cp(join(DIST, 'apps', 'frontpage', 'docs'), join(DIST, 'src', 'docs'), {
      recursive: true,
    });
    // The standalone docs copy is a sibling of frontpage, not nested under it.
    // Rewrite only links back to the site home, preserving all docs-relative links.
    const docsRoot = join(DIST, 'src', 'docs');
    for (const file of await listFiles(docsRoot)) {
      if (!file.endsWith('.html')) continue;
      const depth = relative(docsRoot, dirname(file)).split(/[\\/]/u).filter(Boolean).length;
      const home = '../'.repeat(depth + 1);
      const html = await readFile(file, 'utf8');
      await writeFile(
        file,
        html
          .replaceAll(`href="${home}"`, `href="${home}frontpage/"`)
          .replaceAll(`href="${home}#`, `href="${home}frontpage/#`),
      );
    }
  }

  // No timestamp: two runs over the same sources must produce the same tree, or `make dist` cannot
  // be checked and a release cannot be reproduced. What a consumer needs from this file is *which*
  // packages and how big, all of which are inputs already. The build time is available from the
  // filesystem (`stat dist/manifest.json`) and would only differ between otherwise-identical runs.
  const summary = {
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

  // Workspaces keep the launcher, apps, and modules on the same package instances.
  const localPackages = Object.fromEntries(results.map((result) => [result.name, 'workspace:*']));
  // External dependencies of workspace packages must be declared at the root so
  // `bun install` hoists them into dist/node_modules. Without this, an app booted
  // from dist/apps cannot resolve transitive deps such as `zod`.
  const externalDeps: Record<string, string> = {};
  for (const result of results) {
    const pkg = JSON.parse(
      await readFile(
        join(DIST, 'framework', result.name.replace('@tsir/', ''), 'package.json'),
        'utf8',
      ),
    ) as { dependencies?: Record<string, string> };
    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      if (!dep.startsWith('@tsir/')) externalDeps[dep] = range;
    }
  }
  const rootManifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  await writeFile(
    join(DIST, 'package.json'),
    `${JSON.stringify(
      {
        name: 'tsir-distribution',
        version: rootManifest.version,
        private: true,
        type: 'module',
        workspaces: ['framework/*', 'apps/*'],
        dependencies: { ...localPackages, ...externalDeps },
      },
      null,
      2,
    )}\n`,
  );
  await cp(join(ROOT, 'LICENSE'), join(DIST, 'LICENSE'));
  await writeFile(
    join(DIST, 'README.md'),
    `# Tsir distribution

This generated directory is rebuilt by \`make dist\`. Do not keep your own work here.

\`\`\`text
.
├── tsir                         # command; ./tsir --help
├── bin/tsir                     # add bin/ to PATH
├── apps/
│   ├── frontpage/               # static welcome page and docs/
│   └── admin.product.com/       # admin panel app (auth, RBAC, i18n, mail, Svelte SPA)
├── src/
│   ├── frontpage/               # compatibility copy of the static site
│   └── docs/                    # static documentation
├── framework/<package>/         # emitted @tsir packages, not application modules
├── package.json  bun.lock       # distribution workspace
└── manifest.json  README.md  LICENSE
\`\`\`

The maintained examples live in this distribution, not in your application. A new application
created elsewhere has \`home/\` as its first module. Run \`tsir make:module shop\` first, then
\`tsir make:controller order shop\` and \`tsir make:model order shop\` to create
\`shop/http/order.controller.ts\` and \`shop/models/order.model.ts\`. Generators do not infer
or create missing modules. See \`src/docs/guides/controllers.html\` for registration and
\`src/docs/guides/database.html\` for Drizzle setup and migrations.

A repository build installs the distribution dependencies automatically. After extracting a release
archive, run \`bun install --ignore-scripts\` here (the archive does not contain node_modules).
Run \`./tsir --help\`, or from the distribution root run \`./tsir route:list --app apps/admin.product.com\`,
\`./tsir test --app apps/admin.product.com\`, and \`./tsir dev --app apps/admin.product.com\` (\`--app\` / \`-C\` runs
any project-bound command from outside its directory). To create your own app, work outside this
directory and use \`/path/to/distribution/tsir new my-app\`; do not create it under dist/.
Packages are pre-alpha and not published; generated apps refer to this distribution's workspace.
`,
  );
  await mkdir(join(DIST, 'bin'), { recursive: true });
  const launcher = `#!/bin/sh
# The distribution owns its framework; apps use their own local CLI when installed.
set -e
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "\${1-}" in
  new) export TSIR_DIST="$root" ;;
esac
current="$PWD"
while :; do
  if [ -f "$current/node_modules/@tsir/console/cli.js" ]; then
    exec bun "$current/node_modules/@tsir/console/cli.js" "$@"
  fi
  [ "$current" = / ] && break
  current=$(dirname -- "$current")
done
if [ ! -f "$root/node_modules/@tsir/console/cli.js" ]; then
  echo 'Tsir distribution dependencies are missing. Run bun install in the distribution directory.' >&2
  exit 3
fi
exec bun "$root/node_modules/@tsir/console/cli.js" "$@"
`;
  const launcherPath = join(DIST, 'bin', 'tsir');
  await writeFile(launcherPath, launcher);
  await chmod(launcherPath, 0o755);
  const rootLauncher = join(DIST, 'tsir');
  await writeFile(
    rootLauncher,
    `#!/bin/sh
exec "$(dirname -- "$0")/bin/tsir" "$@"
`,
  );
  await chmod(rootLauncher, 0o755);

  // A local build should be usable immediately, not merely contain package files.
  // Published archives deliberately exclude installed dependencies and are installed after extraction.
  const install = Bun.spawnSync([process.execPath, 'install', '--ignore-scripts'], {
    cwd: DIST,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (install.exitCode !== 0) {
    throw new Error(
      `Cannot install distribution dependencies:\n${install.stdout.toString()}${install.stderr.toString()}`,
    );
  }

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
  process.stdout.write(`\n  ✓ ${DIST}/ (gitignored — rebuild with \`make dist\`)\n`);
  process.stdout.write(
    `  → ${DIST}/tsir --help · applications in ${DIST}/apps/ · read ${DIST}/README.md\n\n`,
  );
}

if (import.meta.main) await main();
