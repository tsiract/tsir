/**
 * `tsir make:controller <name> <module> [--path /prefix] [--unit <unit>]`.
 * Controllers live in an existing module and register with its route registry.
 */

import { join } from 'node:path';

import { parseArgs, stringFlag, boolFlag } from '../args.ts';
import { commitWrites, displayPath, type GeneratedFile, type PlannedWrite } from '../generator.ts';
import { pendingTestFile } from './pending-test.ts';
import { renderStub } from '../stub.ts';
import { scopedName, requireModule, splitAppModule } from './naming.ts';
import { EXIT, info, ok, style, UsageError } from '../output.ts';

const UNIT = /^[a-z][a-z0-9-]*$/;
const PREFIX = /^\/[A-Za-z0-9/_:.-]*$/;

/** A module owns its registry; an explicit unit overrides the module's default. */
export function controllerTemplate(
  className: string,
  stem: string,
  prefix: string,
  unit?: string,
): string {
  const unitOption = unit === undefined ? '' : `, { unit: '${unit}' }`;
  // The token name is the class name lower-camel with a `Token` suffix:
  // `OrderController` → `orderControllerToken`. `className` already ends in `Controller`, so the
  // suffix is `Token`, not `ControllerToken` (which would render `orderControllerControllerToken`).
  const camel = className.charAt(0).toLowerCase() + className.slice(1);
  return renderStub('controller.ts', { camel, className, stem, prefix, unitOption });
}

export async function makeControllerCommand(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    info(`usage: tsir make:controller <name> <module> [--path /prefix] [--unit <unit>] [--dry-run] [--force]

  tsir make:module shop
  tsir make:controller order shop
  tsir make:controller user-settings shop

The module must already exist. Names become kebab-case filenames and PascalCase classes.
--path changes the default /api/<name>; --unit overrides the module's deploy unit.
--dry-run writes nothing; --force overwrites only the controller and its companion test.
Import the controller in the app entry and replace its intentionally failing test.`);
    return EXIT.ok;
  }
  const args = parseArgs(argv, {
    '--module': { type: 'string', description: 'legacy alternative to the module positional' },
    '--path': { type: 'string', description: 'route prefix (default: /api/<name>)' },
    '--unit': { type: 'string', description: 'override the module deploy unit' },
    '--force': { type: 'boolean', description: 'overwrite controller and test' },
    '--dry-run': { type: 'boolean', description: 'print the files that would be written' },
  });
  const [input, positionalModule] = args.positionals;
  const flagModule = stringFlag(args, '--module');
  if (
    input === undefined ||
    args.positionals.length > 2 ||
    (positionalModule !== undefined && flagModule !== undefined) ||
    (positionalModule === undefined && flagModule === undefined)
  ) {
    throw new UsageError(
      'tsir make:controller <name> <module>',
      'e.g. tsir make:controller order shop',
    );
  }
  const raw = input.endsWith('Controller') ? input.slice(0, -'Controller'.length) : input;
  const { stem, pascal } = scopedName(raw, 'controller');
  const moduleTarget = positionalModule ?? flagModule ?? '';
  const { app, module: moduleArg } = splitAppModule(moduleTarget);
  if (app !== undefined) process.chdir(app);
  const { name: moduleName, dir: moduleDir } = requireModule(moduleArg);
  const prefix = stringFlag(args, '--path') ?? `/api/${stem}`;
  if (!PREFIX.test(prefix))
    throw new UsageError(
      `"${prefix}" is not a valid route prefix`,
      'start it with /, e.g. /api/orders',
    );
  const unit = stringFlag(args, '--unit');
  if (unit !== undefined && !UNIT.test(unit))
    throw new UsageError(
      `"${unit}" is not a valid unit name`,
      'use lowercase letters, digits and -',
    );
  const className = `${pascal}Controller`;
  const path = join(moduleDir, 'http', `${stem}.controller.ts`);
  const generated: GeneratedFile[] = [
    { path, contents: controllerTemplate(className, stem, prefix, unit) },
    pendingTestFile(path, className),
  ];
  const dryRun = boolFlag(args, '--dry-run');
  const plan: PlannedWrite[] = await commitWrites(generated, {
    force: boolFlag(args, '--force'),
    dryRun,
  });
  for (const entry of plan) {
    const shown = displayPath(entry.path);
    if (dryRun) info(`  ${style.dim(`would ${entry.action}`)} ${shown}`);
    else ok(`${entry.action === 'overwrite' ? 'overwrote' : 'created'} ${shown}`);
  }
  if (!dryRun) {
    info(
      `  ${style.dim('import the controller in your app entry:')} ./${moduleName}/http/${stem}.controller.ts`,
    );
    info(`  ${style.dim('ensure the module is imported and registered in defineApp modules')}`);
    info(`  ${style.dim('replace the intentionally failing generated test, then run tsir test')}`);
  }
  return EXIT.ok;
}
