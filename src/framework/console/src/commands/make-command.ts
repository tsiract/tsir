/**
 * `tsir make:command <Name>` (CLI-019): writes one project command for `ract`.
 *
 * The file default-exports `defineCommand({...})`. The generated command prints the next step, so
 * a new command is never left unregistered without a hint: it must be listed in `console.commands`
 * and then run as `bun ract <name>`.
 */

import { join } from 'node:path';

import { boolFlag, parseArgs } from '../args.ts';
import { commitWrites, displayPath, type GeneratedFile } from '../generator.ts';
import { EXIT, info, ok, style, UsageError } from '../output.ts';
import { isIdentifier, toKebab } from './naming.ts';
import { pendingTestFile } from './pending-test.ts';

export function commandTemplate(name: string): string {
  return `import { defineCommand } from '@tsir/console';

export default defineCommand({
  name: '${name}',
  summary: 'TODO: describe ${name} in one line',
  async run(argv: readonly string[]): Promise<number> {
    process.stdout.write(\`${name} ran with \${String(argv.length)} argument(s)\\n\`);
    process.stdout.write('next: list "${name}" in console.commands in tsir.js, then run: bun ract ${name}\\n');
    return 0;
  },
});
`;
}

export async function makeCommandCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--force': { type: 'boolean', description: 'overwrite an existing file' },
    '--dry-run': { type: 'boolean', description: 'print the files that would be written' },
  });
  const input = args.positionals[0];
  if (input === undefined) {
    throw new UsageError('tsir make:command <Name>', 'e.g. `tsir make:command Ping`');
  }
  if (!isIdentifier(input)) {
    throw new UsageError(
      `"${input}" is not a valid command name`,
      'use PascalCase, e.g. Ping: the command becomes `bun ract ping`',
    );
  }
  const name = toKebab(input);
  const root = process.cwd();
  const file = join(root, 'src', 'commands', `${name}.command.ts`);
  const generated: GeneratedFile[] = [
    { path: file, contents: commandTemplate(name) },
    pendingTestFile(file, `${input}Command`),
  ];
  const dryRun = boolFlag(args, '--dry-run');
  const plan = await commitWrites(generated, { force: boolFlag(args, '--force'), dryRun });
  for (const entry of plan) {
    const shown = displayPath(entry.path);
    if (dryRun) info(`  ${style.dim(`would ${entry.action}`)} ${shown}`);
    else ok(`${entry.action === 'overwrite' ? 'overwrote' : 'created'} ${shown}`);
  }
  if (!dryRun) {
    info(
      `  ${style.dim('next:')} list "${name}" in console.commands in tsir.js, then run \`bun ract ${name}\``,
    );
  }
  return EXIT.ok;
}
