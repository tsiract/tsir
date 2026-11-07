/**
 * `tsir make:job`, `make:event`, `make:listener` (CLI-013).
 *
 * Each command writes one file that exports a definition built by the framework's own factory
 * (`defineJob`, `defineEvent`, `defineListener`). The payload type is declared once, on the event
 * or the job, and everything downstream infers from it, so a listener's `payload` is typed by the
 * event it answers. Registration is an export: a job goes in the entry's `jobs` array, and a
 * listener goes in the `listeners` array of the `createEvents(...)` the entry exports. The
 * commands print that step, because the entry is the user's file and is not edited for them.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { commitWrites, displayPath, type GeneratedFile, type PlannedWrite } from '../generator.ts';
import { pendingTestFile } from './pending-test.ts';
import { renderStub } from '../stub.ts';
import { CliError, EXIT, info, ok, style, UsageError } from '../output.ts';
import { isIdentifier, toKebab, scopedName, requireModule, splitAppModule } from './naming.ts';

const EVENT_NAME = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/;

/** `SendReceipt` and `SendReceiptJob` both give the base `SendReceipt`. */
function baseName(input: string, suffix: string): string {
  const base = input.endsWith(suffix) ? input.slice(0, -suffix.length) : input;
  if (!isIdentifier(base)) {
    throw new UsageError(
      `"${input}" is not a valid name`,
      `use PascalCase, e.g. SendReceipt (or SendReceipt${suffix})`,
    );
  }
  return base;
}

export function jobTemplate(base: string, stem = toKebab(base)): string {
  return renderStub('job.ts', { base, stem });
}

export function eventTemplate(base: string, eventName: string): string {
  return renderStub('event.ts', { base, eventName });
}

export function listenerTemplate(
  base: string,
  stem: string,
  eventBase: string,
  eventStem = toKebab(eventBase),
): string {
  return renderStub('listener.ts', { base, stem, eventBase, eventStem });
}

type Kind = 'job' | 'event' | 'listener';

const KINDS: Record<Kind, { usage: string; suffix: string; dir: string; ext: string }> = {
  job: { usage: 'tsir make:job <name> [module]', suffix: 'Job', dir: 'jobs', ext: 'job' },
  event: {
    usage: 'tsir make:event <name> [module] [--name order.placed]',
    suffix: 'Event',
    dir: 'events',
    ext: 'event',
  },
  listener: {
    usage: 'tsir make:listener <name> [module] --event <event>',
    suffix: 'Listener',
    dir: 'listeners',
    ext: 'listener',
  },
};

export function makeAsyncCommand(kind: Kind) {
  const spec = KINDS[kind];
  return async (argv: readonly string[]): Promise<number> => {
    const args = parseArgs(argv, {
      '--event': { type: 'string', description: 'listener: the event class it answers' },
      '--name': { type: 'string', description: 'event: the dotted name (default from the class)' },
      '--force': { type: 'boolean', description: 'overwrite an existing file' },
      '--dry-run': { type: 'boolean', description: 'print what would be written' },
    });
    const input = args.positionals[0];
    if (input === undefined || args.positionals.length > 2) {
      throw new UsageError(
        `${spec.usage.split(' ')[1] ?? 'make'} needs a name`,
        `e.g. ${spec.usage}`,
      );
    }

    const moduleInput = args.positionals[1];
    const raw = input.endsWith(spec.suffix) ? input.slice(0, -spec.suffix.length) : input;
    const base =
      moduleInput === undefined ? baseName(input, spec.suffix) : scopedName(raw, kind).pascal;
    const stem = moduleInput === undefined ? toKebab(base) : scopedName(raw, kind).stem;
    const root = process.cwd();
    let moduleDir: string | undefined;
    if (moduleInput !== undefined) {
      const { app, module: moduleArg } = splitAppModule(moduleInput);
      if (app !== undefined) process.chdir(app);
      moduleDir = requireModule(moduleArg).dir;
    }
    const generated: GeneratedFile[] = [];

    if (kind === 'job') {
      generated.push({
        path: join(moduleDir ?? root, 'queues', `${stem}.job.ts`),
        contents: jobTemplate(base, stem),
      });
    } else if (kind === 'event') {
      const eventName = stringFlag(args, '--name') ?? stem.replace(/-/g, '.');
      if (!EVENT_NAME.test(eventName)) {
        throw new UsageError(
          `"${eventName}" is not a dotted lowercase event name`,
          'use e.g. `--name order.placed`: the name is what brokers and outbox rows carry',
        );
      }
      generated.push({
        path: join(moduleDir ?? root, 'events', `${stem}.event.ts`),
        contents: eventTemplate(base, eventName),
      });
    } else {
      const eventInput = stringFlag(args, '--event');
      if (eventInput === undefined) {
        throw new UsageError(
          'make:listener needs --event <EventName>',
          'e.g. `tsir make:listener SendReceipt --event OrderPlaced`',
        );
      }
      const eventRaw = eventInput.endsWith('Event') ? eventInput.slice(0, -5) : eventInput;
      const eventBase =
        moduleDir === undefined
          ? baseName(eventInput, 'Event')
          : scopedName(eventRaw, 'event').pascal;
      const eventStem =
        moduleDir === undefined ? toKebab(eventBase) : scopedName(eventRaw, 'event').stem;
      const eventFile = join(moduleDir ?? root, 'events', `${eventStem}.event.ts`);
      if (!existsSync(eventFile)) {
        throw new CliError(
          `event ${eventBase}Event is not defined: ${displayPath(eventFile)} does not exist`,
          EXIT.failure,
          `run \`tsir make:event ${eventInput}${moduleInput === undefined ? '' : ` ${moduleInput}`}\` first, then generate the listener`,
        );
      }
      generated.push({
        path: join(moduleDir ?? root, 'listeners', `${stem}.listener.ts`),
        contents: listenerTemplate(base, stem, eventBase, eventStem),
      });
    }

    // CLI-015: every generated part ships with a test that is red until it is implemented.
    const primary = generated[0];
    if (primary !== undefined && kind !== 'event')
      generated.push(
        pendingTestFile(primary.path, kind === 'job' ? `${base}Job` : `${base}Listener`),
      );
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
    if (!dryRun) info(`  ${style.dim('next:')} ${registrationHint(kind, base, stem)}`);
    return EXIT.ok;
  };
}

function registrationHint(kind: Kind, base: string, stem: string): string {
  if (kind === 'job') {
    return `add ${base}Job to the \`jobs\` array exported by your entry (job name: ${stem})`;
  }
  if (kind === 'event') {
    return `add the event's listeners to \`createEvents({ listeners: [...] })\` in your entry`;
  }
  return `add ${base}Listener to the \`listeners\` array of \`createEvents(...)\` in your entry`;
}
