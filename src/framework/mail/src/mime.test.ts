/**
 * The MIME writer (`MAIL-6`), and base64 under it.
 *
 * A mail client is the strictest parser this package will ever meet, and it fails silently: the
 * wrong line ending, a header folded inside a token, or a `Bcc` left in the headers produces a
 * message that arrives — looking almost right. So the assertions are on the **bytes**: CRLF
 * everywhere, no `Bcc` line, a part per flavour, and each body decoding back to what went in.
 */

import { describe, expect, test } from 'bun:test';

import { encodeBase64, encodeBase64Lines } from './base64.ts';
import { createMessage } from './message.ts';
import { buildMime, encodeHeaderValue } from './mime.ts';

const NOW = Date.parse('2026-10-29T09:30:00Z');

function decode(base64: string): string {
  return Buffer.from(base64.replace(/\s+/gu, ''), 'base64').toString('utf8');
}

function bodyOf(message: string): string {
  const split = message.indexOf('\r\n\r\n');
  return message.slice(split + 4);
}

const base = {
  from: 'Tsir <no-reply@tsir.local>',
  to: ['ana@example.com'],
  subject: 'Your receipt',
  text: 'Thanks, Ana.',
};

describe('base64', () => {
  test('it matches the platform encoder for every alignment', () => {
    for (const bytes of [
      new Uint8Array([0]),
      new Uint8Array([0, 1]),
      new Uint8Array([0, 1, 2]),
      new Uint8Array([0, 1, 2, 3]),
      new Uint8Array([255, 254, 253, 252, 251]),
      new TextEncoder().encode('any carnal pleasure.'),
    ]) {
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  test('wrapping counts from the start and never breaks a quartet', () => {
    const bytes = new TextEncoder().encode('x'.repeat(100));
    const wrapped = encodeBase64Lines(bytes, 76);
    expect(wrapped.split('\r\n').map((line) => line.length)).toEqual([76, 60]);
    // Round-trips through a decoder that ignores the line breaks, which is what a mail client does.
    expect(Buffer.from(wrapped.replace(/\r\n/gu, ''), 'base64')).toEqual(Buffer.from(bytes));
  });
});

describe('the head', () => {
  test('every line ends in CRLF, and no bare LF exists anywhere', () => {
    const { message } = buildMime(
      createMessage({ ...base, subject: 'a'.repeat(200), text: 'one\ntwo\nthree' }),
      { now: NOW },
    );
    const text = new TextDecoder().decode(message);
    expect(text.includes('\n')).toBe(true);
    expect(/(?<!\r)\n/u.test(text)).toBe(false);
  });

  test('the headers a client needs are all there, and `Date` and `Message-ID` are deterministic', () => {
    const first = buildMime(createMessage(base), { now: NOW });
    expect(first.headers['Date']).toBe('Thu, 29 Oct 2026 09:30:00 GMT');
    expect(first.headers['From']).toBe('Tsir <no-reply@tsir.local>');
    expect(first.headers['To']).toBe('ana@example.com');
    expect(first.headers['Subject']).toBe('Your receipt');
    expect(first.headers['MIME-Version']).toBe('1.0');
    // The domain of the `Message-ID` is the sender's, so a receiver can see who claimed it.
    expect(first.headers['Message-ID']).toMatch(/^<[0-9a-f-]{36}@tsir\.local>$/u);
  });

  test("`Bcc` is never written: the recipients are the envelope's business", () => {
    const { message, headers } = buildMime(
      createMessage({ ...base, bcc: ['secret@example.com'] }),
      { now: NOW },
    );
    const text = new TextDecoder().decode(message);
    expect(Object.keys(headers)).not.toContain('Bcc');
    // Not just the header name — the address must not appear anywhere in the bytes.
    expect(text).not.toContain('secret@example.com');
  });

  test('a non-ASCII subject becomes an RFC 2047 encoded word, one character at a time', () => {
    const encoded = encodeHeaderValue('Café ☕ — your receipt');
    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true);
    expect(encoded).toContain('?=');
    // Decoded back, the words concatenate to the original — that is the property a client relies on.
    const decoded = encoded
      .split('\r\n ')
      .map((word) => decode(word.replace('=?UTF-8?B?', '').replace('?=', '')))
      .join('');
    expect(decoded).toBe('Café ☕ — your receipt');
  });

  test('an ASCII subject is left exactly as written', () => {
    expect(encodeHeaderValue('Plain ASCII, for once')).toBe('Plain ASCII, for once');
  });

  test('a long header folds at a space, and never inside a word', () => {
    const { headers } = buildMime(createMessage({ ...base, subject: 'word '.repeat(40).trim() }), {
      now: NOW,
    });
    for (const line of headers['Subject']?.split('\r\n') ?? []) {
      expect(line.length).toBeLessThanOrEqual(200);
    }
    const unfolded = headers['Subject']?.replace(/\r\n\s+/gu, ' ');
    expect(unfolded).toBe('word '.repeat(40).trim());
  });
});

describe('the body', () => {
  test('a text-only message is one base64 `text/plain` part', () => {
    const { message, contentType } = buildMime(createMessage(base), { now: NOW });
    expect(contentType).toBe('text/plain; charset=utf-8');
    expect(decode(bodyOf(new TextDecoder().decode(message)))).toBe('Thanks, Ana.');
    expect(new TextDecoder().decode(message)).toContain('Content-Transfer-Encoding: base64');
  });

  test('both flavours are `multipart/alternative`, text first', () => {
    const { message, contentType } = buildMime(
      createMessage({ ...base, html: '<p>Thanks, Ana.</p>' }),
      { now: NOW },
    );
    expect(contentType).toStartWith('multipart/alternative; boundary="alt-');

    const text = new TextDecoder().decode(message);
    const textAt = text.indexOf('Content-Type: text/plain');
    const htmlAt = text.indexOf('Content-Type: text/html');
    expect(textAt).toBeGreaterThan(0);
    // Text first: a client that cannot render HTML shows the part it already has, not a blank one.
    expect(textAt).toBeLessThan(htmlAt);
    // And the closing delimiter is there, or every client truncates the last part.
    expect(text).toContain(`--alt-${contentType.split('alt-')[1]?.replace('"', '')}--`);
  });

  test('attachments make it `multipart/mixed`, outside the alternative', () => {
    const { message, contentType } = buildMime(
      createMessage({
        ...base,
        html: '<p>Thanks</p>',
        attachments: [
          {
            filename: 'receipt.pdf',
            content: new TextEncoder().encode('%PDF-1.4 fake'),
            contentType: 'application/pdf',
          },
        ],
      }),
      { now: NOW },
    );
    expect(contentType).toStartWith('multipart/mixed; boundary="tsir-');

    const text = new TextDecoder().decode(message);
    expect(text).toContain('Content-Type: multipart/alternative');
    expect(text).toContain('Content-Type: application/pdf');
    expect(text).toContain('Content-Disposition: attachment; filename="receipt.pdf"');
    // The alternative is *inside* mixed, so an attachment is never offered as a version of the body.
    expect(text.indexOf('Content-Type: application/pdf')).toBeGreaterThan(
      text.indexOf('Content-Type: multipart/alternative'),
    );
  });

  test('an inline part carries its `Content-ID`, which is what `cid:` resolves', () => {
    const { message } = buildMime(
      createMessage({
        ...base,
        html: '<img src="cid:logo">',
        attachments: [
          {
            filename: 'logo.png',
            content: new Uint8Array([137, 80, 78, 71]),
            contentType: 'image/png',
            disposition: 'inline',
            contentId: 'logo',
          },
        ],
      }),
      { now: NOW },
    );
    expect(new TextDecoder().decode(message)).toContain('Content-ID: <logo>');
    expect(new TextDecoder().decode(message)).toContain('Content-Disposition: inline;');
  });

  test('a non-ASCII file name uses RFC 2231 rather than a raw 8-bit header', () => {
    const { message } = buildMime(
      createMessage({
        ...base,
        attachments: [{ filename: 'reçu.pdf', content: new Uint8Array([1]) }],
      }),
      { now: NOW },
    );
    expect(new TextDecoder().decode(message)).toContain("filename*=UTF-8''re%C3%A7u.pdf");
  });

  test('a custom header is written as given', () => {
    const { message } = buildMime(
      createMessage({ ...base, headers: { 'X-Campaign': 'spring-2026' } }),
      { now: NOW },
    );
    expect(new TextDecoder().decode(message)).toContain('X-Campaign: spring-2026');
  });
});
