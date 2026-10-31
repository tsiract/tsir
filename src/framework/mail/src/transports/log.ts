/**
 * `log` — writes the message, sends nothing (`MAIL-7`).
 *
 * The development default, and the reason `delivers: false` exists: this transport is *useful*
 * (the reset link is right there in the terminal, which is the whole point) and *wrong everywhere
 * else*, so production refuses it as the default with a code instead of a comment.
 *
 * It prints every field it was given — including attachments, by name and size — so a mailer on
 * `log` is not a mailer that "loses" things silently. What it cannot honour is `tags`: they are
 * provider metadata, and a log line is where they would be *printed*, not acted on. That is
 * `tags: false`, and a caller that sets one gets `MAIL_UNSUPPORTED_OPERATION` rather than a line
 * that looks like it recorded something.
 */

import {
  envelopeOf,
  formatAddress,
  formatAddresses,
  type DeliveryResult,
  type MailMessage,
  type MailTransport,
} from '../port.ts';

export interface LogTransportOptions {
  /** Where a line goes. `console.log` by default; a test passes an array collector. */
  readonly write?: ((text: string) => void) | undefined;
  /** Shown by `tsir mail:preview` and in the block header. */
  readonly label?: string | undefined;
}

function kibibytes(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

/** The block a person reads. Deterministic apart from `now`, so a test can assert on it. */
export function formatLoggedMessage(
  message: MailMessage,
  options: { readonly label?: string } = {},
): string {
  const lines: string[] = [];
  const title = options.label === undefined ? '' : ` ${options.label}`;
  lines.push(`── mail${title} ─────────────────────────────────────────`);
  lines.push(`from:    ${formatAddress(message.from)}`);
  lines.push(`to:      ${formatAddresses(message.to).join(', ')}`);
  if (message.cc !== undefined && message.cc.length > 0) {
    lines.push(`cc:      ${formatAddresses(message.cc).join(', ')}`);
  }
  // `bcc` is printed as a count, not as addresses: a log is copied into bug reports.
  if (message.bcc !== undefined && message.bcc.length > 0) {
    lines.push(`bcc:     ${String(message.bcc.length)} recipient(s), not shown`);
  }
  if (message.replyTo !== undefined && message.replyTo.length > 0) {
    lines.push(`reply-to:${' '}${formatAddresses(message.replyTo).join(', ')}`);
  }
  lines.push(`subject: ${message.subject}`);
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    lines.push(`${name}: ${value}`);
  }
  if (message.text !== undefined) {
    lines.push('text:');
    for (const line of message.text.split('\n')) lines.push(`  ${line}`);
  }
  if (message.html !== undefined) {
    // The HTML is not printed whole: a link is what a person needs from it, and a terminal full of
    // markup is how the useful line scrolls away.
    lines.push(`html:    ${String(new TextEncoder().encode(message.html).byteLength)} bytes`);
  }
  for (const attachment of message.attachments ?? []) {
    lines.push(
      `attach:  ${attachment.filename} (${kibibytes(attachment.content.byteLength)}, ${attachment.contentType ?? 'application/octet-stream'})`,
    );
  }
  lines.push('────────────────────────────────────────────────────────');
  return lines.join('\n');
}

export function logTransport(options: LogTransportOptions = {}): MailTransport {
  // The console is this transport's sink — printing is the whole feature — so the rule that bans
  // a stray `console.log` in framework code is waived here, once, at the only place it applies.
  // eslint-disable-next-line no-console
  const write = options.write ?? ((text: string) => console.log(text));

  return {
    name: 'log',
    capabilities: {
      delivers: false,
      html: true,
      attachments: true,
      customHeaders: true,
      // Postmark is why this is per-transport rather than a global "rich" flag: a transport can
      // carry a body and a file and still have nowhere to put provider metadata.
      tags: false,
    },
    async send(message: MailMessage): Promise<DeliveryResult> {
      write(
        formatLoggedMessage(message, options.label === undefined ? {} : { label: options.label }),
      );
      return {
        id: `log-${crypto.randomUUID()}`,
        // "Accepted" is the envelope, not a delivery: the transport's `delivers: false` is what
        // says nothing left the process, and a result that listed the recipients as *rejected*
        // would be reporting a bounce that did not happen.
        accepted: envelopeOf(message).to.map((address) => address.email),
      };
    },
  };
}
