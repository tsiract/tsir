/**
 * The version of the framework the running CLI belongs to.
 *
 * Read from `package.json` rather than hard-coded: the manifests are kept in lockstep by
 * `make version`, and a constant here would be one more place for a release to forget one.
 *
 * Two depths, because this same file is shipped in both layouts — the repository keeps the
 * entry at `src/framework/console/src/index.ts` (manifest one level up), and `make dist` emits
 * `framework/console/index.js` (manifest beside it). A path that only works in one of them makes
 * `tsir --version` answer "unknown" exactly where a developer first meets it.
 */
function frameworkVersion(): string {
  for (const relative of ['../package.json', './package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as {
        version?: unknown;
      };
      if (typeof pkg.version === 'string') return pkg.version;
    } catch {
      // Try the next layout.
    }
  }
  return 'unknown';
}

/**
 * @tsir/console — the CLI.
 *
 * Public surface: `runCli` (used by the bin and by tests) and `COMMANDS`.
 */

import { readFileSync } from 'node:fs';

import {
  buildCommand,
  cleanCommand,
  configDumpCommand,
  devCommand,
  startCommand,
} from './commands/lifecycle.ts';
import { bootstrapCommand } from './commands/bootstrap.ts';
import { cacheClearCommand, cacheProbeCommand, cacheTableCommand } from './commands/cache.ts';
import {
  queueFailedCommand,
  queueRetryCommand,
  queueTableCommand,
  queueWorkCommand,
} from './commands/queue.ts';
import { mailMailersCommand, mailPreviewCommand, mailTestCommand } from './commands/mail.ts';
import {
  notifyChannelsCommand,
  notifyPreviewCommand,
  notifyTestCommand,
} from './commands/notify.ts';
import { storageDisksCommand, storageProbeCommand, storageUrlCommand } from './commands/storage.ts';
import {
  scheduleListCommand,
  scheduleRunCommand,
  scheduleTableCommand,
  scheduleWorkCommand,
} from './commands/schedule.ts';
import { deployBuildCommand } from './commands/deploy-build.ts';
import { deployValidateCommand } from './commands/deploy-validate.ts';
import { deployDiffCommand, deployInvokeCommand, deployPlanCommand } from './commands/deploy.ts';
import { aboutCommand } from './commands/about.ts';
import { doctorCommand } from './commands/doctor.ts';
import { openapiGenerateCommand } from './commands/openapi.ts';
import { protoGenerateCommand } from './commands/proto.ts';
import { makeModuleCommand, newCommand } from './commands/generate.ts';
import { makeControllerCommand } from './commands/make-controller.ts';
import { makeModelCommand } from './commands/make-model.ts';
import { toolCommand } from './commands/tools.ts';
import { makePartCommand } from './commands/make-parts.ts';
import { makeCommandCommand } from './commands/make-command.ts';
import { makeConnectionCommand } from './commands/make-connection.ts';
import { makeSeederCommand } from './commands/make-seeder.ts';
import { makeAsyncCommand } from './commands/make-async.ts';
import { makeLinkClientCommand } from './commands/make-link-client.ts';
import { makePolicyCommand } from './commands/make-policy.ts';
import { routeCompileCommand } from './commands/compile.ts';
import { routeListCommand } from './commands/routes.ts';
import { soapGenCommand } from './commands/soap-gen.ts';
import {
  dbSeedCommand,
  makeMigrationCommand,
  migrateCommand,
  migrateRollbackCommand,
  migrateStatusCommand,
  migrateVerifyCommand,
} from './commands/db.ts';
import {
  vaultKeyActivateCommand,
  vaultKeyGenerateCommand,
  vaultKeyRetireCommand,
  vaultRotateCommand,
  vaultRotateStatusCommand,
} from './commands/vault.ts';
import { loadProjectCommands, notListedMessage } from './commands/project-command.ts';
import { registerCommands, type CommandSpec } from './define-command.ts';
import { CliError, EXIT, fail, info, style, UsageError } from './output.ts';
import { loadProject } from './project.ts';
import { assertRuntime } from './runtime.ts';

