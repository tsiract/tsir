/**
 * The escaping boundary (`MAIL-4`).
 *
 * A mail template interpolates user data into HTML, which is the same problem as a view and gets
 * the same answer: **escaping is the default and not escaping is a visible act.** The `html` tag
 * escapes every interpolation it is given, and the only way to put markup in is `raw()`, which is
 * one grep away in review.
 *
 * ```ts
 * const Welcome = defineTemplate({
 *   html: (data) => html`<p>Hi ${data.name}</p>`,   // escaped
 *   text: (data) => `Hi ${data.name}`,
 * });
 * ```
 *
 * A plain string is *not* accepted as an HTML body by a template — it has to come from the `html`
 * tag or from `raw()`, so a template cannot accidentally interpolate an unescaped value by writing
 * a normal template literal.
 */

declare const safe: unique symbol;

/** A string that is known to be valid HTML produced by this package. */
export type SafeHtml = string & { readonly [safe]: true };

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** The five characters that end an attribute or a tag. Nothing else needs escaping in HTML text. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ESCAPES[character] ?? character);
}

export function isSafeHtml(value: unknown): value is SafeHtml {
  return typeof value === 'string' && SAFE.has(value);
}

/**
 * The brand registry.
 *
 * A `unique symbol` brand cannot be forged in TypeScript, but it *can* be cast — and a cast is
 * exactly what a review should see. Keeping the produced strings in a `WeakSet`-like set would
 * leak; a `Set` of strings is unbounded and pointless. So the brand is type-level only, and this
 * function exists to make the runtime check cheap and honest rather than pretend to be airtight.
 */
const SAFE = new Set<string>();

/** Mark a string as HTML that is already correct. The one place escaping is waived. */
export function raw(html: string): SafeHtml {
  const value = html as SafeHtml;
  SAFE.add(value);
  return value;
}

/**
 * The escaping template tag.
 *
 * Interpolations are escaped unless they are already `SafeHtml`; arrays are joined with nothing so
 * a `.map()` over a list composes; `null` and `undefined` render as nothing, because a missing
 * value should not print "undefined" into an email.
 */
export function html(strings: TemplateStringsArray, ...values: readonly unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let index = 0; index < values.length; index += 1) {
    out += renderValue(values[index]);
    out += strings[index + 1] ?? '';
  }
  return raw(out);
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (isSafeHtml(value)) return value;
  if (Array.isArray(value)) return value.map((item) => renderValue(item)).join('');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return escapeHtml(value);
  // An object in an email body is a bug in the template, and `[object Object]` in a customer's
  // inbox is the worst possible way to find out. A date is the one exception worth having.
  if (value instanceof Date) return escapeHtml(value.toISOString());
  throw new TypeError(
    `html\`…\` interpolated a ${typeof value} — pass a string, a number, an array, a Date, or wrap markup in raw()`,
  );
}
