/**
 * Composing a message (`MAIL-2`).
 *
 * `createMessage` is the only way a `MailMessage` comes into existence, and it does four things a
 * transport must never have to: it parses every address (see `address.ts`), it refuses a message
 * that would send nothing, it refuses a message that would send the same person two copies, and it
 * refuses a custom header that would collide with one the package itself writes.
 *
 * The rules are enforced **here** rather than in each transport because they are facts about mail,
 * not about Resend. A transport that had to re-check them would be a transport that could forget.
 */

import { parseAddress, parseAddresses } from './address.ts';
import { invalidMessage } from './errors.ts';
import type { AddressInput, Attachment, MailAddress, MailMessage } from './port.ts';

export interface MessageInput {
  /** Defaults to the mailer's `from`. A message that names one overrides it for this send. */
  readonly from?: AddressInput | undefined;
  readonly to: readonly AddressInput[];
  readonly cc?: readonly AddressInput[] | undefined;
  readonly bcc?: readonly AddressInput[] | undefined;
  readonly replyTo?: readonly AddressInput[] | undefined;
  readonly subject: string;
  readonly text?: string | undefined;
  readonly html?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly attachments?: readonly Attachment[] | undefined;
  readonly tags?: Readonly<Record<string, string>> | undefined;
}

/**
 * Headers this package writes itself. A custom header with one of these names would either be
 * silently overwritten or, worse, silently win — so it is refused.
 */
const RESERVED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'return-path',
]);

function checkText(value: string, what: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw invalidMessage(
      `the ${what} contains a control character`,
      'tab and newline are fine in a body; other control characters are not, and a body is not a place to smuggle one',
    );
  }
  return value;
}

function checkTags(
  tags: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (tags === undefined) return undefined;
  for (const [key, value] of Object.entries(tags)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(key)) {
      throw invalidMessage(
        `the tag name ${JSON.stringify(key)} is not [A-Za-z0-9_-]{1,64}`,
        'tags become provider metadata, and every provider constrains the name',
      );
    }
    checkText(value, `tag "${key}"`);
  }
  return { ...tags };
}

function checkHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) return undefined;
  const checked: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]{1,64}$/u.test(name)) {
      throw invalidMessage(
        `the header name ${JSON.stringify(name)} is not [A-Za-z0-9-]`,
        'a header name is a token; anything else is a header injection with extra steps',
      );
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw invalidMessage(
        `the header "${name}" is written by the mail package and cannot be overridden`,
        'set `from`, `to`, `subject` and friends on the message instead — one place decides each header',
      );
    }
    // The whole reason the address parser exists: this is what a smuggled header looks like.
    if (/[\u0000-\u001f\u007f]/u.test(value)) {
      throw invalidMessage(
        `the header "${name}" contains a control character`,
        'a newline in a header value starts a second header; that is the injection this check exists for',
      );
    }
    checked[name] = value;
  }
  return checked;
}

function checkAttachments(
  attachments: readonly Attachment[] | undefined,
): readonly Attachment[] | undefined {
  if (attachments === undefined) return undefined;
  return attachments.map((attachment) => {
    if (attachment.filename.trim() === '') {
      throw invalidMessage(
        'an attachment has no file name',
        'give it one — a provider falls back to "attachment" and nobody can tell what it is',
      );
    }
    if (/[\\/\u0000-\u001f\u007f]/u.test(attachment.filename)) {
      throw invalidMessage(
        `the attachment name ${JSON.stringify(attachment.filename)} contains a path separator or control character`,
        'an attachment name is a name, not a path: `report.pdf`, not `../report.pdf`',
      );
    }
    if (attachment.content.byteLength === 0) {
      throw invalidMessage(
        `the attachment "${attachment.filename}" is empty`,
        'a zero-byte attachment is always a bug upstream; send the message without it, or fix what produced it',
      );
    }
    if (attachment.contentId !== undefined && attachment.disposition !== 'inline') {
      throw invalidMessage(
        `the attachment "${attachment.filename}" has a contentId but is not inline`,
        "set `disposition: 'inline'` — a cid only resolves for a part the client renders in the body",
      );
    }
    return {
      filename: attachment.filename,
      content: attachment.content,
      ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
      ...(attachment.disposition === undefined ? {} : { disposition: attachment.disposition }),
      ...(attachment.contentId === undefined ? {} : { contentId: attachment.contentId }),
    };
  });
}