export { defineCommand, registerCommands } from './define-command.ts';
export type { CommandSpec } from './define-command.ts';

export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly phase: number;
  readonly run?: (argv: readonly string[]) => Promise<number>;
}

export const COMMANDS: readonly Command[] = [
  {
    name: 'test',
    summary: 'run the application tests',
    phase: 1,
    run: toolCommand('test'),
  },
  {
    name: 'lint',
    summary: 'run the application lint script',
    phase: 1,
    run: toolCommand('lint'),
  },
  {
    name: 'typecheck',
    summary: 'run the application typecheck script',
    phase: 1,
    run: toolCommand('typecheck'),
  },
  {
    name: 'dev',
    summary: 'boot the application and serve its exported HTTP handler',
    phase: 1,
    run: devCommand,
  },
  { name: 'build', summary: 'generate the application manifest', phase: 1, run: buildCommand },
  {
    name: 'clean',
    summary: 'remove the build output (.tsir/, compiled routes) and nothing else',
    phase: 1,
    run: cleanCommand,
  },
  {
    name: 'start',
    summary: 'boot the built artifact (run tsir build first)',
    phase: 1,
    run: startCommand,
  },
  {
    name: 'about',
    summary: 'what this installation is: version, runtime, commands',
    phase: 1,
    run: aboutCommand,
  },
  {
    name: 'doctor',
    summary: 'diagnose runtime, config, and manifest',
    phase: 1,
    run: (argv) =>
      doctorCommand(
        argv,
        // `help` is answered before dispatch, so it is not in COMMANDS but is a valid name.
        [...COMMANDS.map((command) => command.name), 'help'],
      ),
  },
  {
    name: 'config:dump',
    summary: 'print resolved configuration (redacted)',
    phase: 1,
    run: configDumpCommand,
  },
  { name: 'new', summary: 'scaffold an application', phase: 1, run: newCommand },
  { name: 'make:module', summary: 'generate a module file', phase: 1, run: makeModuleCommand },
  { name: 'route:list', summary: 'list compiled routes', phase: 2, run: routeListCommand },
  {
    name: 'route:compile',
    summary: 'compile routes into routes.gen.ts',
    phase: 2,
    run: routeCompileCommand,
  },
  {
    name: 'openapi:generate',
    summary: 'emit an OpenAPI 3.1 document',
    phase: 1,
    run: openapiGenerateCommand,
  },
  {
    name: 'proto:generate',
    summary: "compile this application's .proto contracts into typed TypeScript",
    phase: 1,
    run: protoGenerateCommand,
  },
  {
    name: 'make:controller',
    summary: 'generate a module-owned HTTP controller',
    phase: 1,
    run: makeControllerCommand,
  },
  {
    name: 'make:model',
    summary: 'generate a module-owned Drizzle schema',
    phase: 1,
    run: makeModelCommand,
  },
  {
    name: 'make:service',
    summary: 'generate a service',
    phase: 1,
    run: makePartCommand('service'),
  },
  {
    name: 'make:middleware',
    summary: 'generate an HTTP middleware factory',
    phase: 1,
    run: makePartCommand('middleware'),
  },
  {
    name: 'make:guard',
    summary: 'generate an HTTP guard factory',
    phase: 1,
    run: makePartCommand('guard'),
  },
  {
    name: 'make:migration',
    summary: 'generate a Drizzle migration',
    phase: 3,
    run: makeMigrationCommand,
  },
  {
    name: 'make:connection',
    summary: 'add one entry to a named registry (CLI-017)',
    phase: 1,
    run: makeConnectionCommand,
  },
  {
    name: 'make:command',
    summary: 'generate a project command for ract (CLI-019)',
    phase: 1,
    run: makeCommandCommand,
  },
  {
    name: 'make:seeder',
    summary: 'generate a seeder (defineSeeder file)',
    phase: 3,
    run: makeSeederCommand,
  },
  {
    name: 'make:job',
    summary: 'generate a queue job (defineJob file)',
    phase: 1,
    run: makeAsyncCommand('job'),
  },
  {
    name: 'make:event',
    summary: 'generate an event (defineEvent file)',
    phase: 1,
    run: makeAsyncCommand('event'),
  },
  {
    name: 'make:policy',
    summary: 'generate an authorization rule for resource.action',
    phase: 1,
    run: makePolicyCommand,
  },
  {
    name: 'make:link-client',
    summary: 'generate a typed REST client over @tsir/link',
    phase: 1,
    run: makeLinkClientCommand,
  },
  {
    name: 'make:listener',
    summary: 'generate a listener for an event (defineListener file)',
    phase: 1,
    run: makeAsyncCommand('listener'),
  },
  { name: 'migrate', summary: 'apply pending migrations', phase: 3, run: migrateCommand },
  {
    name: 'migrate:status',
    summary: 'show applied, pending and drifted migrations',
    phase: 3,
    run: migrateStatusCommand,
  },
  {
    name: 'migrate:rollback',
    summary: 'roll back to a named migration (guarded)',
    phase: 3,
    run: migrateRollbackCommand,
  },
  {
    name: 'migrate:verify',
    summary: 'apply the journal to an empty database',
    phase: 3,
    run: migrateVerifyCommand,
  },
  { name: 'db:seed', summary: 'run seeders for this environment', phase: 3, run: dbSeedCommand },
  {
    name: 'cache:table',
    summary: 'print the DDL the database cache driver expects',
    phase: 7,
    run: cacheTableCommand,
  },
  {
    name: 'cache:probe',
    summary: 'open every cache store and round-trip one key',
    phase: 7,
    run: cacheProbeCommand,
  },
  {
    name: 'cache:clear',
    summary: 'empty one named cache store',
    phase: 7,
    run: cacheClearCommand,
  },
  {
    name: 'queue:work',
    summary: 'run the jobs for one connection',
    phase: 7,
    run: queueWorkCommand,
  },
  {
    name: 'queue:failed',
    summary: 'list the dead-letter store for one connection',
    phase: 7,
    run: queueFailedCommand,
  },
  {
    name: 'queue:retry',
    summary: 'replay a dead letter, or --all of them',
    phase: 7,
    run: queueRetryCommand,
  },
  {
    name: 'queue:table',
    summary: 'print the DDL the database queue driver expects',
    phase: 7,
    run: queueTableCommand,
  },
  {
    name: 'schedule:list',
    summary: 'every declared task, its next run, and whether it is running now',
    phase: 7,
    run: scheduleListCommand,
  },
  {
    name: 'schedule:run',
    summary: 'run one task now (--force to ignore a held lock)',
    phase: 7,
    run: scheduleRunCommand,
  },
  {
    name: 'schedule:work',
    summary: 'be the clock: run what is due, on the minute, until stopped',
    phase: 7,
    run: scheduleWorkCommand,
  },
  {
    name: 'schedule:table',
    summary: 'print the DDL the database lock driver expects',
    phase: 7,
    run: scheduleTableCommand,
  },
  {
    name: 'mail:mailers',
    summary: 'every declared mailer, its driver and what it can carry',
    phase: 7,
    run: mailMailersCommand,
  },
  {
    name: 'mail:test',
    summary: 'send one test message through every mailer (or one with --mailer)',
    phase: 7,
    run: mailTestCommand,
  },
  {
    name: 'mail:preview',
    summary: 'render a template — its text, its HTML, or the whole MIME document',
    phase: 7,
    run: mailPreviewCommand,
  },
  {
    name: 'notify:channels',
    summary: 'every declared notification channel, what it can carry, and who uses it',
    phase: 7,
    run: notifyChannelsCommand,
  },
  {
    name: 'notify:preview',
    summary: "render every channel's payload for one notification, without sending",
    phase: 7,
    run: notifyPreviewCommand,
  },
  {
    name: 'notify:test',
    summary: 'deliver one notification through every channel (or one with --channel)',
    phase: 7,
    run: notifyTestCommand,
  },
  {
    name: 'storage:disks',
    summary: 'every declared storage disk, its driver and its capabilities',
    phase: 7,
    run: storageDisksCommand,
  },
  {
    name: 'storage:probe',
    summary: 'round-trip one key through every disk (or one with --disk)',
    phase: 7,
    run: storageProbeCommand,
  },
  {
    name: 'storage:url',
    summary: 'print a public or signed URL for one key',
    phase: 7,
    run: storageUrlCommand,
  },
  {
    name: 'vault:key:generate',
    summary: 'generate a key and print it once',
    phase: 4,
    run: vaultKeyGenerateCommand,
  },
  {
    name: 'vault:key:activate',
    summary: 'plan the promotion of the staged key',
    phase: 4,
    run: vaultKeyActivateCommand,
  },
  {
    name: 'vault:key:retire',
    summary: 'retire a key once no rows reference it',
    phase: 4,
    run: vaultKeyRetireCommand,
  },
  {
    name: 'vault:rotate',
    summary: 're-encrypt rows onto the active key',
    phase: 4,
    run: vaultRotateCommand,
  },
  {
    name: 'vault:rotate:status',
    summary: 'remaining rows, failures and ETA',
    phase: 4,
    run: vaultRotateStatusCommand,
  },
  {
    name: 'link:soap:gen',
    summary: 'compile a WSDL into typed SOAP operations',
    phase: 5,
    run: soapGenCommand,
  },
  {
    name: 'bootstrap',
    summary: 'plan and write the managed deploy block in tsir.js',
    phase: 6,
    run: bootstrapCommand,
  },
  {
    name: 'deploy:plan',
    summary: 'resolve and print the deploy unit graph',
    phase: 6,
    run: deployPlanCommand,
  },
  {
    name: 'deploy:diff',
    summary: 'compare the unit graph to the committed snapshot',
    phase: 6,
    run: deployDiffCommand,
  },
  {
    name: 'deploy:invoke',
    summary: 'call one unit locally through the entry handler',
    phase: 6,
    run: deployInvokeCommand,
  },
  {
    name: 'deploy:build',
    summary: 'emit Workers/Lambda artifacts',
    phase: 6,
    run: deployBuildCommand,
  },
  {
    name: 'deploy:validate',
    summary: 'gate a release: budgets, secret scan, capabilities',
    phase: 6,
    run: deployValidateCommand,
  },
];

