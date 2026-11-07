/**
 * `tsir make:service`, `make:middleware`, `make:guard` (CLI-011).
 *
 * Every template takes its dependencies through the constructor (a class) or through a factory
 * argument (a function). Nothing in the output looks a dependency up from a container, so the
 * generated code is testable with plain objects and the dependency graph stays visible in the
 * type of each dependency bag.
 */

import { join } from 'node:path';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { commitWrites, displayPath, type GeneratedFile, type PlannedWrite } from '../generator.ts';
import { pendingTestFile } from './pending-test.ts';
import { renderStub } from '../stub.ts';
import { requireModule, scopedName, splitAppModule } from './naming.ts';
import { EXIT, info, ok, style, UsageError } from '../output.ts';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/;

function toKebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

/** `Audit`, `AuditService` and `AuditMiddleware` all give the base `Audit`. */
export function baseName(input: string, suffix: string): string {
  const base = input.endsWith(suffix) ? input.slice(0, -suffix.length) : input;
  if (!IDENTIFIER.test(base)) {
    throw new UsageError(
      `"${input}" is not a valid name`,
      `use PascalCase, e.g. Audit or Audit${suffix}`,
    );
  }
  return base;
}

export function serviceTemplate(base: string): string {
  const stem = toKebab(base);
  return renderStub('service.ts', { base, stem });
}

export function middlewareTemplate(base: string): string {
  return renderStub('middleware.ts', { base });
}

export function guardTemplate(base: string): string {
  return renderStub('guard.ts', { base });
}

interface PartSpec {
  readonly usage: string;
  readonly suffix: string;
  readonly dir: string;
  readonly ext: string;
  readonly render: (base: string) => string;
  readonly next: (base: string, stem: string) => string;
}

const SPECS: Record<'service' | 'middleware' | 'guard', PartSpec> = {
  service: {
    usage: 'tsir make:service <name> [module]',
    suffix: 'Service',
    dir: 'services',
    ext: 'service',
    render: serviceTemplate,
    next: (base) =>
      `register it: classProvider(${base}Token, ${base}Service, [clockToken]) in your module's providers`,
  },
  middleware: {
    usage: 'tsir make:middleware <name> [module]',
    suffix: 'Middleware',
    dir: 'middleware',
    ext: 'middleware',
    render: middlewareTemplate,
    next: (base) =>
      `call create${base}Middleware({ log }) and pass the result to the app's middleware list`,
  },
  guard: {
    usage: 'tsir make:guard <name> [module]',
    suffix: 'Guard',
    dir: 'guards',
    ext: 'guard',
    render: guardTemplate,
    next: (base) => `call create${base}Guard({ verify }) and attach it to the routes that need it`,
  },
};

export function makePartCommand(kind: keyof typeof SPECS) {
  const spec = SPECS[kind];
  return async (argv: readonly string[]): Promise<number> => {
    const args = parseArgs(argv, {
      '--force': { type: 'boolean', description: 'overwrite an existing file' },
      '--dry-run': { type: 'boolean', description: 'print the file that would be written' },
      '--dir': {
        type: 'string',
        description: `directory under the app root (default ${spec.dir})`,
      },
    });
    const input = args.positionals[0];
    if (input === undefined || args.positionals.length > 2)
      throw new UsageError(
        spec.usage,
        `e.g. ${spec.usage.replace('<name> [module]', 'audit shop')}`,
      );

    const raw = input.endsWith(spec.suffix) ? input.slice(0, -spec.suffix.length) : input;
    const { pascal: base, stem } = scopedName(raw, kind);
    const dir = stringFlag(args, '--dir') ?? spec.dir;
    if (!/^[a-z][a-z0-9/-]*$/.test(dir) || dir.includes('..')) {
      throw new UsageError(
        `"${dir}" is not a valid directory`,
        'use a relative path under the app root',
      );
    }
    const moduleInput = args.positionals[1];
    if (moduleInput !== undefined && stringFlag(args, '--dir') !== undefined)
      throw new UsageError('cannot combine a module with --dir');
    let moduleDir: string | undefined;
    if (moduleInput !== undefined) {
      const { app, module: moduleArg } = splitAppModule(moduleInput);
      if (app !== undefined) process.chdir(app);
      moduleDir = requireModule(moduleArg).dir;
    }
    const target = moduleDir === undefined ? join(process.cwd(), dir) : join(moduleDir, dir);
    const path = join(target, `${stem}.${spec.ext}.ts`);
    const generated: GeneratedFile[] = [{ path, contents: spec.render(base) }];
    // CLI-015: every generated part ships with a test that is red until it is implemented.
    const primary = generated[0];
    if (primary !== undefined)
      generated.push(pendingTestFile(primary.path, `${base}${spec.suffix}`));
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
    if (!dryRun) info(`  ${style.dim('next:')} ${spec.next(base, stem)}`);
    return EXIT.ok;
  };
}
