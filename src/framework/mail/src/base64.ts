/**
 * Base64, by hand.
 *
 * `Buffer` is a Node global and `btoa` takes a *binary string* — so both work on the runtimes this
 * package targets and neither is honest about it: `Buffer` disappears from a Workers bundle, and
 * `btoa` silently refuses (or mangles) anything above `0xFF`, which the obvious
 * `String.fromCharCode(...bytes)` wrapper turns into a stack overflow on a 40 KB attachment.
 *
 * Attachments are the one place a mail package handles a large binary and hands it to a text
 * protocol, so it is worth twenty lines to have no argument with the runtime.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  let index = 0;

  // Three bytes at a time, four characters out: the only alignment that needs no lookahead.
  for (; index + 2 < bytes.length; index += 3) {
    const chunk =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    out +=
      (ALPHABET[(chunk >> 18) & 63] ?? '') +
      (ALPHABET[(chunk >> 12) & 63] ?? '') +
      (ALPHABET[(chunk >> 6) & 63] ?? '') +
      (ALPHABET[chunk & 63] ?? '');
  }

  const remaining = bytes.length - index;
  if (remaining === 1) {
    const chunk = (bytes[index] ?? 0) << 16;
    out += (ALPHABET[(chunk >> 18) & 63] ?? '') + (ALPHABET[(chunk >> 12) & 63] ?? '') + '==';
  } else if (remaining === 2) {
    const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    out +=
      (ALPHABET[(chunk >> 18) & 63] ?? '') +
      (ALPHABET[(chunk >> 12) & 63] ?? '') +
      (ALPHABET[(chunk >> 6) & 63] ?? '') +
      '=';
  }

  return out;
}

/**
 * Base64 wrapped at `width` columns (76 for MIME, `RFC 2045 § 6.8`).
 *
 * Wrapped output is what goes into a message body. The unwrapped form is what a JSON API wants
 * (`resend` and `postmark` both take a bare base64 string), which is why the wrap is a caller's
 * choice and not a property of the encoder.
 */
export function encodeBase64Lines(bytes: Uint8Array, width = 76): string {
  const encoded = encodeBase64(bytes);
  if (width <= 0) return encoded;
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += width) {
    lines.push(encoded.slice(index, index + width));
  }
  return lines.join('\r\n');
}
