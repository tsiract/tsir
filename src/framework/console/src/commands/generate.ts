/**
 * Generators.
 *
 * Rules:
 *   · generated code compiles under the strictest config with no suppressions,
 *   · no facades, no hidden dependencies, no `any`,
 *   · never overwrite an existing file without `--force`,
 *   · print the next command to run.
 *
 * Code templates live in `stubs/` as `.slug` files (e.g. `stubs/new/app.ts.slug`).
 * `renderStub()` reads the file and substitutes `{{variable}}` placeholders.
 * Keep the generator logic here and the template content in the slugs —
 * editing a generated file's shape should mean editing its `.slug`, not this
 * module.
 */

import { chmodSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { boolFlag, parseArgs } from '../args.ts';
import { commitWrites, displayPath, type GeneratedFile, type PlannedWrite } from '../generator.ts';
import { CliError, EXIT, info, ok, style, UsageError, warn } from '../output.ts';
import { findConfigFile } from '../project.ts';
import { renderStub } from '../stub.ts';
import { RACT_MODE, RACT_TEMPLATE } from './project-command.ts';
import { scopedName, splitAppModule } from './naming.ts';

export async function newCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--force': { type: 'boolean', description: 'overwrite an existing directory' },
    '--dry-run': { type: 'boolean', description: 'print the files that would be written' },
  });
  const name = args.positionals[0];
  if (name === undefined) {
    throw new UsageError('tsir new <name>', 'the name becomes the directory and the app name');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new UsageError(`"${name}" is not a valid app name`, 'use lowercase kebab-case');
  }

  const force = boolFlag(args, '--force');
  // Applications live in `apps/<name>/`. The workspace root is the directory the developer is
  // working in — or, when they are already inside it, the one that owns `apps/`. Without that
  // second case, running `tsir new` from `apps/` produced `apps/apps/<name>` and every relative
  // `file:` reference below was then computed from the wrong place.
  //
  // Never `app/`, never the distribution root (the guard below refuses that), and never a core
  // source tree.
  const here = resolve(process.cwd());
  const workspaceRoot = basename(here) === 'apps' ? resolve(here, '..') : here;
  const appsDir = resolve(workspaceRoot, 'apps');
  const root = resolve(appsDir, name);
  // Distribution builds replace their entire output directory. Do not let a user
  // accidentally create an application where the next build will delete it.
  const distRoot = process.env['TSIR_DIST'];
  if (distRoot !== undefined) {
    // Resolve symlinks so `/tmp` vs `/private/tmp` (macOS) and other logical
    // path differences do not defeat the guard.
    const realDist = realpathSync(resolve(distRoot));
    const realCwd = realpathSync(process.cwd());
    const fromDist = relative(realDist, resolve(realCwd, name));
    if (
      fromDist === '' ||
      (fromDist !== '..' && !fromDist.startsWith(`..${sep}`) && !isAbsolute(fromDist))
    ) {
      throw new CliError(
        'create applications outside the generated distribution directory',
        EXIT.usage,
        `the distribution is replaced by make dist — cd to another directory and run ${resolve(distRoot, 'tsir')} new ${name}`,
      );
    }
  }
  if (existsSync(root) && !force) {
    throw new CliError(
      `${name}/ already exists`,
      EXIT.failure,
      'pass --force to scaffold into it anyway',
    );
  }

  // The pre-publication packages form a Bun workspace. This preserves a single
  // instance of process-local registries across the app and its CLI.
  const dist = process.env['TSIR_DIST'];
  const packages = dist === undefined ? undefined : join(resolve(dist), 'framework');
  if (packages !== undefined && !existsSync(join(packages, 'console', 'package.json'))) {
    throw new CliError('TSIR_DIST is not a valid Tsir distribution', EXIT.environment);
  }
  // How the application reaches the framework.
  //
  // The packages are not on a registry yet, so the application points at the distribution that
  // created it. Two rules make that a contract rather than an accident:
  //
  //   1. **Relative**, not absolute. The old scaffold wrote `"workspaces": ["/abs/path/dist/framework/*"]`
  //      into `package.json`, which named the machine that scaffolded the app: move the
  //      distribution and the application stops resolving. The reference below is derived from the
  //      application's own location (`apps/<name>/` → `../../dist/framework/<pkg>`), so it survives
  //      a moved or renamed checkout.
  //   2. **`link:`**, not `file:`. A `file:` dependency is *copied* (bun hardlinks it into
  //      `node_modules`), and the copy is made once per dependent, so `@tsir/router` ends up
  //      present several times over — `node_modules/@tsir/router` for the application,
  //      `node_modules/@tsir/testing/node_modules/@tsir/router` for the harness, and so on. The
  //      framework keeps process-local registries (routes, controllers, the container), so two
  //      copies are two registries: the application registers a route in one and the harness
  //      looks for it in another, which showed up as `TEST_UNKNOWN_MODULE` in a fresh scaffold.
  //      `link:` symlinks instead, so every reference resolves to the single package directory.
  //   3. **`overrides`**, not a workspace. A `workspace:*` range resolves only inside the
  //      distribution's own Bun workspace, and only while the app lives inside it. An override
  //      applies to the dependency *and* to every transitive `@tsir/*` range, which is what a
  //      standalone `bun install` needs.
  const parts = [
    'console',
    'config',
    'container',
    'core',
    'database',
    'http',
    'migrate',
    'router',
    'testing',
    'validate',
  ] as const;
  const appDir = resolve(workspaceRoot, 'apps', name);
  const frameworkRoot =
    packages === undefined ? undefined : relative(appDir, packages).split(sep).join('/');
  const dependencies = Object.fromEntries(
    parts.map((part) => [
      `@tsir/${part}`,
      frameworkRoot === undefined ? '0.0.0' : `link:${frameworkRoot}/${part}`,
    ]),
  );
  // A `file:` dependency covers what the application imports. It does **not** cover what the
  // framework packages import from each other: those ranges are version strings, and with nothing
  // on a registry `bun install` fails to resolve every transitive `@tsir/*`. Overrides apply to the
  // whole tree, which is what makes a standalone install work while the packages are unpublished.
  // The ranges stay version-shaped (`0.0.0`) so removing this block, once the packages are on a
  // registry, is a one-line change with no other edits.
  const overrides =
    packages === undefined || frameworkRoot === undefined
      ? undefined
      : Object.fromEntries(
          // Every package the distribution ships, not only the ones the application imports
          // directly: the framework packages depend on each other, and a transitive range that is
          // not overridden is looked up on a registry that has no @tsir packages yet.
          readdirSync(packages, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()
            .map((dir) => [`@tsir/${dir}`, `link:${frameworkRoot}/${dir}`]),
        );
  // Drizzle is the ORM the database bootstrap exposes; it is not a @tsir package.
  dependencies['drizzle-orm'] = '0.45.4';
  // The tsconfig above names `bun` in `types`, and the generated sources use Bun/Node globals.
  // Shipping the tsconfig without the package it references is what made a fresh scaffold fail to
  // typecheck.
  const devDependencies = { '@types/bun': 'latest' };

  const stubVars = { name };
  const files: readonly (readonly [string, string])[] = [
    [
      'package.json',
      // CLI-018: the script names the file by path. A script called `ract` that ran `bun ract` would
      // match itself: Bun resolves a package script before a file of the same name.
      JSON.stringify(
        {
          name,
          version: '0.0.0',
          private: true,
          type: 'module',
          scripts: { ract: 'bun ./ract' },
          dependencies,
          devDependencies,
          ...(overrides === undefined ? {} : { overrides }),
        },
        null,
        2,
      ) + '\n',
    ],
    ['tsir.js', renderStub('new/tsir.js', stubVars)],
    ['app.ts', renderStub('new/app.ts', stubVars)],
    ['config.ts', renderStub('new/config.ts', stubVars)],
    ['config/database.ts', renderStub('new/config/database.ts', stubVars)],
    ['database.ts', renderStub('new/database.ts', stubVars)],
    ['home/index.ts', renderStub('new/home/index.ts', stubVars)],
    ['home/registry.ts', renderStub('new/home/registry.ts', stubVars)],
    ['home/routes.ts', renderStub('new/home/routes.ts', stubVars)],
    ['home/http/home.controller.ts', renderStub('new/home/http/home.controller.ts', stubVars)],
    // Empty migrations directory — `tsir make:migration` adds the first one.
    ['migrations/.gitkeep', ''],
    ['.gitignore', 'node_modules/\n.env\n.tsir/\ndist/\n'],
    [
      'tsconfig.json',
      JSON.stringify(
        {
          // A Bun application needs Bun's globals and Node's builtin types: the generated
          // `app.ts` imports `node:async_hooks`, `database.ts` uses `node:path` and
          // `import.meta.dir`, and `@tsir/database` references `bun:sqlite`. Without `types` and
          // `skipLibCheck` the scaffold failed its own typecheck on a clean machine
          // (`TS2591: Cannot find name 'node:async_hooks'`, `TS2339: Property 'dir' does not exist
          // on type 'ImportMeta'`, and dozens of errors inside `drizzle-orm`'s own `.d.ts` files).
          compilerOptions: {
            target: 'ESNext',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            // Declaration files from dependencies are not this project's to fix.
            skipLibCheck: true,
            types: ['bun'],
          },
        },
        null,
        2,
      ) + '\n',
    ],
    ['ract', RACT_TEMPLATE],
    // CLI-018: `ract` has no extension, so prettier cannot parse it and must ignore it by name.
    ['.prettierignore', 'ract\n'],
    ['test/app.test.ts', renderStub('new/test/app.test.ts', stubVars)],
    [
      '.env.example',
      '# Copy to .env and fill in. Never commit real secrets.\nAPP_ENV=development\n',
    ],
  ];

  const generated: GeneratedFile[] = files.map(([relativePath, contents]) => ({
    path: join(root, relativePath),
    contents,
  }));
  const dryRun = boolFlag(args, '--dry-run');
  const plan = await commitWrites(generated, { force, dryRun });
  reportPlan(plan, dryRun);
  if (dryRun) return EXIT.ok;
  // CLI-018: `ract` must be executable so `./ract` works after a clone.
  chmodSync(join(root, 'ract'), RACT_MODE);

  info('');
  info(`  created ${style.bold(`apps/${name}`)} — next steps:`);
  info(`    ${style.cyan(`cd apps/${name}`)}`);
  info(`    ${style.cyan('bun install')}   ${style.dim('install the application dependencies')}`);
  info(`    ${style.cyan('tsir dev')}      ${style.dim('serve the application')}`);
  if (dist === undefined) {
    warn(
      'No distribution was detected. @tsir packages are not yet published; use the distribution launcher to scaffold an installable app.',
    );
  }
  info('');
  return EXIT.ok;
}