function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const available = COMMANDS.filter((command) => command.run !== undefined);
  const planned = COMMANDS.filter((command) => command.run === undefined);

  const lines: string[] = [
    '',
    `  ${style.bold('tsir')} ${style.dim('— strictly typed backend framework')}`,
    '',
    `  ${style.dim('usage:')} tsir <command> [flags]`,
    '',
    `  ${style.dim('global:')} --app <path>   run a project-bound command from outside its directory (or -C <path>)`,
    `  ${style.dim('         --json')}        machine-readable output for commands that support it`,
    '',
    `  ${style.bold('available')}`,
    ...available.map(
      (command) => `    ${style.cyan(command.name.padEnd(width))}  ${command.summary}`,
    ),
    '',
    `  ${style.bold('planned')} ${style.dim('(listed so the surface is honest; they exit 3 until built)')}`,
    ...planned.map(
      (command) =>
        `    ${style.dim(command.name.padEnd(width))}  ${command.summary} ${style.dim(`· phase ${String(command.phase)}`)}`,
    ),
    '',
    `  ${style.dim('A command marked with a phase is planned, not implemented.')}`,
    '',
  ];
  return lines.join('\n');
}

/**
 * `ract` entry point (CLI-018, CLI-020). Loads the project, refuses a command that
 * `console.commands` does not list, and otherwise runs exactly what `tsir` would run.
 */
