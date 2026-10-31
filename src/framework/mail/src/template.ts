/**
 * Typed templates (`MAIL-3`, `MAIL-4`).
 *
 * A template is a name, a subject function, and one or two body functions over the same typed
 * data. Three properties are deliberate:
 *
 *   · **The data is a type parameter.** `sendTemplate('welcome', { name })` does not compile when
 *     the template wants `{ firstName }`, which is the failure mode a plain object map makes
 *     impossible to see until a customer receives `Hi undefined`.
 *   · **HTML comes from `html` or `raw`.** A template's `html` function returns `SafeHtml`, so the
 *     escaping boundary is the type system's job rather than a reviewer's.
 *   · **`sample` is data, not a fixture file.** `tsir mail:preview welcome` renders the sample, so a
 *     template is loadable without a database, a customer or a terminal full of JSON.
 */

import { html as htmlTag, type SafeHtml } from './escape.ts';
import { unknownTemplate } from './errors.ts';

export interface MailTemplate<Data = Record<string, unknown>> {
  readonly name: string;
  readonly subject: (data: Data) => string;
  /** The plain-text alternative. Required: an HTML-only mail is unreadable in a text client. */
  readonly text: (data: Data) => string;
  readonly html?: ((data: Data) => SafeHtml) | undefined;
  /** Realistic data for `tsir mail:preview`; never used to send. */
  readonly sample?: Data | undefined;
}

/** Identity, for inference: `defineTemplate<{ name: string }>({ … })`. */
export function defineTemplate<Data>(template: MailTemplate<Data>): MailTemplate<Data> {
  return template;
}

export interface RenderedTemplate {
  readonly name: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string | undefined;
}

export interface Templates {
  readonly names: readonly string[];
  /** The template by name, or `MAIL_UNKNOWN_TEMPLATE` listing the ones that exist. */
  get(name: string): MailTemplate<never>;
  has(name: string): boolean;
  render(name: string, data?: unknown): RenderedTemplate;
}

/**
 * A registry.
 *
 * `Data = never` in the public `get` is what makes an untyped lookup safe: the registry can be
 * asked for a template it only knows by string, and the caller gets a function it must pass data
 * to — the type is checked where the template was declared, not where it was looked up.
 */
export function createTemplates(
  declared: Readonly<Record<string, MailTemplate<never>>> = {},
): Templates {
  const entries: [string, MailTemplate<never>][] = Object.entries(declared);
  const byName = new Map<string, MailTemplate<never>>();

  for (const [key, template] of entries) {
    // The key and the template's own name are two places to keep one fact true, so they are
    // checked against each other rather than one being silently preferred.
    if (template.name !== key) {
      throw new TypeError(
        `template "${key}" is registered under the wrong name ("${template.name}") — the key and \`name\` must agree`,
      );
    }
    if (byName.has(template.name)) {
      throw new TypeError(`two mail templates are named "${template.name}"`);
    }
    byName.set(template.name, template);
  }

  const names = [...byName.keys()];

  const get = (name: string): MailTemplate<never> => {
    const template = byName.get(name);
    if (template === undefined) throw unknownTemplate(name, names);
    return template;
  };

  return {
    names,
    get,
    has: (name) => byName.has(name),
    render: (name, data) => {
      const template = get(name);
      const payload = (data ?? template.sample) as never;
      if (payload === undefined) {
        throw new TypeError(
          `template "${name}" has no \`sample\`, so it cannot be rendered without data`,
        );
      }

      const subject = template.subject(payload);
      const text = template.text(payload);
      // The two checks that cannot be types: a subject with a newline is a header injection, and a
      // template that returns an empty body is a blank email nobody notices they sent.
      if (subject.trim() === '') {
        throw new TypeError(`template "${name}" rendered an empty subject`);
      }
      if (/[\r\n]/u.test(subject)) {
        throw new TypeError(`template "${name}" rendered a subject with a newline`);
      }
      if (text.trim() === '') {
        throw new TypeError(`template "${name}" rendered an empty text body`);
      }

      return {
        name,
        subject,
        text,
        ...(template.html === undefined ? {} : { html: template.html(payload) }),
      };
    },
  };
}

/** Re-exported so a template module needs one import, not two. */
export { htmlTag as html };
