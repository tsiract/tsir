/**
 * The mailer (`MAIL-5`, `MAIL-8`).
 *
 * A mailer is a transport plus the four decisions a project makes once: the sender, the reply-to,
 * the templates, and the clock. `send` is the only method that reaches the network, and it does
 * three things in a fixed order — **compose**, **check the transport can carry it**, **send** —
 * because the middle step is the one that is easy to skip and expensive to skip:
 *
 * ```ts
 * await mailer.send({ to, subject: 'Hi', html: '<b>hi</b>' });
 * // MAIL_UNSUPPORTED_OPERATION: transport "log" cannot carry html: …
 * ```
 *
 * Refusing before the request means a caller cannot believe a message was delivered when the
 * provider quietly dropped the attachment, and it means the failure arrives in a test rather than
 * in a customer's inbox.
 */

import { parseAddress, parseAddresses } from './address.ts';
import { unsupportedOperation } from './errors.ts';
import { createMessage, withSender, type MessageInput } from './message.ts';
import type {
  AddressInput,
  DeliveryResult,
  MailAddress,
  MailMessage,
  MailTransport,
  TransportCapabilities,
} from './port.ts';
import {
  createTemplates,
  type MailTemplate,
  type RenderedTemplate,
  type Templates,
} from './template.ts';

export interface CreateMailerOptions {
  readonly name?: string | undefined;
  readonly transport: MailTransport;
  /** The sender every message from this mailer uses, unless the message names one. */
  readonly from: AddressInput;
  readonly replyTo?: readonly AddressInput[] | undefined;
  readonly templates?: Templates | Readonly<Record<string, MailTemplate<never>>> | undefined;
  readonly now?: (() => number) | undefined;
}

export interface TemplateMessageInput {
  readonly to: readonly AddressInput[];
  readonly cc?: readonly AddressInput[] | undefined;
  readonly bcc?: readonly AddressInput[] | undefined;
  readonly replyTo?: readonly AddressInput[] | undefined;
  readonly from?: AddressInput | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly attachments?: MessageInput['attachments'];
  readonly tags?: Readonly<Record<string, string>> | undefined;
}

export interface Mailer {
  readonly name: string;
  readonly transport: MailTransport;
  readonly from: MailAddress;
  readonly replyTo: readonly MailAddress[];
  readonly capabilities: TransportCapabilities;
  readonly templates: Templates;
  /** Compose, check, send. The only method that reaches the network. */
  send(input: MessageInput): Promise<DeliveryResult>;
  /** Render a template, then send it — one message, one failure path. */
  sendTemplate(name: string, data: unknown, input: TemplateMessageInput): Promise<DeliveryResult>;
  render(name: string, data?: unknown): RenderedTemplate;
  /** Compose without sending: what `tsir mail:preview` and a test both need. */
  compose(input: MessageInput): MailMessage;
}

function isTemplates(value: CreateMailerOptions['templates']): value is Templates {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Templates).render === 'function' &&
    Array.isArray((value as Templates).names)
  );
}

/**
 * A capability the transport does not have, refused **before** the request.
 *
 * One message per feature, each naming the transport and what it cannot do, because "the
 * attachment was dropped" and "the header was dropped" are different bugs with different fixes.
 */
export function assertCarriable(transport: MailTransport, message: MailMessage): void {
  const caps = transport.capabilities;
  const attachments = message.attachments ?? [];
  const headers = Object.entries(message.headers ?? {});
  const tags = Object.entries(message.tags ?? {});

  if (message.html !== undefined && !caps.html) {
    throw unsupportedOperation(
      transport.name,
      'an HTML body',
      'declare `text` as well, or use a transport whose `capabilities.html` is true',
    );
  }
  if (attachments.length > 0 && !caps.attachments) {
    throw unsupportedOperation(
      transport.name,
      `${String(attachments.length)} attachment(s)`,
      'send the file through `@tsir/storage` and put a signed link in the body, which is what a transport without attachments is good for',
    );
  }
  if (headers.length > 0 && !caps.customHeaders) {
    throw unsupportedOperation(
      transport.name,
      `the header(s) ${headers.map(([name]) => name).join(', ')}`,
      'a header the transport drops is a header the recipient never sees; remove them or use another transport',
    );
  }
  if (tags.length > 0 && !caps.tags) {
    throw unsupportedOperation(
      transport.name,
      `tag(s) ${tags.map(([key]) => key).join(', ')}`,
      'tags are provider metadata; a transport without them cannot report them back on a webhook',
    );
  }
}

export function createMailer(options: CreateMailerOptions): Mailer {
  const transport = options.transport;
  const name = options.name ?? transport.name;
  const from = parseAddress(options.from);
  const replyTo: readonly MailAddress[] = Object.freeze(parseAddresses(options.replyTo));
  const templates = isTemplates(options.templates)
    ? options.templates
    : createTemplates(options.templates ?? {});

  const compose = (input: MessageInput): MailMessage => {
    const message = createMessage({ ...input, from: input.from ?? from });
    // A mailer's `replyTo` is a default, not an override: a message that names one keeps it.
    if (replyTo.length === 0 || message.replyTo !== undefined) return message;
    return Object.freeze({ ...message, replyTo: Object.freeze([...replyTo]) });
  };

  const send = async (input: MessageInput): Promise<DeliveryResult> => {
    const message = compose(input);
    assertCarriable(transport, message);
    return transport.send(message);
  };

  return {
    name,
    transport,
    from,
    replyTo,
    capabilities: transport.capabilities,
    templates,
    compose,
    send,
    render: (name_, data) => templates.render(name_, data),
    sendTemplate: async (name_, data, input) => {
      const rendered = templates.render(name_, data);
      return send({
        ...input,
        subject: rendered.subject,
        text: rendered.text,
        ...(rendered.html === undefined ? {} : { html: rendered.html }),
      });
    },
  };
}

/** The same mailer with a different default sender — used by `mailersFromConfig` per entry. */
export function withDefaultSender(mailer: Mailer, from: AddressInput): Mailer {
  return createMailer({
    name: mailer.name,
    transport: mailer.transport,
    from,
    replyTo: mailer.replyTo,
    templates: mailer.templates,
  });
}

/** Re-exported for callers that hold a `MailMessage` and want the composed-one function. */
export { withSender };
