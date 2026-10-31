/**
 * Generators.
 *
 * Rules:
 *   · generated code compiles under the strictest config with no suppressions,
 *   · no facades, no hidden dependencies, no `any`,
 *   · never overwrite an existing file without `--force`,
 *   · print the next command to run.
 */

import { chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { boolFlag, parseArgs } from '../args.ts';
import { commitWrites, displayPath, type GeneratedFile, type PlannedWrite } from '../generator.ts';
import { CliError, EXIT, info, ok, style, UsageError } from '../output.ts';
import { RACT_MODE, RACT_TEMPLATE } from './project-command.ts';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/;

function toKebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

function assertIdentifier(name: string, kind: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new UsageError(
      `"${name}" is not a valid ${kind} name`,
      'use PascalCase identifiers, e.g. UsersService',
    );
  }
}

const APP_TEMPLATE = (
  name: string,
): string => `import { defineApp, defineModule } from '@tsir/core';
import { defineConfig, env } from '@tsir/config';

export const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
});

const RootModule = defineModule({ name: 'root' });

export default defineApp({
  name: '${name}',
  config: spec,
  modules: [RootModule],
});
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
    entry: './src/app.ts',
  },
};
`;

/**
 * The files `make:module` writes, in the layout the example application uses (MOD-005): a module
 * directory with its own registry, one controller bound to that registry, a public `index.ts`, and
 * a test that boots the module and checks its route. Each file is written only if it is absent.
 */
function moduleFiles(
  base: string,
): readonly { readonly name: string; readonly contents: string }[] {
  const kebab = toKebab(base);
  const camel = base.charAt(0).toLowerCase() + base.slice(1);
  const prefix = `/${kebab}`;
  return [
    {
      name: 'routes.ts',
      contents: `import { RouteRegistry, routeModule } from '@tsir/router';

/** This module's route table. Only its own controllers add to it. */
export const registry = new RouteRegistry();

export const ${camel} = routeModule({
  name: '${kebab}',
  registry,
  unit: 'http',
});
`,
    },
    {
      name: `${kebab}.controller.ts`,
      contents: `import { Controller, Get } from '@tsir/router';

import { registry } from './routes.ts';

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

import { ${camel} } from './index.ts';
import './${kebab}.controller.ts';

const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'test' }),
});

describe('${kebab} module', () => {
  test('boots on its own and serves its route', async () => {
    const app = defineApp({ name: '${kebab}-test', config: spec, modules: [${camel}.module] });
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

import app from '../src/app.ts';

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
  if (existsSync(root) && !force) {
    throw new CliError(
      `${name}/ already exists`,
      EXIT.failure,
      'pass --force to scaffold into it anyway',
    );
  }

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
        },
        null,
        2,
      ) + '\n',
    ],
    ['tsir.js', TSR_CONFIG_TEMPLATE(name)],
    ['src/app.ts', APP_TEMPLATE(name)],
    ['src/config.ts', CONFIG_TEMPLATE(name)],
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
  info(
    `    ${style.cyan('bun add @tsir/core @tsir/config @tsir/testing')}   ${style.dim('(when published)')}`,
  );
  info(`    ${style.cyan('tsir build')}   ${style.dim('generate the manifest')}`);
  info(`    ${style.cyan('tsir dev')}     ${style.dim('boot with lifecycle reporting')}`);
  info('');
  return EXIT.ok;
}

export async function makeModuleCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--force': { type: 'boolean', description: 'overwrite an existing file' },
    '--dry-run': { type: 'boolean', description: 'print the file that would be written' },
  });
  const name = args.positionals[0];
  if (name === undefined) throw new UsageError('tsir make:module <Name>');

  const base = name.endsWith('Module') ? name.slice(0, -'Module'.length) : name;
  assertIdentifier(`${base}Module`, 'module');
  const dir = join(process.cwd(), 'src', 'modules', toKebab(base));
  const dryRun = boolFlag(args, '--dry-run');
  const plan = await commitWrites(
    moduleFiles(base).map((file) => ({ path: join(dir, file.name), contents: file.contents })),
    { force: boolFlag(args, '--force'), dryRun },
  );
  reportPlan(plan, dryRun);
  if (dryRun) return EXIT.ok;

  info(
    `  ${style.dim('register it:')} import { ${toCamel(base)} } from './modules/${toKebab(base)}/index.ts' and add ${toCamel(base)}.module to modules`,
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
