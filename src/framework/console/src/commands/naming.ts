/**
 * Name helpers shared by the generators (`make:*`).
 *
 * `SendReceipt` becomes `send-receipt`, which is the stem of the file and the default name of the
 * job or listener. Only ASCII letters and digits are accepted, so the stem is always a valid
 * module path and a valid job name.
 */

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/;

/** `OrderPlaced` → `order-placed`; `blog_post` → `blog-post`. */
export function toKebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

/** True when the value is a PascalCase-able identifier (letters and digits, starting with a letter). */
export function isIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}
