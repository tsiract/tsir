/**
 * `tsir mail:*` (`MAIL-10`).
 *
 * Three commands, each answering one question:
 *
 *   · `mail:mailers` — "what is configured, and what can it actually do?" The capability columns
 *     are the point: `delivers: false` on the default is a project whose password resets go to a
 *     terminal, and that is worth seeing in a table rather than in an incident.
 *   · `mail:test <to>` — "does mail work from here?" Sends one fixed message through every mailer
 *     (or one with `--mailer`), prints what the provider said, and exits non-zero if any failed.
 *     This is the check a deploy pipeline runs, and the one a person runs before blaming templates.
 *   · `mail:preview <template>` — "what will they see?" Renders a template's sample data, or data
 *     passed with `--data`, and prints the subject and both bodies, or the whole MIME document
 *     with `--mime` for the times a client renders something the terminal does not.
 *
 * Where the registry comes from: the app entry's `mailers` export when there is one (the same
 * contract as `disks`, `caches` and `queues`), otherwise `mail.mailers` in `tsir.js` built with the
 * templates the entry exports.
 */

import { pathToFileURL } from 'node:url';

import {
  buildMime,
  createMessage,
  mailersFromConfig,
  MAIL_DRIVERS,
  parseAddress,
  type BuildMailersOptions,
  type Mailer,
  type MailTemplate,
  type Mailers,
  type TransportCapabilities,
} from '@tsir/mail';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { EXIT, fail, info, ok, style, UsageError, warn, jsonDocument } from '../output.ts';
import { loadProject, type LoadedProject } from '../project.ts';

/** Duck-types the exported registry, so a wrong export is a message and not a crash. */
function isMailers(value: unknown): value is Mailers {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.mailer === 'function' &&
    typeof candidate.all === 'function' &&
    typeof candidate.default === 'string' &&
    Array.isArray(candidate.names)
  );
}

function templatesOf(project: LoadedProject): Readonly<Record<string, MailTemplate<never>>> {
  const exported = project.exports['templates'];
  if (typeof exported !== 'object' || exported === null || Array.isArray(exported)) return {};
  return exported as Readonly<Record<string, MailTemplate<never>>>;
}

/** The environment the config's `{ fromEnv }` references read — `process.env`, as a Worker does not. */
function environment(): Readonly<Record<string, string | undefined>> {
  return process.env;
}

interface Resolved {
  readonly mailers: Mailers;
  readonly source: string;
}

async function resolveMailers(project: LoadedProject): Promise<Resolved> {
  const module = (await import(pathToFileURL(project.entryPath).href)) as {
    readonly mailers?: unknown;
  };
  if (isMailers(module.mailers)) {
    return { mailers: module.mailers, source: `${project.entryPath} (mailers)` };
  }

  const options: BuildMailersOptions = {
    ...(project.config.mail === undefined ? {} : { mail: project.config.mail }),
    env: environment(),
    templates: templatesOf(project),
    // The `log` transport prints the message; the CLI prints its own answer on stdout. A message
    // block on stdout would break `--json`, and "the transport's chatter" is stderr's job anyway.
    log: { write: (text: string) => process.stderr.write(`${text}\n`) },
  };
  return {
    mailers: mailersFromConfig(options),
    source: `${project.configPath} (mail.mailers)`,
  };
}

function capabilityWords(capabilities: TransportCapabilities): string {
  const yes = (value: boolean): string => (value ? style.green('yes') : style.dim('no'));
  return [
    `delivers: ${yes(capabilities.delivers)}`,
    `html: ${yes(capabilities.html)}`,
    `attachments: ${yes(capabilities.attachments)}`,
    `tags: ${yes(capabilities.tags)}`,
  ].join('  ');
}

// ─── mail:mailers ───────────────────────────────────────────────────────────

export async function mailMailersCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--json': { type: 'boolean', description: 'one JSON document' },
  });
  const json = boolFlag(args, '--json');

  try {
    const project = await loadProject(process.cwd());
    const { mailers, source } = await resolveMailers(project);

    if (json) {
      process.stdout.write(
        `${jsonDocument({
          ok: true,
          default: mailers.default,
          source,
          mailers: mailers.all().map((mailer) => ({
            name: mailer.name,
            driver: mailer.transport.name,
            default: mailer.name === mailers.default,
            from: mailer.from.email,
            capabilities: mailer.transport.capabilities,
          })),
        })}\n`,
      );
      return EXIT.ok;
    }

    info(style.bold('mailers'));
    for (const mailer of mailers.all()) {
      const marker = mailer.name === mailers.default ? style.cyan(' (default)') : '';
      info(`  ${style.bold(mailer.name)}${marker}`);
      info(`    driver  ${mailer.transport.name}`);
      info(`    from    ${mailer.from.email}`);
      info(`    ${capabilityWords(mailer.transport.capabilities)}`);
      const templateCount = mailer.templates.names.length;
      if (templateCount > 0) info(`    templates ${String(templateCount)}`);
    }
    info(style.dim(`  registry: ${source}`));

    if (!mailers.mailer().capabilities.delivers) {
      warn(
        `the default mailer "${mailers.default}" does not deliver — fine in development, refused in production`,
      );
    }
    return EXIT.ok;
  } catch (error: unknown) {
    return fail(error, json);
  }
}

// ─── mail:test ──────────────────────────────────────────────────────────────

const PROBE_SUBJECT = 'Tsir mail test';
const PROBE_TEXT =
  'This message was sent by `tsir mail:test`. If you can read it, the mailer, the credentials and the sending domain all agree.';

