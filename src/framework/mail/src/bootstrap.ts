/**
 * One-call mail bootstrap for apps that use `@tsir/mail`.
 *
 * Replaces the hand-written mail service setup every app previously needed:
 * it builds the mailers registry from `config/mail.ts` and the app's email
 * templates, and exposes the DI token + value provider the rest of the app
 * wires into its modules.
 *
 * Templates are app-specific, so the app passes them in.
 */

import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { mailersFromConfig, type BuildMailersOptions } from './config.ts';
import type { Mailers } from './mailers.ts';

/** Options for `createMailBootstrap`. */
export interface MailBootstrapOptions {
  /** The app's mail configuration (the `mail` field of `BuildMailersOptions`). */
  readonly mail: BuildMailersOptions['mail'];
  /** The app's email templates, keyed by name. */
  readonly templates?: BuildMailersOptions['templates'];
  /** Where `{ fromEnv }` references are read from. */
  readonly env?: BuildMailersOptions['env'];
  /** Worker bindings, by name. */
  readonly bindings?: BuildMailersOptions['bindings'];
  readonly fetch?: BuildMailersOptions['fetch'];
  readonly smtpConnect?: BuildMailersOptions['smtpConnect'];
  readonly log?: BuildMailersOptions['log'];
  readonly now?: BuildMailersOptions['now'];
  /** Refuse a `log` transport in production. */
  readonly production?: boolean;
}

/** Everything an app needs to wire its mail layer. */
export interface MailBootstrap {
  /** The mailers registry. */
  readonly mailers: Mailers;
  /** DI token for `mailers`. */
  readonly mailersToken: Token<Mailers>;
  /** Value provider for `mailers`. */
  readonly mailersProvider: Provider<Mailers>;
}

/**
 * Build the mail layer from `config/mail.ts`.
 *
 * ```ts
 * import { createMailBootstrap } from '@tsir/mail';
 * import config from '../../config/mail.ts';
 * import { resetPasswordTemplate } from './templates/reset-password.ts';
 *
 * export const { mailers, mailersToken, mailersProvider } = createMailBootstrap({
 *   mail: config,
 *   templates: { 'reset-password': resetPasswordTemplate },
 *   env: Bun.env,
 * });
 * ```
 */
export function createMailBootstrap(options: MailBootstrapOptions): MailBootstrap {
  const mailers = mailersFromConfig({
    mail: options.mail,
    templates: options.templates,
    env: options.env,
    bindings: options.bindings,
    fetch: options.fetch,
    smtpConnect: options.smtpConnect,
    log: options.log,
    now: options.now,
    production: options.production,
  });

  const mailersToken = token<Mailers>('mailers');
  const mailersProvider = valueProvider(mailersToken, mailers);

  return { mailers, mailersToken, mailersProvider };
}
