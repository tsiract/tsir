/**
 * `make dist` — the distribution engineering entry point.
 *
 * Three modes, one behaviour: the distribution that is built always comes from
 * `tsir.dist.config.json`, never from answers that existed only in a terminal.
 *
 * ```text
 *   make dist                     wizard when attached to a terminal, then build
 *   make dist DIST_YES=1          build with the committed config, never prompt
 *   make dist FRONTEND=none …      build with one answer overridden, never prompt
 *   make dist DIST_CONFIG_ONLY=1   write the configuration and stop
 * ```
 *
 * The last one exists because configuring a distribution and building it are different acts: a
 * reviewer should be able to produce the file, read it, and commit it before anything is emitted.
 */

import { resolve } from 'node:path';

import { runDistWizard } from './dist-wizard.ts';
import {
  applyOverrides,
  describeDistConfig,
  DIST_CONFIG_FILE,
  loadDistConfig,
  writeDistConfig,
  type DistConfig,
} from './dist-config.ts';
import { Reporter } from '../framework/tui/src/index.ts';
import {
  canPrompt,
  NotInteractiveError,
  openSession,
  PromptCancelled,
} from '../framework/tui/src/ui.ts';

const ROOT = resolve(import.meta.dir, '..', '..');

interface Args {
  readonly interactive: boolean;
  readonly configOnly: boolean;
  readonly frontend?: string;
  readonly packageManager?: string;
  readonly styling?: string;
  readonly out?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const flag = (name: string): boolean => argv.includes(name);
  // `DIST_YES` and `--no-interactive` both mean "do not ask", and so does having an override: a
  // build that was given an answer has nothing to ask about.
  const noInteractive =
    flag('--no-interactive') || process.env['DIST_YES'] === '1' || process.env['TSIR_NO_INTERACTIVE'] === '1';
  return {
    interactive: !noInteractive,
    configOnly: flag('--config-only') || process.env['DIST_CONFIG_ONLY'] === '1',
    ...(value('--frontend') === undefined ? {} : { frontend: value('--frontend') }),
    ...(value('--package-manager') === undefined ? {} : { 'packageManager': value('--package-manager') }),
    ...(value('--styling') === undefined ? {} : { styling: value('--styling') }),
    ...(value('--out') === undefined ? {} : { out: value('--out') }),
  } as Args;
}

function reportConfig(
  reporter: Reporter,
  config: DistConfig,
  source: 'file' | 'defaults' | 'wizard',
): void {
  reporter.section('Distribution configuration', {
    note:
      source === 'wizard'
        ? 'written from the wizard'
        : source === 'file'
          ? `read from ${DIST_CONFIG_FILE}`
          : `no ${DIST_CONFIG_FILE} — building the documented defaults`,
  });
  for (const [label, value] of describeDistConfig(config)) reporter.field(label, value);
  reporter.blank();
}

type Resolution =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'resolved'; readonly config: DistConfig; readonly source: 'file' | 'defaults' | 'wizard' };

async function configure(args: Args): Promise<Resolution | undefined> {
  const loaded = loadDistConfig(ROOT);
  if (loaded.problems.length > 0) {
    const reporter = new Reporter();
    reporter.section('Distribution configuration is invalid');
    for (const problem of loaded.problems) {
      reporter.check({ status: 'fail', label: problem.field || 'file', detail: problem.message });
    }
    reporter.flush();
    return undefined;
  }

  // Overrides are applied to whatever is on disk, which makes `make dist FRONTEND=react` mean
  // "the rest as committed, with this one answer changed".
  if (args.frontend !== undefined || args.packageManager !== undefined) {
    const applied = applyOverrides(loaded.value!.config, {
      ...(args.frontend === undefined ? {} : { frontend: args.frontend }),
      ...(args.packageManager === undefined ? {} : { packageManager: args.packageManager }),
      ...(args.styling === undefined ? {} : { styling: args.styling }),
    });
    if (applied.config === undefined) {
      const reporter = new Reporter();
      reporter.section('Command-line overrides are not valid');
      for (const problem of applied.problems) {
        reporter.check({ status: 'fail', label: problem.field, detail: problem.message });
      }
      reporter.flush();
      return undefined;
    }
    writeDistConfig(ROOT, applied.config);
    return { kind: 'resolved', config: applied.config, source: 'wizard' };
  }

  if (!args.interactive || !canPrompt()) {
    // No terminal, and nothing to ask: build what is committed.
    return {
      kind: 'resolved',
      config: loaded.value!.config,
      source: loaded.value!.fromFile ? 'file' : 'defaults',
    };
  }

  const session = await openSession({ preserveOutput: true });
  try {
    const outcome = await runDistWizard({
      renderer: session.renderer,
      existing: loaded.value === undefined ? undefined : loaded.value,
    });
    session.close();
    if (outcome.kind === 'cancelled') return { kind: 'cancelled' };
    if (outcome.kind === 'configured') {
      writeDistConfig(ROOT, outcome.config);
      return { kind: 'resolved', config: outcome.config, source: 'wizard' };
    }
    return { kind: 'resolved', config: outcome.config, source: 'file' };
  } catch (error: unknown) {
    session.close();
    if (error instanceof PromptCancelled) return { kind: 'cancelled' };
    if (error instanceof NotInteractiveError) {
      process.stderr.write(`\n  ${error.message}\n  ↳ ${error.hint}\n\n`);
      return undefined;
    }
    throw error;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(Bun.argv.slice(2));
  const configured = await configure(args);
  if (configured === undefined) return 1;

  const reporter = new Reporter();
  if (configured.kind === 'cancelled') {
    reporter.line('\n  Cancelled — nothing was written and nothing was built.\n');
    reporter.flush();
    return 0;
  }
  reportConfig(reporter, configured.config, configured.source);
  reporter.flush();

  if (args.configOnly) {
    process.stdout.write(`  → configuration written; nothing built\n\n`);
    return 0;
  }

  // Hand the build to the existing assembler, in a child process so this file stays about
  // configuration. Args are passed through so `make dist --out /tmp/x` keeps working.
  const dist = Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, 'dist.ts'),
      ...(args.out === undefined ? [] : ['--out', args.out]),
    ],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
  );
  return dist.exitCode ?? 1;
}

if (import.meta.main) {
  process.exit(await main());
}