/** Everyone the message would be delivered to, in envelope order. */
function envelopeOfInput(
  to: readonly MailAddress[],
  cc: readonly MailAddress[],
  bcc: readonly MailAddress[],
): MailAddress[] {
  return [...to, ...cc, ...bcc];
}

/**
 * A composed message.
 *
 * Deep-ish frozen: the arrays and the message are immutable, and an attachment's bytes are *not*
 * copied. Copying a 20 MB attachment to enforce immutability would be the expensive kind of
 * correctness; a caller that mutates bytes it just handed over is a caller with a bigger problem.
 */
export function createMessage(input: MessageInput): MailMessage {
  if (input.from === undefined) {
    throw invalidMessage(
      'no sender',
      'pass `from` on the message, or configure `mail.mailers.<name>.from` so the mailer supplies one',
    );
  }
  const from = parseAddress(input.from);

  const to = parseAddresses(input.to);
  const cc = parseAddresses(input.cc);
  const bcc = parseAddresses(input.bcc);

  const everyone = envelopeOfInput(to, cc, bcc);
  if (everyone.length === 0) {
    throw invalidMessage(
      'there are no recipients',
      'pass `to`, `cc` or `bcc` — a message with no recipient is refused, not silently dropped',
    );
  }

  // One copy per person. A duplicate is the kind of thing that produces two receipts and one
  // support ticket, and it is always a caller's list that was concatenated twice.
  const lists = [
    ['to', to],
    ['cc', cc],
    ['bcc', bcc],
  ] as const;
  const seen = new Map<string, string>();
  for (const [list, addresses] of lists) {
    for (const address of addresses) {
      const key = address.email.toLowerCase();
      const first = seen.get(key);
      if (first !== undefined) {
        throw invalidMessage(
          first === list
            ? `"${address.email}" appears twice in "${list}"`
            : `"${address.email}" appears in both "${first}" and "${list}"`,
          'each recipient is named once; `to` + `cc` + `bcc` together decide who gets a copy, and two copies is never what was meant',
        );
      }
      seen.set(key, list);
    }
  }

  const subject = checkText(input.subject, 'subject');
  if (subject.trim() === '') {
    throw invalidMessage(
      'the subject is empty',
      'an empty subject is almost always a template variable that did not arrive; set one, even a short one',
    );
  }
  if (subject.includes('\n') || subject.includes('\r')) {
    throw invalidMessage(
      'the subject spans more than one line',
      'a subject is one line; the body has the other lines',
    );
  }

  if (input.text === undefined && input.html === undefined) {
    throw invalidMessage(
      'there is neither a text nor an HTML body',
      'send at least one — a `text` alternative is what a client without HTML shows, and it is the one people can read',
    );
  }

  return Object.freeze({
    from,
    to: Object.freeze(to),
    ...(cc.length === 0 ? {} : { cc: Object.freeze(cc) }),
    ...(bcc.length === 0 ? {} : { bcc: Object.freeze(bcc) }),
    ...(input.replyTo === undefined || input.replyTo.length === 0
      ? {}
      : { replyTo: Object.freeze(parseAddresses(input.replyTo)) }),
    subject,
    ...(input.text === undefined ? {} : { text: checkText(input.text, 'body') }),
    ...(input.html === undefined ? {} : { html: checkText(input.html, 'HTML body') }),
    ...(input.headers === undefined
      ? {}
      : { headers: Object.freeze(checkHeaders(input.headers) ?? {}) }),
    ...(input.attachments === undefined || input.attachments.length === 0
      ? {}
      : { attachments: Object.freeze(checkAttachments(input.attachments) ?? []) }),
    ...(input.tags === undefined ? {} : { tags: Object.freeze(checkTags(input.tags) ?? {}) }),
  });
}

/** The same message with a different sender — how a mailer applies its configured `from`. */
export function withSender(message: MailMessage, from: AddressInput): MailMessage {
  return Object.freeze({ ...message, from: parseAddress(from) });
}

/** The recipients of a message, in the order a provider is asked to deliver to them. */
export function recipientsOf(message: MailMessage): MailAddress[] {
  return envelopeOfInput(message.to, message.cc ?? [], message.bcc ?? []);
}
