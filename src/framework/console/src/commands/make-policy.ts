/**
 * `tsir make:policy <Resource> <action> [--force] [--dry-run]` (CLI-014).
 *
 * The output is one rule function for the permission `resource.action`, and a `[ref, rule]` pair
 * that goes in the `policies` array of `createRegistry(...)`. The rule is what a service reaches
 * through `registry.require(...)`, so the same decision is made in a controller, a job and an RPC
 * handler. It is a plain function with no imports, so the console never depends on the policy
 * package. Its types are structural: they are checked where the pair is registered.
 *
 * The default answer is role-based, which is what the registry does for a permission with no
 * policy at all. Ownership (`data` against `principal.subject`) is left for the author to write,
 * and until it is written the rule never grants more than the role does.
 */

import { join } from 'node:path';

import { boolFlag, parseArgs } from '../args.ts';
import { commitWrites, displayPath, type GeneratedFile, type PlannedWrite } from '../generator.ts';
import { pendingTestFile } from './pending-test.ts';
import { renderStub } from '../stub.ts';
import { EXIT, info, ok, style, UsageError } from '../output.ts';
import { requireModule, splitAppModule, toKebab } from './naming.ts';

/** The same grammar as the policy package's permission pattern, restated because the console does not depend on it. */
const PART = /^[a-z][a-z0-9-]*$/;

/** `blog-post` + `update` → `blogPostUpdate`. */
function camel(resource: string, action: string): string {
  const cap = (part: string): string => part.charAt(0).toUpperCase() + part.slice(1);
  const head = resource
    .split('-')
    .map((part, index) => (index === 0 ? part : cap(part)))
    .join('');
  return `${head}${cap(action.split('-').map(cap).join(''))}`;
}

export function policyTemplate(resource: string, action: string): string {
  const permission = `${resource}.${action}`;
  const ref = `${resource}:${action}`;
  const name = camel(resource, action);
  const pascal = name.charAt(0).toUpperCase() + name.slice(1);
  return renderStub('policy.ts', { permission, ref, name, pascal, resource, action });
}

export async function makePolicyCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--force': { type: 'boolean', description: 'overwrite an existing file' },
    '--dry-run': { type: 'boolean', description: 'print what would be written' },
  });
  const [resourceInput, actionInput, moduleInput] = args.positionals;
  if (resourceInput === undefined || actionInput === undefined || args.positionals.length > 3) {
    throw new UsageError(
      'make:policy needs a resource and an action',
      'e.g. `tsir make:policy Post update` (permission post.update)',
    );
  }

  const resource = toKebab(resourceInput);
  const action = toKebab(actionInput);
  if (!PART.test(resource) || !PART.test(action)) {
    throw new UsageError(
      `"${resourceInput} ${actionInput}" does not make a permission`,
      'resource and action are lowercase words, e.g. `Post update` → post.update',
    );
  }

  let moduleDir: string | undefined;
  if (moduleInput !== undefined) {
    const { app, module: moduleArg } = splitAppModule(moduleInput);
    if (app !== undefined) process.chdir(app);
    moduleDir = requireModule(moduleArg).dir;
  }
  const path = join(
    moduleDir === undefined ? join(process.cwd(), 'policies') : join(moduleDir, 'policies'),
    `${resource}-${action}.policy.ts`,
  );
  const generated: GeneratedFile[] = [{ path, contents: policyTemplate(resource, action) }];
  // CLI-015: every generated part ships with a test that is red until it is implemented.
  const primary = generated[0];
  if (primary !== undefined)
    generated.push(pendingTestFile(primary.path, `${resource}.${action} policy`));
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
      `  ${style.dim('next:')} add ${camel(resource, action)}Policy to the \`policies\` array of \`createRegistry(...)\``,
    );
  }
  return EXIT.ok;
}