export async function runProjectCommand(
  argv: readonly string[],
  cwd: string = process.cwd(),
): Promise<number> {
  const json = argv.includes('--json');
  let listed: readonly string[] | undefined;
  let own: readonly CommandSpec[];
  try {
    const project = await loadProject(cwd);
    listed = project.config.console?.commands;
    own = await loadProjectCommands(project.entryPath);
  } catch (error: unknown) {
    return fail(error, json);
  }
  // CLI-019: a project command may not share a name with a framework command or another project command.
  try {
    registerCommands([...COMMANDS, ...own]);
  } catch (error: unknown) {
    return fail(error, json);
  }
  const index = argv.findIndex((arg) => arg !== '--json');
  const first = index === -1 ? undefined : argv[index];
  const META = ['help', '--help', '-h', '--version', 'about'];
  if (
    listed !== undefined &&
    first !== undefined &&
    !META.includes(first) &&
    !listed.includes(first)
  ) {
    const refusal = notListedMessage(first);
    return fail(new UsageError(refusal.message, refusal.hint), json);
  }
  const mine = own.find((command) => command.name === first);
  if (mine !== undefined && index !== -1) {
    const rest = [...argv.slice(0, index), ...argv.slice(index + 1)];
    try {
      return await mine.run(rest);
    } catch (error: unknown) {
      return fail(error, json);
    }
  }
  return runCli(argv);
}