export async function mailTestCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--mailer': { type: 'string', description: 'one named mailer (default: all of them)' },
    '--json': { type: 'boolean', description: 'one JSON document' },
  });
  const json = boolFlag(args, '--json');

  try {
    const to = args.positionals[0];
    if (to === undefined || to.trim() === '') {
      throw new UsageError(
        'mail:test needs an address to send to',
        'run `tsir mail:test you@example.com`, or `tsir mail:test you@example.com --mailer receipts`',
      );
    }

    // Parsed before any mailer is opened: a bad address is a typo in the command line, not three
    // separate mailer failures, and `MAIL_INVALID_ADDRESS` should be reported once, with its code.
    const recipient = parseAddress(to);

    const project = await loadProject(process.cwd());
    const { mailers, source } = await resolveMailers(project);

    const requested = stringFlag(args, '--mailer');
    // `--mailer` names one; without it every mailer is tried, because "the default works" is not
    // the same claim as "the receipts mailer works".
    const targets: readonly Mailer[] =
      requested === undefined ? mailers.all() : [mailers.mailer(requested)];

    const results: {
      mailer: string;
      driver: string;
      ok: boolean;
      id?: string;
      accepted?: readonly string[];
      detail?: string;
    }[] = [];

    for (const mailer of targets) {
      try {
        const message = createMessage({
          from: mailer.from,
          to: [recipient],
          subject: PROBE_SUBJECT,
          text: PROBE_TEXT,
          ...(mailer.capabilities.html ? { html: `<p>${PROBE_TEXT}</p>` } : {}),
        });
        const result = await mailer.transport.send(message);
        results.push({
          mailer: mailer.name,
          driver: mailer.transport.name,
          ok: true,
          id: result.id,
          accepted: result.accepted,
        });
      } catch (error: unknown) {
        results.push({
          mailer: mailer.name,
          driver: mailer.transport.name,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const failed = results.filter((result) => !result.ok);
    if (json) {
      process.stdout.write(`${jsonDocument({ ok: failed.length === 0, source, results })}\n`);
      return failed.length === 0 ? EXIT.ok : EXIT.failure;
    }

    for (const result of results) {
      if (result.ok) {
        ok(`${result.mailer} (${result.driver}) accepted it — id ${result.id ?? 'unknown'}`);
      } else {
        warn(`${result.mailer} (${result.driver}) failed: ${result.detail ?? 'unknown error'}`);
      }
    }
    if (failed.length > 0) {
      return fail(new Error(`${String(failed.length)} mailer(s) could not send`), false);
    }
    info(style.dim(`  registry: ${source}`));
    return EXIT.ok;
  } catch (error: unknown) {
    return fail(error, json);
  }
}

// ─── mail:preview ───────────────────────────────────────────────────────────

export async function mailPreviewCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--mailer': { type: 'string', description: "which mailer's templates to render" },
    '--data': { type: 'string', description: 'JSON for the template, instead of its sample' },
    '--mime': { type: 'boolean', description: 'print the whole MIME document' },
    '--json': { type: 'boolean', description: 'one JSON document' },
  });
  const json = boolFlag(args, '--json');

  try {
    const name = args.positionals[0];
    if (name === undefined) {
      throw new UsageError(
        'mail:preview needs a template name',
        'run `tsir mail:preview welcome` — `tsir mail:mailers` lists the mailers, and each one knows its templates',
      );
    }

    const project = await loadProject(process.cwd());
    const { mailers } = await resolveMailers(project);
    const mailer = mailers.mailer(stringFlag(args, '--mailer'));

    if (!mailer.templates.has(name)) {
      throw new UsageError(
        `no template "${name}"`,
        mailer.templates.names.length === 0
          ? 'export `templates` from the app entry — a template is code, and `tsir.js` cannot describe one'
          : `registered: ${mailer.templates.names.join(', ')}`,
      );
    }

    const raw = stringFlag(args, '--data');
    let data: unknown;
    if (raw !== undefined) {
      try {
        data = JSON.parse(raw);
      } catch {
        throw new UsageError('--data must be JSON', `got: ${raw}`);
      }
    }

    const rendered = data === undefined ? mailer.render(name) : mailer.render(name, data);
    const message = createMessage({
      from: mailer.from,
      to: ['preview@tsir.local'],
      subject: rendered.subject,
      text: rendered.text,
      ...(rendered.html === undefined ? {} : { html: rendered.html }),
    });

    if (json) {
      process.stdout.write(
        `${jsonDocument({
          ok: true,
          template: name,
          subject: message.subject,
          text: message.text ?? '',
          ...(message.html === undefined ? {} : { html: message.html }),
        })}\n`,
      );
      return EXIT.ok;
    }

    if (boolFlag(args, '--mime')) {
      // The bytes a client will parse — the only view that shows whether the boundaries, the
      // encodings and the headers are right.
      process.stdout.write(
        new TextDecoder().decode(buildMime(message, { now: Date.now() }).message),
      );
      return EXIT.ok;
    }

    info(style.bold(`subject: ${message.subject}`));
    info('');
    info(style.dim('── text ──────────────────────────────────────'));
    info(message.text ?? style.dim('(none)'));
    if (message.html !== undefined) {
      info('');
      info(style.dim('── html ──────────────────────────────────────'));
      info(message.html);
    }
    info('');
    info(style.dim(`  ${MAIL_DRIVERS.length} drivers ship: ${MAIL_DRIVERS.join(', ')}`));
    return EXIT.ok;
  } catch (error: unknown) {
    return fail(error, json);
  }
}
