/**
 * The connection a `smtp` transport talks to.
 *
 * Five methods, no socket: `write` sends one line (already terminated), `read` waits for one
 * complete reply, `startTls` upgrades in place, `close` ends it. Everything about TCP, TLS and
 * buffering lives in `smtp-node.ts`; everything about the protocol lives in `smtp.ts`.
 *
 * A reply is a code and its lines because SMTP replies are multi-line — `250-STARTTLS` continues
 * while `250 STARTTLS` ends, and a client that read one line would see half a capability list.
 */

export interface SmtpReply {
  readonly code: number;
  readonly lines: readonly string[];
}

export interface SmtpConnection {
  /** One command line, or the message body for `DATA`. */
  write(data: string): Promise<void>;
  /** The next complete reply. */
  read(): Promise<SmtpReply>;
  /** Upgrade the existing socket to TLS (the `STARTTLS` shape). */
  startTls(): Promise<void>;
  close(): Promise<void>;
}

export interface SmtpConnectorOptions {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS from the first byte (port 465). */
  readonly secure: boolean;
  readonly timeoutMs: number;
}

export type SmtpConnector = (options: SmtpConnectorOptions) => Promise<SmtpConnection>;
