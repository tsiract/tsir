/**
 * `tsir make:seeder <name> [module] [--order n] [--reference]` (CLI-012).
 *
 * The output is one `defineSeeder({...})` file. The contract it fills in is SED-001: a name, an
 * order, a promise that it is idempotent, and the environments it belongs to. The name is what
 * `db:seed --class=` selects by, so it is the class name, not the file name. The file name is a
 * kebab-case stem, which is always a valid module path.
 */

import { join } from 'node:path';

import { parseArgs, stringFlag, boolFlag } from '../args.ts';
import { commitWrites, displayPath, type GeneratedFile, type PlannedWrite } from '../generator.ts';
import { pendingTestFile } from './pending-test.ts';
import { renderStub } from '../stub.ts';
import { requireModule, scopedName, splitAppModule } from './naming.ts';
import { EXIT, info, ok, style, UsageError } from '../output.ts';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/;
const ORDER = /^(0|[1-9][0-9]{0,8})$/;

function toKebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

/** `Users` and `UsersSeeder` both become `UsersSeeder` and `users`. */
export function seederNames(input: string): { className: string; stem: string } {
  const base = input.endsWith('Seeder') ? input.slice(0, -'Seeder'.length) : input;
  if (!IDENTIFIER.test(base)) {
    throw new UsageError(
      `"${input}" is not a valid seeder name`,
      'use PascalCase, e.g. `tsir make:seeder Users` (class UsersSeeder)',
    );
  }
  return { className: `${base}Seeder`, stem: toKebab(base) };
}

export interface SeederTemplateOptions {
  /** Digits only: the caller has already checked it with ORDER, so it is written as-is. */
  readonly order: string;
  /** Reference data is legitimate in production: it needs `--reference-data` at run time. */
  readonly reference: boolean;
}

export function seederTemplate(className: string, options: SeederTemplateOptions): string {
  const environments = options.reference
    ? "['development', 'test', 'staging', 'production']"
    : "['development', 'test']";
  const production = options.reference ? '\n  production: true,' : '';
  return renderStub('seeder.ts', { className, order: options.order, environments, production });
}

export async function makeSeederCommand(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    info(
      'usage: tsir make:seeder <name> [module] [--order n] [--reference] [--dry-run] [--force]\n\nExample: tsir make:seeder order shop. Import it and export it in the app entry seeders array.',
    );
    return EXIT.ok;
  }
  const args = parseArgs(argv, {
    '--order': { type: 'string', description: 'run order (default 100)' },
    '--reference': { type: 'boolean', description: 'reference data, legitimate in production' },
    '--force': { type: 'boolean', description: 'overwrite an existing file' },
    '--dry-run': { type: 'boolean', description: 'print what would be written' },
  });
  const input = args.positionals[0];
  if (input === undefined || args.positionals.length > 2) {
    throw new UsageError('make:seeder needs a name', 'e.g. `tsir make:seeder order shop`');
  }

  const moduleInput = args.positionals[1];
  const raw = input.endsWith('Seeder') ? input.slice(0, -6) : input;
  const { className, stem: legacyStem } = seederNames(
    moduleInput === undefined ? input : scopedName(raw, 'seeder').pascal,
  );
  const stem = moduleInput === undefined ? legacyStem : scopedName(raw, 'seeder').stem;
  const orderText = stringFlag(args, '--order') ?? '100';
  if (!ORDER.test(orderText)) {
    throw new UsageError(`--order must be a non-negative integer, got "${orderText}"`);
  }

  let moduleDir: string | undefined;
  if (moduleInput !== undefined) {
    const { app, module: moduleArg } = splitAppModule(moduleInput);
    if (app !== undefined) process.chdir(app);
    moduleDir = requireModule(moduleArg).dir;
  }
  const path = join(
    moduleDir === undefined ? join(process.cwd(), 'seeders') : join(moduleDir, 'seeders'),
    `${stem}.seeder.ts`,
  );
  const generated: GeneratedFile[] = [
    {
      path,
      contents: seederTemplate(className, {
        order: orderText,
        reference: boolFlag(args, '--reference'),
      }),
    },
  ];
  // CLI-015: every generated part ships with a test that is red until it is implemented.
  const primary = generated[0];
  if (primary !== undefined) generated.push(pendingTestFile(primary.path, className));
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
      `  ${style.dim('next:')} add ${className} to the \`seeders\` array exported by your entry, then \`tsir db:seed --class=${className}\``,
    );
  }
  return EXIT.ok;
}
