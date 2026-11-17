/**
 * `tsir bootstrap --migrate-config` (CFG-122).
 *
 * Reads the project file's current format and prints the migrated `database` block. It never
 * writes: the flat block is unmanaged text, and `doctor --fix` and bootstrap only edit managed
 * regions. The user replaces the block by hand, which keeps their comments.
 */

import { pathToFileURL } from 'node:url';

import { migrateProject, renderLiteral, type ProjectValue } from '@tsir/config';

import { EXIT, info, jsonDocument, style, UsageError, symbols } from '../output.ts';
import { findConfigFile } from '../project.ts';

export interface MigrationPlan {
  readonly configPath: string;
  readonly from: number;
  readonly to: number;
  readonly steps: readonly string[];
  /** The rendered `database` block to paste, or `undefined` when the file is already current. */
  readonly block: string | undefined;
}

/** Reads `tsir.js` and plans the format migration. Reads only; never writes. */
export async function planConfigMigration(cwd: string): Promise<MigrationPlan> {
  const configPath = findConfigFile(cwd);
  const module: unknown = await import(`${pathToFileURL(configPath).href}?t=${String(Date.now())}`);
  const exported = (module as { default?: unknown }).default;
  if (typeof exported !== 'object' || exported === null || Array.isArray(exported)) {
    throw new UsageError('the project file must default-export an object');
  }
  const result = migrateProject(exported as ProjectValue);
  const database = (result.value as { database?: unknown }).database;
  return {
    configPath,
    from: result.from,
    to: result.to,
    steps: result.steps,
    block:
      result.steps.length === 0 || database === undefined
        ? undefined
        : `database: ${renderLiteral(database)},`,
  };
}

/** Prints the plan. Returns the exit code. */
export async function migrateConfig(cwd: string, json: boolean): Promise<number> {
  const plan = await planConfigMigration(cwd);
  const name = plan.configPath.slice(cwd.length + 1);
  if (json) {
    info(
      jsonDocument({
        ok: true,
        config: name,
        from: plan.from,
        to: plan.to,
        steps: plan.steps,
        written: false,
        block: plan.block ?? null,
      }),
    );
    return EXIT.ok;
  }
  if (plan.block === undefined) {
    info(`  ${style.green(symbols.check)} ${name} is already at format ${String(plan.to)}`);
    return EXIT.ok;
  }
  info(`  ${style.bold(`${name}: format ${String(plan.from)} → ${String(plan.to)}`)}`);
  info(`  ${style.dim(`steps: ${plan.steps.join(', ')}`)}`);
  info('');
  info(plan.block);
  info('');
  info(
    `  ${style.dim('nothing written — replace the flat database block in tsir.js with the block above')}`,
  );
  return EXIT.ok;
}
