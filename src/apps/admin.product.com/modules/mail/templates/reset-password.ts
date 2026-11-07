/**
 * The reset-password email template.
 *
 * Uses `@tsir/mail`'s `defineTemplate`: a subject function, a text body, and an
 * HTML body. The sample is what `tsir mail:preview reset-password` renders, so
 * the template is testable without a database or a user.
 */
import { defineTemplate, html } from '@tsir/mail';

export const resetPasswordTemplate = defineTemplate<{
  name: string;
  resetUrl: string;
  expiresInMinutes: number;
}>({
  name: 'reset-password',
  subject: ({ expiresInMinutes }) => `Reset your password (expires in ${expiresInMinutes} minutes)`,
  text: ({ name, resetUrl, expiresInMinutes }) =>
    `Hi ${name},\n\n` +
    `A password reset was requested for your account. Use the link below to choose a new password:\n\n` +
    `${resetUrl}\n\n` +
    `This link expires in ${expiresInMinutes} minutes. If you did not request this, you can safely ignore this email.\n`,
  html: ({ name, resetUrl, expiresInMinutes }) => html`
    <p>Hi ${name},</p>
    <p>
      A password reset was requested for your account. Use the button below to choose a new
      password:
    </p>
    <p><a href="${resetUrl}" style="...">Reset password</a></p>
    <p>
      This link expires in ${expiresInMinutes} minutes. If you did not request this, you can safely
      ignore this email.
    </p>
  `,
  sample: {
    name: 'Admin',
    resetUrl: 'https://admin.product.com/reset-password?token=sample-token',
    expiresInMinutes: 60,
  },
});