/**
 * The files `make:module` writes. A module owns its components in typed
 * subdirectories: `http/` for controllers, `models/` for schemas, etc. The
 * module root holds `routes.ts` (the route registry), `index.ts` (the public
 * surface), and the module's test.
 */
function moduleFiles(
  base: string,
  kebab: string,
): readonly { readonly name: string; readonly contents: string }[] {
  const camel = base.charAt(0).toLowerCase() + base.slice(1);
  const prefix = `/${kebab}`;
  const vars = { base, camel, kebab, prefix };
  return [
    { name: 'registry.ts', contents: renderStub('module/registry.ts', vars) },
    { name: 'routes.ts', contents: renderStub('module/routes.ts', vars) },
    { name: `http/${kebab}.controller.ts`, contents: renderStub('module/controller.ts', vars) },
    { name: 'index.ts', contents: renderStub('module/index.ts', vars) },
    { name: `${kebab}.test.ts`, contents: renderStub('module/test.ts', vars) },
  ];
}

export async function makeModuleCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--force': { type: 'boolean', description: 'overwrite an existing file' },
    '--dry-run': { type: 'boolean', description: 'print the files that would be written' },
  });
  const name = args.positionals[0];
  if (name === undefined || args.positionals.length !== 1)
    throw new UsageError('tsir make:module <name>', 'e.g. tsir make:module shop');

  // `make:module` accepts `<app>/<name>` to create a module in another app.
  const { app, module: moduleName } = splitAppModule(name);
  if (app !== undefined) process.chdir(app);

  // A module only matters inside an application: without a `tsir.js`, the files
  // are written but nothing registers them. Warn rather than refuse — a user
  // may be scaffolding a directory before adding the project file — but make
  // the gap obvious so the output is not mistaken for a working module.
  try {
    findConfigFile(process.cwd());
  } catch {
    warn(
      'no tsir.js found in this directory — the module is written but not registered by any app',
    );
  }

  const raw = moduleName.endsWith('Module') ? moduleName.slice(0, -'Module'.length) : moduleName;
  const { pascal: base, stem } = scopedName(raw, 'module');
  const dir = join(process.cwd(), stem);
  const dryRun = boolFlag(args, '--dry-run');
  const plan = await commitWrites(
    moduleFiles(base, stem).map((file) => ({
      path: join(dir, file.name),
      contents: file.contents,
    })),
    { force: boolFlag(args, '--force'), dryRun },
  );
  reportPlan(plan, dryRun);
  if (dryRun) return EXIT.ok;

  info(
    `  ${style.dim('register it:')} import { ${toCamel(base)} } from './${stem}/index.ts' and add ${toCamel(base)}.module to modules`,
  );
  return EXIT.ok;
}

function toCamel(base: string): string {
  return base.charAt(0).toLowerCase() + base.slice(1);
}

/** One line per file, so a dry run and a real run read the same way. */
function reportPlan(plan: readonly PlannedWrite[], dryRun: boolean): void {
  for (const entry of plan) {
    const verb = dryRun ? 'would ' : '';
    const action = entry.action === 'overwrite' ? `${verb}overwrite` : `${verb}create`;
    if (dryRun) info(`  ${style.dim(action)} ${displayPath(entry.path)}`);
    else ok(`${action === 'overwrite' ? 'overwrote' : 'created'} ${displayPath(entry.path)}`);
  }
}
