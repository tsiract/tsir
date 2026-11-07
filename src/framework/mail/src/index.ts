/**
 * @tsir/mail — compose and send mail over one transport port.
 *
 * ```ts
 * import { mailersFromConfig } from '@tsir/mail';
 *
 * const mailers = mailersFromConfig({ mail: config.mail, env: process.env, production });
 * await mailers.mailer().send({ to: 'ana@example.com', subject: 'Hi', text: 'Hi Ana' });
 * ```
 *
 * Two-step by design: a mailer composes and sends; it does not queue. Queuing is `@tsir/queue`'s
 * job, composed by the caller or by `@tsir/notify`, because a mail package that silently queues
 * creates an invisible dependency on a worker being alive.
 *
 * The barrel is free of `node:` imports: the one transport that needs a socket (`smtp`) loads its
 * adapter when a send happens, so a Worker bundle that sends mail through Resend never sees
 * `node:net`.
 */

/* ── the port ─────────────────────────────────────────────────────────────── */
export { envelopeOf, formatAddress, formatAddresses } from './port.ts';
export type {
  AddressInput,
  Attachment,
  DeliveryResult,
  Envelope,
  MailAddress,
  MailMessage,
  MailTransport,
  TransportCapabilities,
} from './port.ts';

/* ── composing ────────────────────────────────────────────────────────────── */
export { createMessage, recipientsOf, withSender, type MessageInput } from './message.ts';
export { parseAddress, parseAddresses, splitAddressList } from './address.ts';

/* ── templates and the escaping boundary ──────────────────────────────────── */
export { escapeHtml, html, isSafeHtml, raw, type SafeHtml } from './escape.ts';
export {
  createTemplates,
  defineTemplate,
  type MailTemplate,
  type RenderedTemplate,
  type Templates,
} from './template.ts';

/* ── the mailer and the registry ──────────────────────────────────────────── */
export {
  assertCarriable,
  createMailer,
  type CreateMailerOptions,
  type Mailer,
  type TemplateMessageInput,
} from './mailer.ts';
export {
  assertDelivers,
  createMailers,
  defineMailer,
  type CreateMailersOptions,
  type MailerDefinition,
  type Mailers,
} from './mailers.ts';

/* ── transports ───────────────────────────────────────────────────────────── */
export { formatLoggedMessage, logTransport, type LogTransportOptions } from './transports/log.ts';
export {
  memoryTransport,
  type MemoryTransport,
  type MemoryTransportOptions,
} from './transports/memory.ts';
export {
  cloudflareTransport,
  CLOUDFLARE_MAX_RECIPIENTS,
  type CloudflareEmailBinding,
  type CloudflareTransportOptions,
} from './transports/cloudflare.ts';
export { resendTransport, type ResendTransportOptions } from './transports/resend.ts';
export { postmarkTransport, type PostmarkTransportOptions } from './transports/postmark.ts';
export { sesTransport, type SesTransportOptions } from './transports/ses.ts';
export {
  dotStuff,
  parseCapabilities,
  smtpTransport,
  type SmtpTransportOptions,
} from './transports/smtp.ts';

/* ── configuration ────────────────────────────────────────────────────────── */
export {
  MAIL_DRIVERS,
  mailersFromConfig,
  transportFromConfig,
  type BuildMailersOptions,
  type ConfiguredMailer,
  type EnvRef,
  type MailDriverName,
} from './config.ts';

/* ── rendering, for the callers that need the bytes rather than a send ────── */
export { buildMime, type BuiltMime } from './mime.ts';

/* ── errors ───────────────────────────────────────────────────────────────── */
export type { MailErrorCode } from './errors.ts';

export { createMailBootstrap } from './bootstrap.ts';
export type { MailBootstrap, MailBootstrapOptions } from './bootstrap.ts';
