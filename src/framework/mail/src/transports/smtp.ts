/**
 * `smtp` — the protocol, over an injectable connection (`MAIL-7`).
 *
 * Split in two on purpose. **This file is the conversation** — ESMTP greeting, `EHLO` capabilities,
 * `STARTTLS`, `AUTH`, `MAIL`/`RCPT`/`DATA` — and it is written against a five-method connection
 * object. **The socket** lives in `adapters/smtp-node.ts`, which is the only file in the package
 * that imports `node:net`.
 *
 * The split is what makes an SMTP client testable at all: the tests drive a scripted connection
 * that answers `220`, `250-STARTTLS`, `235`, `354`, `250` in order and records every line written,
 * so the *protocol* is asserted without a server, a port or a sleep. It is also what keeps the
 * package's barrel free of `node:` imports: the adapter is loaded when a send actually happens.
 *
 * Two refusals worth naming:
 *
 *   · **`AUTH` over plaintext is refused** (`requireTls`, on by default). Sending a password in the
 *     clear is the one mistake in this file that cannot be undone by a later fix.
 *   · **A message with no accepted recipient is a failure**, not a send to nobody. A server that
 *     rejects every `RCPT` is a misconfigured relay, and reporting it as delivered is the exact
 *     lie `DeliveryResult.rejected` exists to avoid.
 */

import { encodeBase64Lines } from '../base64.ts';
import { transportFailed } from '../errors.ts';
import { buildMime } from '../mime.ts';
import type { DeliveryResult, MailMessage, MailTransport } from '../port.ts';
import type { SmtpConnection, SmtpConnector } from './adapters/smtp-types.ts';

export type { SmtpConnection, SmtpConnector, SmtpReply } from './adapters/smtp-types.ts';

export interface SmtpTransportOptions {
  readonly host: string;
  /** `587` (submission with STARTTLS) unless `secure` is set, in which case `465`. */
  readonly port?: number | undefined;
  /** Implicit TLS, the `465` shape. When false, `STARTTLS` is negotiated if offered. */
  readonly secure?: boolean | undefined;
  /** Refuse to `AUTH` over a plaintext connection. Default `true`, and the default is the point. */
  readonly requireTls?: boolean | undefined;
  readonly auth?: { readonly user: string; readonly pass: string } | undefined;
  /** What `EHLO` announces. A bare hostname; a domain that resolves is polite, not required. */
  readonly helloName?: string | undefined;
  /** The connector. Left out, `send` loads the `node:net` adapter. */
  readonly connect?: SmtpConnector | undefined;
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly name?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;

interface Capabilities {
  readonly startTls: boolean;
  readonly authMechanisms: readonly string[];
}

/** Parse `EHLO`'s multi-line answer into the three facts this client uses. */
export function parseCapabilities(reply: { readonly lines: readonly string[] }): Capabilities {
  let startTls = false;
  const mechanisms: string[] = [];

  for (const line of reply.lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith('STARTTLS')) startTls = true;
    if (upper.startsWith('AUTH')) {
      mechanisms.push(
        ...upper
          .slice(4)
          .trim()
          .split(/\s+/u)
          .filter((name) => name !== ''),
      );
    }
  }

  return { startTls, authMechanisms: mechanisms };
}

/**
 * `DATA` payloads dot-stuff (`RFC 5321 § 4.5.2`): a line that starts with `.` gets another one, or
 * the server reads it as the terminator and truncates the message silently.
 */
export function dotStuff(message: string): string {
  const normalised = message.replace(/\r?\n/gu, '\r\n');
  const stuffed = normalised
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
  return stuffed.endsWith('\r\n') ? `${stuffed}.` : `${stuffed}\r\n.`;
}

