/**
 * The socket half of `smtp` (`MAIL-7`) — the only file in `@tsir/mail` that imports `node:net`.
 *
 * It exists for exactly one reason: the capability matrix says SMTP is a Bun/Lambda
 * transport and "treat as unsupported on Workers". A `node:net` import in the barrel would make
 * that sentence false for every project, including the ones that never send mail over SMTP; an
 * adapter loaded at send time makes it true, and keeps `@tsir/mail` bundling for a Worker.
 *
 * Buffer handling is the whole difficulty. SMTP replies are line-based and **multi-line**
 * (`250-STARTTLS` continues, `250 SIZE 35882577` ends), so the reader accumulates bytes until a
 * line matches `^\d{3} ` and only then resolves. Getting this wrong shows up as a client that
 * works against a test server and hangs against Gmail.
 *
 * One read at a time is assumed, because SMTP is strictly request/response — a client that pipelined
 * would need a queue here, and this one never does.
 */

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import type { SmtpConnection, SmtpConnector, SmtpReply } from './smtp-types.ts';

/** `250-THING` continues; `250 THING` ends the reply. */
const FINAL = /^\d{3} /u;

/**
 * The three digits, without `Number(...)`.
 *
 * Three ASCII digits are checked by the caller's regex, so this is a subtraction and two shifts —
 * not a coercion that would accept `" 2 "` if the pattern ever loosened.
 */
function replyCode(line: string): number {
  return (
    (line.charCodeAt(0) - 48) * 100 + (line.charCodeAt(1) - 48) * 10 + (line.charCodeAt(2) - 48)
  );
}

/**
 * Pull one complete reply out of the buffer, consuming exactly its bytes.
 *
 * Returns `undefined` when fewer than one *final* line has arrived — the case that must wait
 * rather than guess.
 */
function takeReply(buffer: { value: string }): SmtpReply | undefined {
  let index = 0;
  const lines: string[] = [];
  for (;;) {
    const end = buffer.value.indexOf('\r\n', index);
    if (end === -1) return undefined;
    const line = buffer.value.slice(index, end);
    lines.push(line);
    index = end + 2;
    if (FINAL.test(line)) {
      buffer.value = buffer.value.slice(index);
      return { code: replyCode(line), lines: lines.map((entry) => entry.slice(4)) };
    }
  }
}

export interface NodeSmtpConnectorOptions {
  readonly timeoutMs?: number | undefined;
}

export function nodeSmtpConnector(options: NodeSmtpConnectorOptions = {}): SmtpConnector {
  const defaultTimeout = options.timeoutMs ?? 30_000;

  return async ({ host, port, secure, timeoutMs }): Promise<SmtpConnection> => {
    const timeout = timeoutMs > 0 ? timeoutMs : defaultTimeout;
    let socket: Socket = secure
      ? tlsConnect({ host, port, servername: host })
      : netConnect({ host, port });
    socket.setTimeout(timeout);

    const buffer = { value: '' };
    let failure: Error | undefined;
    let pending:
      { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void } | undefined;

    const deliver = (): void => {
      if (pending === undefined) return;
      const reply = takeReply(buffer);
      if (reply === undefined) return;
      const waiter = pending;
      pending = undefined;
      waiter.resolve(reply);
    };

    const fail = (error: Error): void => {
      failure = error;
      const waiter = pending;
      pending = undefined;
      waiter?.reject(error);
    };

    const attach = (target: Socket): void => {
      // `latin1` and `'binary'` on the write side are the same one-byte mapping. The MIME body is
      // base64, so every byte on this wire is ASCII and no character set is ever in play.
      target.setEncoding('latin1');
      target.on('data', (chunk: string) => {
        buffer.value += chunk;
        deliver();
      });
      target.on('error', fail);
      target.on('timeout', () => {
        fail(
          new Error(`smtp socket to ${host}:${String(port)} timed out after ${String(timeout)} ms`),
        );
      });
    };
    attach(socket);

    return {
      async write(data: string): Promise<void> {
        await new Promise<void>((resolve, reject) => {
          socket.write(data, 'latin1', (error) => {
            if (error === null || error === undefined) resolve();
            else reject(error);
          });
        });
      },

      async read(): Promise<SmtpReply> {
        const ready = takeReply(buffer);
        if (ready !== undefined) return ready;
        if (failure !== undefined) throw failure;
        return new Promise<SmtpReply>((resolve, reject) => {
          pending = { resolve, reject };
        });
      },

      async startTls(): Promise<void> {
        // The plaintext socket becomes the transport for the TLS socket, so nothing is reconnected
        // — and nothing already buffered survives into the encrypted stream.
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('timeout');
        buffer.value = '';
        socket = tlsConnect({ socket, servername: host });
        socket.setTimeout(timeout);
        attach(socket);
        await new Promise<void>((resolve, reject) => {
          socket.once('secureConnect', resolve);
          socket.once('error', reject);
        });
      },

      async close(): Promise<void> {
        await new Promise<void>((resolve) => {
          const done = (): void => resolve();
          socket.once('close', done);
          socket.end();
          // A server that never closes its side must not hold a Lambda invocation open.
          setTimeout(done, 1_000);
        });
        socket.destroy();
      },
    };
  };
}
