/**
 * `tsir about` — what this installation is, and what it can do.
 *
 * A developer who has just installed the distribution has three legitimate questions: which version
 * is this, what can it do, and where do I read more. `--help` answers the second in command-list
 * form; this answers all three in the form someone reads once, at the start.
 *
 * Deliberately factual. Every line is checkable against the distribution it came from: a capability
 * list that overstates is worse than no list, because it costs a developer an afternoon before they
 * discover the command exits 3.
 */

import { frameworkVersion, Reporter } from '@tsir/tui';

import { EXIT, jsonDocument } from '../output.ts';
import { COMMANDS } from '../index.ts';

export interface AboutEnvironment {
  /** Where the running CLI came from, when the caller knows. */
  readonly distribution?: string;
  readonly bun?: string;
  readonly node?: string;
  readonly platform?: string;
}

function environment(): AboutEnvironment {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun;
  const process = (
    globalThis as {
      process?: { versions?: { node?: string }; platform?: string };
    }
  ).process;
  return {
    ...(bun?.version === undefined ? {} : { bun: bun.version }),
    ...(process?.versions?.node === undefined ? {} : { node: process.versions.node }),
    ...(process?.platform === undefined ? {} : { platform: process.platform }),
  };
}

export async function aboutCommand(argv: readonly string[]): Promise<number> {
  const json = argv.includes('--json');
  const env = environment();
  const available = COMMANDS.filter((command) => command.run !== undefined);
  const planned = COMMANDS.filter((command) => command.run === undefined);

  if (json) {
    // Every JSON document on stdout is versioned (CLI-002): a consumer that reads `schemaVersion`
    // can tell when the shape changed, which a bare object cannot express.
    process.stdout.write(
      `${jsonDocument({
        name: 'tsir',
        version: frameworkVersion(),
        description: 'Strictly typed backend framework for Bun, Node, Workers and Lambda.',
        runtime: { bun: env.bun, node: env.node, platform: env.platform },
        commands: { available: available.length, planned: planned.length },
      })}\n`,
    );
    return EXIT.ok;
  }

  const reporter = new Reporter();
  reporter.line('');
  reporter.line(`  \u001B[1m\u001B[36mTsir\u001B[0m ${frameworkVersion()}`);
  reporter.line(
    '  \u001B[2mStrictly typed backend framework for Bun, Node, Workers and Lambda.\u001B[0m',
  );
  reporter.blank();
  reporter.section('Runtime');
  reporter.field('bun', env.bun ?? 'not running on Bun');
  reporter.field('node', env.node ?? 'embedded (Node compatibility)');
  reporter.field('platform', env.platform ?? 'unknown');
  reporter.blank();
  reporter.section('This installation', {
    note: 'Packages resolve from the distribution that ships this executable.',
  });
  reporter.field(
    'commands',
    `${String(available.length)} available · ${String(planned.length)} planned`,
  );
  if (env.distribution !== undefined) reporter.field('distribution', env.distribution);
  reporter.blank();
  reporter.section('Start here');
  for (const step of [
    'tsir new <app-name>      create an application in apps/<app-name>/',
    'tsir help                every command, with what it does',
    'tsir doctor              check this project: runtime, config, manifest',
  ]) {
    reporter.line(`  ${step}`);
  }
  reporter.blank();
  reporter.line(
    '  \u001B[2mDocumentation ships with the distribution: dist/src/docs/index.html\u001B[0m',
  );
  reporter.line('');
  reporter.flush();
  return EXIT.ok;
}
