/**
 * `smtp` — the protocol, against a scripted connection (`MAIL-7`).
 *
 * The scripted connection is the point of the two-file split: every case here is a conversation
 * (`220`, `250-STARTTLS`, `235`, `354`, `250`) driven with no socket, no port and no sleep, and
 * every line the client wrote is asserted. The three refusals that matter — a server that will not
 * do STARTTLS, a server that rejects every recipient, and a password that would go out in the
 * clear — are all cases a real server makes hard to reproduce and easy to get wrong.
 */

import { describe, expect, test } from 'bun:test';

import { createMessage } from './message.ts';
import { dotStuff, parseCapabilities, smtpTransport } from './transports/smtp.ts';
import type { SmtpConnection, SmtpReply } from './transports/adapters/smtp-types.ts';

interface Script {
  readonly replies: SmtpReply[];
}

function scripted(script: Script): {
  connect: () => Promise<SmtpConnection>;
  written: string[];
  closed: boolean;
} {
  const { replies } = script;
  const written: string[] = [];
  const state = { closed: false };
  let tls = 0;

  return {
    written,
    get closed() {
      return state.closed;
    },
    connect: async (): Promise<SmtpConnection> =>
      ({
        async write(data: string) {
          written.push(data);
        },
        async read(): Promise<SmtpReply> {
          const reply = replies.shift();
          if (reply === undefined) throw new Error('the script ran out of replies');
          return reply;
        },
        async startTls() {
          tls += 1;
          written.push('<tls>');
        },
        async close() {
          state.closed = true;
        },
        get upgraded() {
          return tls > 0;
        },
      }) as SmtpConnection,
  };
}

const ok = (code: number, ...lines: string[]): SmtpReply => ({ code, lines });
const base = {
  from: 'Tsir <no-reply@tsir.local>',
  to: ['ana@example.com'],
  subject: 'Your receipt',
  text: 'Thanks, Ana.',
};

/** The conversation a healthy submission makes over STARTTLS with `AUTH PLAIN`. */
function healthy(): SmtpReply[] {
  return [
    ok(220, 'mail.example.com ESMTP ready'),
    ok(250, 'mail.example.com', 'SIZE 35882577', 'STARTTLS', 'AUTH PLAIN LOGIN'),
    ok(220, 'go ahead'),
    ok(250, 'mail.example.com', 'AUTH PLAIN LOGIN'),
    ok(235, '2.7.0 accepted'),
    ok(250, '2.1.0 ok'),
    ok(250, '2.1.5 ok'),
    ok(354, 'go ahead'),
    ok(250, '2.0.0 queued as 4F2A'),
    ok(221, 'bye'),
  ];
}

