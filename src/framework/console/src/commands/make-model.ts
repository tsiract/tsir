/** Module-owned Drizzle schema scaffolding. This does not create a database or migration. */
import { join } from 'node:path';
import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { commitWrites, displayPath, type GeneratedFile } from '../generator.ts';
import { EXIT, info, ok, style, UsageError } from '../output.ts';
import { requireModule, scopedName, splitAppModule } from './naming.ts';
import { pendingTestFile } from './pending-test.ts';
import { renderStub } from '../stub.ts';

export async function makeModelCommand(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    info(
      'usage: tsir make:model <name> <module> [--dialect sqlite|postgres] [--dry-run] [--force]\n\nGenerate a Drizzle schema in an existing module. SQLite is the default. Install drizzle-orm in your app and create a migration separately.',
    );
    return EXIT.ok;
  }
  const args = parseArgs(argv, {
    '--dialect': { type: 'string', description: 'sqlite (default) or postgres' },
    '--force': { type: 'boolean', description: 'overwrite model and test' },
    '--dry-run': { type: 'boolean', description: 'print files without writing' },
  });
  const [input, moduleInput] = args.positionals;
  if (input === undefined || moduleInput === undefined || args.positionals.length !== 2) {
    throw new UsageError('tsir make:model <name> <module>', 'e.g. tsir make:model order shop');
  }
  const { stem, pascal, camel } = scopedName(input, 'model');
  const dialect = stringFlag(args, '--dialect') ?? 'sqlite';
  if (dialect !== 'sqlite' && dialect !== 'postgres') {
    throw new UsageError(`unknown model dialect "${dialect}"`, 'use sqlite or postgres');
  }
  const { app, module: moduleArg } = splitAppModule(moduleInput);
  if (app !== undefined) process.chdir(app);
  const module = requireModule(moduleArg);
  const table = `${module.name}_${stem}`.replace(/-/g, '_');
  const tableFunction = dialect === 'sqlite' ? 'sqliteTable' : 'pgTable';
  const core = dialect === 'sqlite' ? 'sqlite-core' : 'pg-core';
  const contents = renderStub('model.ts', { tableFunction, core, camel, table, pascal });
  const path = join(module.dir, 'models', `${stem}.model.ts`);
  const generated: GeneratedFile[] = [{ path, contents }, pendingTestFile(path, `${pascal} model`)];
  const dryRun = boolFlag(args, '--dry-run');
  const plan = await commitWrites(generated, { force: boolFlag(args, '--force'), dryRun });
  for (const entry of plan) {
    const shown = displayPath(entry.path);
    if (dryRun) info(`  ${style.dim(`would ${entry.action}`)} ${shown}`);
    else ok(`${entry.action === 'overwrite' ? 'overwrote' : 'created'} ${shown}`);
  }
  if (!dryRun)
    info(
      `  ${style.dim('next:')} install drizzle-orm, define columns, create a migration, and replace the failing test`,
    );
  return EXIT.ok;
}
