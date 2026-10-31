/**
 * A message as MIME (`MAIL-6`).
 *
 * Only two transports need this — `smtp`, which speaks the protocol, and `ses`, whose raw form is
 * a MIME blob — but it is written once here rather than twice, because "two implementations of the
 * format a mail client parses" is how one of them ends up with a `\n` where the other has `\r\n`.
 *
 * The choices, each of which is a decision rather than a default:
 *
 *   · **CRLF everywhere.** RFC 5322 says so, and a bare `\n` in a header is what makes an old
 *     parser see two headers — the injection this package refuses, reintroduced by the writer.
 *   · **Base64 for every part.** Quoted-printable is smaller for English text and is a source of
 *     soft-line-break bugs near the 76th column that only show up in one client. Base64 is
 *     boring, and boring is worth 30 % more bytes on an email.
 *   · **`multipart/alternative` inside `multipart/mixed`.** The order matters: the alternative goes
 *     first so a client picks `text/html` from it, and the attachments are outside it so they are
 *     not offered as a "version" of the body.
 *   · **`Bcc` is never written.** The recipients are in the envelope; a header would publish them.
 */

import { encodeBase64Lines } from './base64.ts';
import { formatAddress, formatAddresses } from './port.ts';
import type { Attachment, MailMessage } from './port.ts';

const CRLF = '\r\n';

export interface BuiltMime {
  /** The message as bytes, ready for `DATA` or for `SendRawEmail`. */
  readonly message: Uint8Array;
  /** The top-level headers, for a transport that has to answer a provider's own field names. */
  readonly headers: Readonly<Record<string, string>>;
  /** The top-level `Content-Type`, so a caller can log the shape without parsing it back. */
  readonly contentType: string;
}

/** `=?UTF-8?B?…?=` when a header value is not plain ASCII, and the value unchanged otherwise. */
export function encodeHeaderValue(value: string): string {
  if (/^[\u0000-\u007f]*$/u.test(value)) return value;

  // RFC 2047: an encoded word is at most 75 characters, so at most ~45 UTF-8 bytes before the
  // base64 expansion. Splitting on *characters* keeps a multi-byte character in one word, which
  // is the rule that makes the encoding decodable at all.
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk = '';
  for (const character of value) {
    if (encoder.encode(chunk + character).byteLength > 45) {
      words.push(encodeWord(chunk));
      chunk = '';
    }
    chunk += character;
  }
  if (chunk !== '') words.push(encodeWord(chunk));
  return words.join(`${CRLF} `);
}

function encodeWord(text: string): string {
  return `=?UTF-8?B?${encodeBase64Lines(new TextEncoder().encode(text), 0)}?=`;
}

/**
 * A header line wrapped at 78 characters (`RFC 5322 § 2.1.1`), folded at a space.
 *
 * A single word longer than the limit is left long rather than broken: folding inside a token
 * changes the value, and a header whose value changes when it is written down is worse than a
 * long line.
 */
function fold(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78 || value.includes(CRLF)) return line;

  const lines: string[] = [];
  let current = `${name}:`;
  for (const word of value.split(/\s+/u)) {
    if (current !== `${name}:` && current.length + 1 + word.length > 78) {
      lines.push(current);
      current = ` ${word}`;
      continue;
    }
    current += ` ${word}`;
  }
  lines.push(current);
  return lines.join(CRLF);
}

function part(
  contentType: string,
  body: string | Uint8Array,
  extra: readonly string[] = [],
): string {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return [
    `Content-Type: ${contentType}`,
    'Content-Transfer-Encoding: base64',
    ...extra,
    '',
    encodeBase64Lines(bytes),
  ].join(CRLF);
}

