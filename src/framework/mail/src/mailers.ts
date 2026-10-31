/**
 * The registry (`CAP-001` for `mail.mailers`, `MAIL-9`).
 *
 * Same shape as `cache.stores`, `queue.connections` and `storage.disks`: a `default`, named
 * entries, and a name that was never declared is `MAIL_UNKNOWN_MAILER` rather than a fallback.
 *
 * The rule that is specific to mail is **`assertDelivers`**: a transport whose `capabilities.delivers`
 * is false has nowhere to send anything, so `production: true` refuses it as the default or as a
 * `required` mailer. That is the same argument `@tsir/storage` makes about a memory disk, and it is
 * stronger here: a password-reset link written to a log file is not a late notification, it is a
 * user who cannot get in.
 */

import { assertCarriable, createMailer } from './mailer.ts';
import { forbiddenInProduction, noMailers, unknownDefault, unknownMailer } from './errors.ts';
import type { Mailer } from './mailer.ts';

export interface MailerDefinition {
  readonly mailer: Mailer;
  /**
   * Boot-validated, and refused in production if the transport cannot deliver. Set it on the
   * mailer a `requires` block names — a receipt that must arrive cannot come from `log`.
   */
  readonly required?: boolean | undefined;
}

export function defineMailer(definition: MailerDefinition): MailerDefinition {
  return definition;
}

export interface CreateMailersOptions {
  readonly mailers: Readonly<Record<string, MailerDefinition>>;
  /** Defaults to `default`, which is what `tsir.js` writes. */
  readonly default?: string | undefined;
  /** Refuse a non-delivering default, and every `required` mailer that cannot deliver. */
  readonly production?: boolean | undefined;
}

export interface Mailers {
  readonly names: readonly string[];
  readonly default: string;
  /** A mailer by name, or the default. An undeclared name is `MAIL_UNKNOWN_MAILER`. */
  mailer(name?: string): Mailer;
  all(): readonly Mailer[];
}

/**
 * A transport that cannot deliver, refused where it would be relied on.
 *
 * Exported because it is also what a `requires` block at boot calls: the capability is a static
 * fact about the transport, so this needs no network.
 */
export function assertDelivers(mailer: Mailer): void {
  if (!mailer.capabilities.delivers)
    throw forbiddenInProduction(mailer.name, mailer.transport.name);
}

export function createMailers(options: CreateMailersOptions): Mailers {
  const entries = Object.entries(options.mailers);
  if (entries.length === 0) throw noMailers();

  const names = entries.map(([name]) => name);
  const defaultName = options.default ?? 'default';
  if (!names.includes(defaultName)) throw unknownDefault(defaultName, names);

  const mailers = new Map<string, Mailer>();
  for (const [name, definition] of entries) {
    // The key is the name the project uses, so it is the name every error should print: a mailer
    // declared as `receipts` that reported itself as "resend" would send someone to the wrong file.
    const mailer =
      definition.mailer.name === name
        ? definition.mailer
        : createMailer({
            name,
            transport: definition.mailer.transport,
            from: definition.mailer.from,
            replyTo: definition.mailer.replyTo,
            templates: definition.mailer.templates,
          });
    if (options.production === true && (name === defaultName || definition.required === true)) {
      assertDelivers(mailer);
    }
    mailers.set(name, mailer);
  }

  const resolve = (name?: string): Mailer => {
    const wanted = name ?? defaultName;
    const mailer = mailers.get(wanted);
    if (mailer === undefined) throw unknownMailer(wanted, names);
    return mailer;
  };

  return {
    names,
    default: defaultName,
    mailer: resolve,
    all: () => entries.map(([name]) => resolve(name)),
  };
}

export { assertCarriable };