export function smtpTransport(options: SmtpTransportOptions): MailTransport {
  const port = options.port ?? (options.secure === true ? 465 : 587);
  const name = options.name ?? 'smtp';
  const now = options.now ?? Date.now;
  const requireTls = options.requireTls ?? true;

  const connector = async (): Promise<SmtpConnector> => {
    if (options.connect !== undefined) return options.connect;
    // Loaded here, not at the top of the module: `node:net` in the barrel's graph would put a
    // `node:` import in every bundle, including the Workers one this package must survive.
    const adapter = await import('./adapters/smtp-node.ts');
    return adapter.nodeSmtpConnector({ timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  };

  return {
    name,
    capabilities: {
      delivers: true,
      html: true,
      attachments: true,
      customHeaders: true,
      tags: false,
    },

    async send(message: MailMessage): Promise<DeliveryResult> {
      const mime = buildMime(message, { now: now() });
      const connection = await (
        await connector()
      )({
        host: options.host,
        port,
        secure: options.secure === true,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

      const command = async (line: string, allowed: readonly number[], what: string) => {
        await connection.write(`${line}\r\n`);
        const reply = await connection.read();
        if (!allowed.includes(reply.code)) {
          throw transportFailed({
            transport: name,
            operation: `${what} (server answered ${String(reply.code)})`,
            detail: reply.lines.join(' ').slice(0, 200),
          });
        }
        return reply;
      };

      try {
        const greeting = await connection.read();
        if (greeting.code !== 220) {
          throw transportFailed({
            transport: name,
            operation: 'the greeting',
            status: greeting.code,
            detail: greeting.lines.join(' ').slice(0, 200),
          });
        }

        let capabilities = parseCapabilities(
          await command(`EHLO ${options.helloName ?? 'tsir.local'}`, [250], 'EHLO'),
        );

        if (options.secure !== true) {
          if (capabilities.startTls) {
            await command('STARTTLS', [220], 'STARTTLS');
            await connection.startTls();
            // Capabilities are re-read: after TLS the server may offer `AUTH` it would not offer
            // in the clear, and using the pre-TLS answer would refuse a login that now works.
            capabilities = parseCapabilities(
              await command(
                `EHLO ${options.helloName ?? 'tsir.local'}`,
                [250],
                'EHLO after STARTTLS',
              ),
            );
          } else if (requireTls) {
            throw transportFailed({
              transport: name,
              operation: 'starting TLS',
              detail: `the server at ${options.host}:${String(port)} does not offer STARTTLS, and \`requireTls\` is on — sending the password in the clear is refused`,
            });
          }
        }

        if (options.auth !== undefined) {
          await authenticate(connection, options.auth, capabilities, name);
        }

        const from = message.from.email;
        await command(`MAIL FROM:<${from}>`, [250], 'MAIL FROM');

        const accepted: string[] = [];
        const rejected: { email: string; reason: string }[] = [];
        for (const recipient of [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])]) {
          await connection.write(`RCPT TO:<${recipient.email}>\r\n`);
          const reply = await connection.read();
          // 250 and 251 are both acceptance (`251` = "will forward"); 550/551/553 are refusals a
          // caller can act on; anything else is a protocol surprise and must not be swallowed.
          if (reply.code === 250 || reply.code === 251) {
            accepted.push(recipient.email);
            continue;
          }
          if (reply.code >= 500 && reply.code < 600) {
            rejected.push({ email: recipient.email, reason: reply.lines.join(' ').slice(0, 200) });
            continue;
          }
          throw transportFailed({
            transport: name,
            operation: `RCPT TO:<${recipient.email}> (server answered ${String(reply.code)})`,
            detail: reply.lines.join(' ').slice(0, 200),
          });
        }

        if (accepted.length === 0) {
          throw transportFailed({
            transport: name,
            operation: 'DATA (every recipient was refused)',
            detail: rejected
              .map((entry) => `${entry.email}: ${entry.reason}`)
              .join('; ')
              .slice(0, 300),
          });
        }

        await command('DATA', [354], 'DATA');
        await connection.write(`${dotStuff(new TextDecoder().decode(mime.message))}\r\n`);
        const stored = await connection.read();
        if (stored.code !== 250) {
          throw transportFailed({
            transport: name,
            operation: `DATA (server answered ${String(stored.code)} after the message)`,
            detail: stored.lines.join(' ').slice(0, 200),
          });
        }

        await connection.write('QUIT\r\n');
        await connection.read().catch(() => undefined);

        return {
          id:
            mime.headers['Message-ID'] ??
            `<${crypto.randomUUID()}@${from.split('@')[1] ?? 'localhost'}>`,
          accepted,
          ...(rejected.length === 0 ? {} : { rejected }),
        };
      } finally {
        await connection.close().catch(() => undefined);
      }
    },
  };
}

async function authenticate(
  connection: SmtpConnection,
  auth: { readonly user: string; readonly pass: string },
  capabilities: Capabilities,
  transport: string,
): Promise<void> {
  const mechanisms = capabilities.authMechanisms;
  if (mechanisms.length === 0) {
    throw transportFailed({
      transport,
      operation: 'AUTH',
      detail: 'the server advertises no authentication mechanism, and credentials were given',
    });
  }

  if (mechanisms.includes('PLAIN')) {
    const token = encodeBase64Lines(
      new TextEncoder().encode(`\u0000${auth.user}\u0000${auth.pass}`),
      0,
    );
    await connection.write(`AUTH PLAIN ${token}\r\n`);
    const reply = await connection.read();
    if (reply.code !== 235) {
      throw transportFailed({
        transport,
        operation: `AUTH PLAIN (server answered ${String(reply.code)})`,
        detail: reply.lines.join(' ').slice(0, 200),
      });
    }
    return;
  }

  if (mechanisms.includes('LOGIN')) {
    const encoder = new TextEncoder();
    for (const step of [
      { line: 'AUTH LOGIN', value: undefined, expected: 334, what: 'AUTH LOGIN' },
      {
        line: encodeBase64Lines(encoder.encode(auth.user), 0),
        value: 'user',
        expected: 334,
        what: 'AUTH LOGIN (user)',
      },
      {
        line: encodeBase64Lines(encoder.encode(auth.pass), 0),
        value: 'pass',
        expected: 235,
        what: 'AUTH LOGIN (password)',
      },
    ] as const) {
      await connection.write(`${step.line}\r\n`);
      const reply = await connection.read();
      if (reply.code !== step.expected) {
        throw transportFailed({
          transport,
          operation: `${step.what} (server answered ${String(reply.code)})`,
          detail: reply.lines.join(' ').slice(0, 200),
        });
      }
    }
    return;
  }

  throw transportFailed({
    transport,
    operation: 'AUTH',
    detail: `the server offers ${mechanisms.join(', ')}, and this client speaks PLAIN and LOGIN`,
  });
}
