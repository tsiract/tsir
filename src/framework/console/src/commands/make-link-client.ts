/**
 * `tsir make:link-client <Name> [--path /prefix]` (CLI-014).
 *
 * The output is a class over the link package's REST client. Its options are constructor-injected
 * (the base URL, the host allowlist, credentials, the observability hook). Nothing reads the
 * environment. Each method takes the caller's `CallContext`, which carries the trace, the deadline
 * and the cancellation, and returns `CallResult<T>`, so the caller must handle the failure case.
 * The response type is declared here, so a call site is typed without a cast.
 */

import { join } from 'node:path';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { commitWrites, displayPath, type GeneratedFile, type PlannedWrite } from '../generator.ts';
import { pendingTestFile } from './pending-test.ts';
import { renderStub } from '../stub.ts';
import { EXIT, info, ok, style, UsageError } from '../output.ts';
import { requireModule, scopedName, splitAppModule, isIdentifier, toKebab } from './naming.ts';

/** A URL path: one or more non-empty segments after a slash. No quotes, spaces, `//` or trailing slash. */
const PREFIX = /^\/[A-Za-z0-9_:.-]+(\/[A-Za-z0-9_:.-]+)*$/;

/** `Billing` and `BillingClient` both give the base `Billing`. */
function baseName(input: string): string {
  const base = input.endsWith('Client') ? input.slice(0, -'Client'.length) : input;
  if (!isIdentifier(base)) {
    throw new UsageError(
      `"${input}" is not a valid client name`,
      'use PascalCase, e.g. `tsir make:link-client Billing` (class BillingClient)',
    );
  }
  return base;
}

export function linkClientTemplate(base: string, prefix: string): string {
  const className = `${base}Client`;
  return renderStub('link-client.ts', { base, prefix, className });
}

export async function makeLinkClientCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--path': { type: 'string', description: 'URL prefix, e.g. /billing (default /<name>)' },
    '--force': { type: 'boolean', description: 'overwrite an existing file' },
    '--dry-run': { type: 'boolean', description: 'print what would be written' },
  });
  const input = args.positionals[0];
  if (input === undefined || args.positionals.length > 2) {
    throw new UsageError('make:link-client needs a name', 'e.g. `tsir make:link-client Billing`');
  }

  const moduleInput = args.positionals[1];
  const raw = input.endsWith('Client') ? input.slice(0, -6) : input;
  const base = baseName(moduleInput === undefined ? input : scopedName(raw, 'client').pascal);
  const stem = moduleInput === undefined ? toKebab(base) : scopedName(raw, 'client').stem;
  const prefix = stringFlag(args, '--path') ?? `/${stem}`;
  if (!PREFIX.test(prefix)) {
    throw new UsageError(
      `"${prefix}" is not a usable path prefix`,
      'use a path that starts with a slash, e.g. `--path /billing/v2`',
    );
  }

  let moduleDir: string | undefined;
  if (moduleInput !== undefined) {
    const { app, module: moduleArg } = splitAppModule(moduleInput);
    if (app !== undefined) process.chdir(app);
    moduleDir = requireModule(moduleArg).dir;
  }
  const path = join(
    moduleDir === undefined ? join(process.cwd(), 'clients') : join(moduleDir, 'clients'),
    `${stem}.client.ts`,
  );
  const generated: GeneratedFile[] = [{ path, contents: linkClientTemplate(base, prefix) }];
  // CLI-015: every generated part ships with a test that is red until it is implemented.
  const primary = generated[0];
  if (primary !== undefined) generated.push(pendingTestFile(primary.path, `${base}Client`));
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
      `  ${style.dim('next:')} construct ${base}Client with { baseUrl, allowedHosts } in your module's providers`,
    );
  }
  return EXIT.ok;
}