/**
 * Extract the global `--app <path>` flag from argv.
 *
 * `--app` lets a project-bound command run from outside the application
 * directory: `tsir dev --app src/apps/frontpage` boots that app without
 * `cd`. It is implemented by `process.chdir` before dispatch so every
 * `loadProject(process.cwd())` call site picks up the right root.
 *
 * Returns the path (or undefined) and the argv with the flag removed.
 * Accepts `--app path`, `--app=path`, and `-C path` (C for "change directory",
 * matching `make -C` and `git -C`).
 */
function extractAppFlag(argv: readonly string[]): {
  app: string | undefined;
  argv: readonly string[];
} {
  const out: string[] = [];
  let app: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--app' || arg === '-C') {
      app = argv[i + 1];
      i++;
    } else if (arg !== undefined && arg.startsWith('--app=')) {
      app = arg.slice('--app='.length);
    } else if (arg !== undefined) {
      out.push(arg);
    }
  }
  return { app, argv: out };
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const { app, argv: cleaned } = extractAppFlag(argv);
  if (app !== undefined) {
    process.chdir(app);
  }
  const json = cleaned.includes('--json');
  // CLI-002: `--json` is a global flag, so it may come before the command name. The command is
  // the first argument that is not `--json`; any leading `--json` is passed on to the command.
  const commandIndex = cleaned.findIndex((arg) => arg !== '--json');
  const first = commandIndex === -1 ? undefined : cleaned[commandIndex];
  const rest =
    commandIndex === -1
      ? []
      : [...cleaned.slice(0, commandIndex), ...cleaned.slice(commandIndex + 1)];

  // FND-016: refuse to run on a runtime below the floor, before any command
  // touches the filesystem or imports the framework. `--version` is exempt so
  // the answer to "what am I running?" never depends on the runtime check.
  if (first !== '--version') {
    try {
      assertRuntime();
    } catch (error: unknown) {
      return fail(error, json);
    }
  }

  if (
    first === undefined ||
    first === 'help' ||
    first === '--help' ||
    first === '-h' ||
    first === '--version' ||
    first === 'about'
  ) {
    if (first === 'about') return await aboutCommand(argv);
    if (first === '--version') {
      // The framework's version, with the runtime beside it: a bug report needs both, and printing
      // only `Bun.version` answered "1.4.4" for a Tsir command — a number that says nothing about
      // which framework the developer is running.
      info(`${frameworkVersion()} (bun ${Bun.version})`);
      return EXIT.ok;
    }
    info(helpText());
    return EXIT.ok;
  }

  const command = COMMANDS.find((candidate) => candidate.name === first);

  if (command === undefined) {
    return fail(
      new UsageError(`unknown command "${first}"`, 'run `tsir help` to list commands'),
      json,
    );
  }

  if (command.run === undefined) {
    return fail(
      new CliError(
        `"${command.name}" is planned for phase ${String(command.phase)} and is not implemented yet`,
        EXIT.environment,
        'the command lands with the phase named beside it',
      ),
      json,
    );
  }

  try {
    return await command.run(rest);
  } catch (error: unknown) {
    return fail(error, json);
  }
}
