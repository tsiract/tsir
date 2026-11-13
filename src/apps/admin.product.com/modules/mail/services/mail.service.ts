/**
 * The mail service: builds the mailer registry from config and exposes
 * `sendTemplate`, the reusable function any app can call to send a templated
 * email.
 *
 * Templates are registered here; new ones are added to the `templates` object
 * and become available through `sendTemplate(name, data, { to })`.
 *
 * No `process.env` here — `APP_URL` is injected from the loaded config.
 */
import { createMailBootstrap, type MailTemplate, type RenderedTemplate } from '@tsir/mail';
import { token } from '@tsir/container';
import { isProduction } from '@tsir/core';

import { readConfig } from '../../../database.ts';
import { resetPasswordTemplate } from '../templates/reset-password.ts';

export const { mailers, mailersToken, mailersProvider } = createMailBootstrap({
  mail: (await import('../../../config/mail.ts')).default,
  templates: {
    'reset-password': resetPasswordTemplate as unknown as MailTemplate<never>,
  },
  env: {},
  // `CAP-007`: a `log` transport in production is an email that was written to a file nobody reads.
  production: isProduction(),
});

export type Mailers = typeof mailers;

export const mailServiceToken = token<MailService>('MailService');

export class MailService {
  private readonly defaultMailer: ReturnType<Mailers['mailer']>;

  constructor(
    private readonly mailers: Mailers,
    private readonly appUrl: string,
  ) {
    this.defaultMailer = this.mailers.mailer();
  }

  /** Send a templated email. */
  async sendTemplate(
    name: string,
    data: unknown,
    input: { to: readonly string[]; cc?: readonly string[]; replyTo?: readonly string[] },
  ): Promise<void> {
    await this.defaultMailer.sendTemplate(name, data, input);
  }

  /** Send a password-reset email with a one-time link. */
  async sendResetPasswordEmail(to: string, token: string): Promise<void> {
    const config = readConfig() as { supportEmail?: string };
    const resetUrl = `${this.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
    const replyTo = config.supportEmail ? [config.supportEmail] : undefined;
    await this.sendTemplate(
      'reset-password',
      { name: to, resetUrl, expiresInMinutes: 60 },
      replyTo ? { to: [to], replyTo } : { to: [to] },
    );
  }

  /** Render a template without sending — for `tsir mail:preview`. */
  renderTemplate(name: string, data?: unknown): RenderedTemplate {
    return this.defaultMailer.render(name, data);
  }
}
