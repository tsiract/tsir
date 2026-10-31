/**
 * Addresses, and the one thing this module exists to prevent.
 *
 * An email address reaches a mail package from a form, a CSV or a database, and then it becomes a
 * **header**. `"Ana\r\nBcc: everyone@example.com <ana@example.com>"` is a valid-looking string that
 * adds a recipient — the classic header injection. So every address is parsed and checked here,
 * once, and a control character anywhere in it is a refusal with a code. A transport never sees a
 * string it has to sanitise, because it never sees one that was not parsed.
 *
 * The grammar accepted is deliberately smaller than RFC 5322's: `local@domain` or
 * `Name <local@domain>`. Quoted local parts (`"a b"@x.com`) and comments (`a@x.com (work)`) are
 * refused rather than guessed at — a mail package that half-parses a grammar is one that delivers
 * to the wrong person occasionally, and "occasionally" is the worst possible rate.
 */

import { invalidAddress } from './errors.ts';
import type { AddressInput, MailAddress } from './port.ts';

/** Local parts are at most 64 octets and domains 255 (RFC 5321 § 4.5.3.1). */
const MAX_LOCAL = 64;
const MAX_DOMAIN = 255;
const MAX_NAME = 200;

/** RFC 5322 `atext`, plus the dot the local part may use between atoms. */
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/u;
/** A bracketed address literal — `[10.0.0.1]`, `[::1]`, `[IPv6:::1]` — which is not a domain. */
const LITERAL = /^\[(?:IPv6:)?[0-9A-Fa-f:.]+\]$/u;

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function checkEmail(email: string, input: string): string {
  // The first check is the one that matters: a newline is a header, not part of an address.
  if (hasControl(email))
    throw invalidAddress(input, 'control characters (a newline starts a second header)');
  // Checked before the whitespace rule so `"ana smith"@example.com` gets the reason that names the
  // real problem: this package does not parse quoted local parts, and half-parsing one is how a
  // message is delivered to the wrong mailbox occasionally.
  if (email.includes('"')) throw invalidAddress(input, 'a quoted local part is not supported');
  if (/\s/u.test(email)) throw invalidAddress(input, 'whitespace inside an address');

  const at = email.indexOf('@');
  if (at < 0) throw invalidAddress(input, 'no `@`');
  if (at !== email.lastIndexOf('@')) throw invalidAddress(input, 'more than one `@`');

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (local === '') throw invalidAddress(input, 'nothing before the `@`');
  if (local.length > MAX_LOCAL)
    throw invalidAddress(input, `the local part is longer than ${String(MAX_LOCAL)} characters`);
  if (!LOCAL.test(local)) {
    throw invalidAddress(
      input,
      'the local part has a character an address cannot carry (a quoted local part is not supported)',
    );
  }

  if (domain === '') throw invalidAddress(input, 'nothing after the `@`');
  if (domain.length > MAX_DOMAIN)
    throw invalidAddress(input, `the domain is longer than ${String(MAX_DOMAIN)} characters`);
  if (!LITERAL.test(domain)) {
    if (domain.includes('..')) throw invalidAddress(input, 'an empty domain label (`..`)');
    for (const label of domain.split('.')) {
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)) {
        throw invalidAddress(input, `"${label}" is not a domain label`);
      }
    }
  }

  return email;
}

function checkName(name: string, input: string): string {
  if (hasControl(name)) throw invalidAddress(input, 'control characters in the display name');
  if (name.length > MAX_NAME)
    throw invalidAddress(input, `the display name is longer than ${String(MAX_NAME)} characters`);
  return name;
}

/** Strip one layer of `"…"` and un-escape what the quoting escaped. */
function unquote(name: string): string {
  if (!(name.startsWith('"') && name.endsWith('"')) || name.length < 2) return name;
  return name.slice(1, -1).replace(/\\(.)/gu, '$1');
}

/**
 * One address, from either spelling.
 *
 * The angle-bracket form is parsed from the **last** `<`, so a display name containing one
 * (`"Ana <billing>" <billing@example.com>`) still yields the right address.
 */
export function parseAddress(input: AddressInput): MailAddress {
  if (typeof input !== 'string') {
    const email = checkEmail(input.email.trim(), input.email);
    return input.name === undefined
      ? { email }
      : { email, name: checkName(input.name.trim(), input.name) };
  }

  const text = input.trim();
  if (text === '') throw invalidAddress(input, 'it is empty');
  if (hasControl(text))
    throw invalidAddress(input, 'control characters (a newline starts a second header)');

  const open = text.lastIndexOf('<');
  const close = text.lastIndexOf('>');
  if (open === -1 && close === -1) {
    return { email: checkEmail(text, input) };
  }
  if (open === -1 || close === -1 || close < open) {
    throw invalidAddress(input, 'an unbalanced `<` or `>`');
  }
  if (text.slice(close + 1).trim() !== '') {
    throw invalidAddress(input, 'characters after the closing `>`');
  }

  const email = checkEmail(text.slice(open + 1, close).trim(), input);
  const name = unquote(text.slice(0, open).trim());
  return name === '' ? { email } : { email, name: checkName(name, input) };
}

export function parseAddresses(input: readonly AddressInput[] | undefined): MailAddress[] {
  return (input ?? []).map((address) => parseAddress(address));
}

/**
 * A comma-separated list, as a CLI flag or a `to:` header writes it.
 *
 * Split outside quotes and angle brackets, because `"Doe, Jane" <jane@example.com>` is one
 * address with a comma in a display name — and splitting it naively is how a mail is delivered to
 * `Jane" <jane@example.com>` and nobody notices until a bounce.
 */
export function splitAddressList(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angles = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (character === '"') quoted = !quoted;
    if (!quoted && character === '<') angles += 1;
    if (!quoted && character === '>') angles = Math.max(0, angles - 1);
    if (character === ',' && !quoted && angles === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** Every address on a message, lower-cased, for the duplicate check. */
export function recipientKeys(addresses: readonly MailAddress[]): string[] {
  return addresses.map((address) => address.email.toLowerCase());
}