/** A file name for `Content-Disposition`: quoted when ASCII, RFC 2231 when it is not. */
function filenameParameter(filename: string): string {
  if (/^[\u0000-\u007f]*$/u.test(filename) && !/["\\]/u.test(filename)) {
    return `filename="${filename}"`;
  }
  return `filename*=UTF-8''${encodeURIComponent(filename).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )}`;
}

function attachmentPart(attachment: Attachment): string {
  const disposition = attachment.disposition ?? 'attachment';
  const contentType = attachment.contentType ?? 'application/octet-stream';
  return part(contentType, attachment.content, [
    `Content-Disposition: ${disposition}; ${filenameParameter(attachment.filename)}`,
    ...(attachment.contentId === undefined ? [] : [`Content-ID: <${attachment.contentId}>`]),
  ]);
}

/**
 * The message as bytes.
 *
 * `now` is injected so the `Date` header and the `Message-ID` are deterministic in a test — two
 * fields that otherwise make every snapshot differ.
 */
export function buildMime(
  message: MailMessage,
  options: { readonly now?: number } = {},
): BuiltMime {
  const now = options.now ?? Date.now();
  const date = new Date(now).toUTCString();
  const domain = message.from.email.slice(message.from.email.indexOf('@') + 1);
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const boundary = `tsir-${crypto.randomUUID().replace(/-/gu, '')}`;

  const text = message.text;
  const html = message.html;
  const attachments = message.attachments ?? [];

  const textPart: string | undefined =
    text === undefined ? undefined : part('text/plain; charset=utf-8', text);
  const htmlPart: string | undefined =
    html === undefined ? undefined : part('text/html; charset=utf-8', html);

  // The body: a single part, `alternative` for both flavours, and `mixed` when there are files.
  let body: string;
  let bodyType: string;

  const alternative =
    textPart !== undefined && htmlPart !== undefined
      ? [
          `Content-Type: multipart/alternative; boundary="alt-${boundary}"`,
          '',
          `--alt-${boundary}`,
          textPart,
          `--alt-${boundary}`,
          htmlPart,
          `--alt-${boundary}--`,
        ].join(CRLF)
      : (textPart ?? htmlPart ?? '');
  const alternativeType =
    textPart !== undefined && htmlPart !== undefined
      ? `multipart/alternative; boundary="alt-${boundary}"`
      : textPart !== undefined
        ? 'text/plain; charset=utf-8'
        : 'text/html; charset=utf-8';

  // A single-part message is not a one-part multipart: the top-level `Content-Type` already says
  // what the body is, so the body is the encoded part and nothing else. Wrapping it in a boundary
  // would be legal and is what some clients render as an empty message.
  let transferEncoding: string | undefined;

  if (attachments.length === 0 && (text === undefined || html === undefined)) {
    const single = new TextEncoder().encode(text ?? html ?? '');
    body = encodeBase64Lines(single);
    bodyType = text !== undefined ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';
    transferEncoding = 'base64';
  } else if (attachments.length === 0) {
    body = alternative;
    bodyType = alternativeType;
  } else {
    body = [
      `--${boundary}`,
      // `alternative` already opens with its own `Content-Type` — a `multipart/alternative` when
      // there are two flavours, `text/*` when there is one — so nothing is added here.
      alternative,
      ...attachments.map((attachment) => [`--${boundary}`, attachmentPart(attachment)].join(CRLF)),
      `--${boundary}--`,
    ].join(CRLF);
    bodyType = `multipart/mixed; boundary="${boundary}"`;
  }

  const headers: Record<string, string> = {
    Date: date,
    From: formatAddress(message.from),
    To: formatAddresses(message.to).join(', '),
    ...(message.cc === undefined || message.cc.length === 0
      ? {}
      : { Cc: formatAddresses(message.cc).join(', ') }),
    ...(message.replyTo === undefined || message.replyTo.length === 0
      ? {}
      : { 'Reply-To': formatAddresses(message.replyTo).join(', ') }),
    Subject: encodeHeaderValue(message.subject),
    'Message-ID': messageId,
    'MIME-Version': '1.0',
    'Content-Type': bodyType,
    ...(transferEncoding === undefined ? {} : { 'Content-Transfer-Encoding': transferEncoding }),
    ...(message.headers ?? {}),
  };

  const head = Object.entries(headers)
    .map(([name, value]) => fold(name, value))
    .join(CRLF);

  return {
    message: new TextEncoder().encode(`${head}${CRLF}${CRLF}${body}${CRLF}`),
    headers,
    contentType: bodyType,
  };
}