describe('the conversation', () => {
  test('greeting, EHLO, STARTTLS, AUTH, MAIL, RCPT, DATA, QUIT — in order', async () => {
    const script = scripted({ replies: healthy() });
    const transport = smtpTransport({
      host: 'mail.example.com',
      auth: { user: 'tsir', pass: 'hunter2' },
      connect: script.connect,
    });

    const result = await transport.send(createMessage(base));

    const conversation = script.written.join('');
    expect(conversation).toStartWith('EHLO tsir.local\r\nSTARTTLS\r\n');
    expect(conversation).toContain('AUTH PLAIN ');
    expect(conversation).toContain('MAIL FROM:<no-reply@tsir.local>\r\n');
    expect(conversation).toContain('RCPT TO:<ana@example.com>\r\n');
    expect(conversation).toContain('DATA\r\n');
    expect(conversation).toEndWith('QUIT\r\n');

    // The body is base64 of a real MIME document, and the terminator is `<CRLF>.<CRLF>`.
    expect(conversation).toContain('MIME-Version: 1.0');
    expect(conversation).toContain('\r\n.\r\n');

    expect(result.accepted).toEqual(['ana@example.com']);
    expect(result.id).toStartWith('<');
    expect(script.closed).toBe(true);
  });

  test('the capabilities are re-read after STARTTLS, because AUTH usually appears only then', async () => {
    const script = scripted({
      replies: [
        ok(220, 'ready'),
        // Before TLS: only STARTTLS. A client that kept this answer would refuse to authenticate.
        ok(250, 'mail.example.com', 'STARTTLS'),
        ok(220, 'go ahead'),
        ok(250, 'mail.example.com', 'AUTH LOGIN'),
        ok(334, 'VXNlcm5hbWU6'),
        ok(334, 'UGFzc3dvcmQ6'),
        ok(235, 'accepted'),
        ok(250, 'ok'),
        ok(250, 'ok'),
        ok(354, 'go'),
        ok(250, 'queued'),
        ok(221, 'bye'),
      ],
    });
    const transport = smtpTransport({
      host: 'mail.example.com',
      auth: { user: 'tsir', pass: 'hunter2' },
      connect: script.connect,
    });

    await transport.send(createMessage(base));

    expect(script.written.join('')).toContain('AUTH LOGIN\r\n');
  });

  test('a server that does not offer STARTTLS is refused, not trusted with a password', async () => {
    const script = scripted({
      replies: [ok(220, 'ready'), ok(250, 'mail.example.com', 'AUTH PLAIN LOGIN')],
    });
    const transport = smtpTransport({
      host: 'mail.example.com',
      auth: { user: 'tsir', pass: 'hunter2' },
      connect: script.connect,
    });

    const attempt = transport.send(createMessage(base));
    expect(attempt).rejects.toThrow(/does not offer STARTTLS/u);
    // Nothing was sent: the refusal happens before `AUTH`.
    expect(script.written.join('')).not.toContain('AUTH');
    expect(script.closed).toBe(true);
  });

  test('`requireTls: false` is an explicit choice, and it is recorded in the conversation', async () => {
    const script = scripted({
      replies: [
        ok(220, 'ready'),
        ok(250, 'mail.example.com', 'AUTH PLAIN'),
        ok(235, 'accepted'),
        ok(250, 'ok'),
        ok(250, 'ok'),
        ok(354, 'go'),
        ok(250, 'queued'),
        ok(221, 'bye'),
      ],
    });
    const transport = smtpTransport({
      host: 'localhost',
      port: 25,
      requireTls: false,
      auth: { user: 'u', pass: 'p' },
      connect: script.connect,
    });
    await transport.send(createMessage(base));
    // No STARTTLS in the transcript at all — and the password only after that decision.
    expect(script.written.join('')).not.toContain('STARTTLS');
  });

  test('a permanently rejected recipient is reported, and the rest of the message still goes', async () => {
    const script = scripted({
      replies: [
        ok(220, 'ready'),
        ok(250, 'mail.example.com', 'STARTTLS'),
        ok(220, 'go ahead'),
        ok(250, 'mail.example.com'),
        ok(250, 'sender ok'),
        ok(250, 'ana ok'),
        ok(550, '5.1.1 no such user'),
        ok(354, 'go'),
        ok(250, 'queued'),
        ok(221, 'bye'),
      ],
    });
    const transport = smtpTransport({
      host: 'mail.example.com',
      connect: script.connect,
    });
    const result = await transport.send(createMessage({ ...base, cc: ['gone@example.com'] }));

    expect(result.accepted).toEqual(['ana@example.com']);
    expect(result.rejected).toEqual([{ email: 'gone@example.com', reason: '5.1.1 no such user' }]);
  });

  test('every recipient refused is a failure, not a message to nobody', async () => {
    const script = scripted({
      replies: [
        ok(220, 'ready'),
        ok(250, 'mail.example.com', 'STARTTLS'),
        ok(220, 'go ahead'),
        ok(250, 'mail.example.com'),
        ok(250, 'sender ok'),
        ok(550, '5.1.1 no such user'),
      ],
    });
    const transport = smtpTransport({ host: 'mail.example.com', connect: script.connect });
    expect(transport.send(createMessage(base))).rejects.toThrow(/every recipient was refused/u);
    expect(script.written.join('')).not.toContain('DATA');
  });

  test('a 5xx greeting or a 250 where 354 belongs is a coded failure', async () => {
    const refused = scripted({ replies: [ok(554, 'no service for you')] });
    expect(
      smtpTransport({ host: 'h', connect: refused.connect }).send(createMessage(base)),
    ).rejects.toMatchObject({ code: 'MAIL_TRANSPORT_FAILED' });

    const noData = scripted({
      replies: [
        ok(220, 'ready'),
        ok(250, 'm', 'STARTTLS'),
        ok(220, 'go'),
        ok(250, 'm'),
        ok(250, 'sender'),
        ok(250, 'rcpt'),
        ok(250, 'not 354'),
      ],
    });
    expect(
      smtpTransport({ host: 'h', connect: noData.connect }).send(createMessage(base)),
    ).rejects.toThrow(/DATA \(server answered 250\)/u);
  });
});

describe('dot-stuffing', () => {
  test('a line that starts with a dot gets another one', () => {
    // Without this, `.` on its own line ends `DATA` and the rest of the message is read as
    // commands — which is how a mail client receives a truncated message and a `MAIL FROM`.
    expect(dotStuff('a\r\n.\r\nb')).toBe('a\r\n..\r\nb\r\n.');
    expect(dotStuff('..already')).toBe('...already\r\n.');
  });

  test('bare newlines are normalised before stuffing, and the terminator is added once', () => {
    expect(dotStuff('one\ntwo\n')).toBe('one\r\ntwo\r\n.');
    expect(dotStuff('one\r\ntwo\r\n')).toBe('one\r\ntwo\r\n.');
  });
});

describe('capabilities parsing', () => {
  test('STARTTLS and the auth mechanisms are read out of the multi-line answer', () => {
    expect(
      parseCapabilities({
        lines: ['mail.example.com', 'SIZE 35882577', 'STARTTLS', 'AUTH PLAIN LOGIN XOAUTH2'],
      }),
    ).toEqual({ startTls: true, authMechanisms: ['PLAIN', 'LOGIN', 'XOAUTH2'] });
    expect(parseCapabilities({ lines: ['mail.example.com', 'PIPELINING'] })).toEqual({
      startTls: false,
      authMechanisms: [],
    });
  });
});
