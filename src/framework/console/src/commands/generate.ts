/**
 * Generators.
 *
 * Rules:
 *   · generated code compiles under the strictest config with no suppressions,
 *   · no facades, no hidden dependencies, no `any`,
 *   · never overwrite an existing file without `--force`,
 *   · print the next command to run.
 */

import { chmodSync, existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { boolFlag, parseArgs } from '../args.ts';
import { commitWrites, displayPath, type GeneratedFile, type PlannedWrite } from '../generator.ts';
import { CliError, EXIT, info, ok, style, UsageError, warn } from '../output.ts';
import { findConfigFile } from '../project.ts';
import { RACT_MODE, RACT_TEMPLATE } from './project-command.ts';
import { scopedName, splitAppModule } from './naming.ts';

const APP_TEMPLATE = (name: string): string => `import { defineApp } from '@tsir/core';
import { createFetchHandler } from '@tsir/http';
import { collectRouteEntries, compileRoutes } from '@tsir/router';
import { spec } from './config.ts';
import { home } from './home/index.ts';
import './home/http/home.controller.ts';

export default defineApp({
  name: '${name}',
  config: spec,
  modules: [home.module],
});

// Import each controller above before compiling the route table.
export const handler = createFetchHandler(compileRoutes(collectRouteEntries()));
`;

const HOME_ROUTES = `import { RouteRegistry, routeModule } from '@tsir/router';

export const registry = new RouteRegistry();
export const home = routeModule({ name: 'home', registry, unit: 'http' });
`;

const HOME_CONTROLLER = `import { Controller, Get } from '@tsir/router';
import { registry } from '../routes.ts';

@Controller(registry, '')
export class HomeController {
  @Get('/')
  index(): { message: string } {
    return { message: 'Welcome to Tsir' };
  }
}
`;

const CONFIG_TEMPLATE = (name: string): string => `import { defineConfig, env } from '@tsir/config';

export const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
  APP_NAME: env.string({ default: '${name}' }),
});

export type AppConfig = typeof spec;
`;

const TSR_CONFIG_TEMPLATE = (name: string): string => `// tsir.js — canonical project configuration
//
// Phase 1 keeps this file intentionally small: it tells the CLI where the
// application entry lives. Presets, managed regions, and deploy topology join
// it in later phases; the shape below is a forward-compatible subset.

export default {
  app: {
    name: '${name}',
    entry: './app.ts',
  },
};
`;

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
  return [
    {
      name: 'routes.ts',
      contents: `import { RouteRegistry, routeModule as _routeModule } from '@tsir/router';

/** This module's route table. Only its own controllers add to it. */
export const registry = new RouteRegistry();

export const ${camel} = _routeModule({
  name: '${kebab}',
  registry,
  unit: 'http',
});
`,
    },
    {
      name: `http/${kebab}.controller.ts`,
      contents: `import { Controller, Get } from '@tsir/router';

import { registry } from '../routes.ts';

@Controller(registry, '${prefix}')
export class ${base}Controller {
  @Get('/')
  list(): unknown {
    return { items: [] };
  }
}
`,
    },
    {
      name: 'index.ts',
      contents: `/** The module's public surface. Other modules import from here, and nowhere deeper. */
export { ${camel}, registry } from './routes.ts';
`,
    },
    {
      name: `${kebab}.test.ts`,
      contents: `import { describe, expect, test } from 'bun:test';
import { defineConfig, env } from '@tsir/config';
import { defineApp } from '@tsir/core';
import { createTestApp } from '@tsir/testing';

import { ${camel} as _module } from './index.ts';
import './http/${kebab}.controller.ts';

const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'test' }),
});

describe('${kebab} module', () => {
  test('boots on its own and serves its route', async () => {
    const app = defineApp({ name: '${kebab}-test', config: spec, modules: [_module.module] });
    const harness = await createTestApp(app, { env: { APP_ENV: 'test' } });
    try {
      const paths = harness.routes().routes.map((route) => route.path);
      expect(paths.some((path) => path.startsWith('${prefix}'))).toBe(true);
    } finally {
      await harness.dispose();
    }
  });
});
`,
    },
  ];
}

const TEST_TEMPLATE = (name: string): string => `import { describe, expect, test } from 'bun:test';
import { createTestApp } from '@tsir/testing';

import app from '../app.ts';

describe('${name}', () => {
  test('boots through the production path', async () => {
    const harness = await createTestApp(app, { env: { APP_ENV: 'test' } });
    expect(harness.app.state.kind).toBe('ready');
    await harness.dispose();
    expect(harness.app.state.kind).toBe('stopped');
  });
});
`;

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
  const root = resolve(process.cwd(), name);
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
  const dependencies = Object.fromEntries(
    ['console', 'config', 'core', 'http', 'router', 'testing', 'validate'].map((part) => [
      `@tsir/${part}`,
      packages === undefined ? '0.0.0' : 'workspace:*',
    ]),
  );

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
          ...(packages === undefined ? {} : { workspaces: [`${packages}/*`] }),
        },
        null,
        2,
      ) + '\n',
    ],
    ['tsir.js', TSR_CONFIG_TEMPLATE(name)],
    ['app.ts', APP_TEMPLATE(name)],
    ['config.ts', CONFIG_TEMPLATE(name)],
    ['home/index.ts', "export { home } from './routes.ts';\n"],
    ['home/routes.ts', HOME_ROUTES],
    ['home/http/home.controller.ts', HOME_CONTROLLER],
    ['.gitignore', 'node_modules/\n.env\n.tsir/\n'],
    [
      'tsconfig.json',
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ESNext',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
          },
        },
        null,
        2,
      ) + '\n',
    ],
    ['ract', RACT_TEMPLATE],
    // CLI-018: `ract` has no extension, so prettier cannot parse it and must ignore it by name.
    ['.prettierignore', 'ract\n'],
    ['test/app.test.ts', TEST_TEMPLATE(name)],
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
  info(`  created ${style.bold(name)} — next steps:`);
  info(`    ${style.cyan(`cd ${name}`)}`);
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
