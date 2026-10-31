/**
 * Composing a message (`MAIL-2`) and the escaping boundary (`MAIL-3`, `MAIL-4`).
 *
 * Everything here is a refusal that would otherwise become a sent message: two copies to one
 * person, a subject that smuggles a header, an attachment whose name is a path, HTML built by
 * string concatenation with a customer's name in it.
 */

import { describe, expect, test } from 'bun:test';

import { escapeHtml, html, isSafeHtml, raw } from './escape.ts';
import { createMessage, recipientsOf, withSender } from './message.ts';
import { createTemplates, defineTemplate } from './template.ts';

const base = { from: 'Tsir <no-reply@tsir.local>', to: ['ana@example.com'], subject: 'Hi' };

describe('a message that would send nothing', () => {
  test('no recipients is a refusal, not a silent no-op', () => {
    expect(() => createMessage({ ...base, to: [], text: 'x' })).toThrow(/there are no recipients/u);
  });

  test('neither body is a refusal: a text alternative is the one everyone can read', () => {
    expect(() => createMessage(base)).toThrow(/neither a text nor an HTML body/u);
  });

  test('an empty subject is a refusal, because it is always a lost variable', () => {
    expect(() => createMessage({ ...base, subject: '  ', text: 'x' })).toThrow(/subject is empty/u);
  });

  test('a missing sender is a refusal with the fix in the hint', () => {
    expect(() => createMessage({ to: ['ana@example.com'], subject: 'Hi', text: 'x' })).toThrow(
      /no sender/u,
    );
  });
});

describe('the same person twice', () => {
  test('a duplicate inside one list names the list', () => {
    expect(() =>
      createMessage({ ...base, to: ['ana@example.com', 'ANA@example.com'], text: 'x' }),
    ).toThrow(/appears twice in "to"/u);
  });

  test('the same address in `to` and `cc` is refused, and the message names both', () => {
    expect(() => createMessage({ ...base, cc: ['ana@example.com'], text: 'x' })).toThrow(
      /appears in both "to" and "cc"/u,
    );
  });
});

describe("headers are the package's, not the caller's", () => {
  test('a reserved header is refused rather than silently overwritten', () => {
    for (const name of ['To', 'subject', 'Message-ID', 'Content-Type', 'Bcc']) {
      expect(() => createMessage({ ...base, text: 'x', headers: { [name]: 'x' } })).toThrow(
        /written by the mail package/u,
      );
    }
  });

  test('a header value with a newline is the injection this package exists to stop', () => {
    expect(() =>
      createMessage({ ...base, text: 'x', headers: { 'X-Trace': 'a\r\nBcc: evil@example.com' } }),
    ).toThrow(/control character/u);
  });

  test('a header name that is not a token is refused', () => {
    expect(() => createMessage({ ...base, text: 'x', headers: { 'X Trace': 'a' } })).toThrow(
      /is not \[A-Za-z0-9-\]/u,
    );
  });

  test('a legitimate custom header survives, and the subject may not span two lines', () => {
    expect(
      createMessage({ ...base, text: 'x', headers: { 'X-Campaign': 'spring' } }).headers,
    ).toEqual({ 'X-Campaign': 'spring' });
    expect(() => createMessage({ ...base, subject: 'one\ntwo', text: 'x' })).toThrow(
      /more than one line/u,
    );
  });
});

describe('attachments are files, not paths', () => {
  test('a path separator or a control character in the name is refused', () => {
    for (const filename of ['../report.pdf', 'a/b.pdf', 'a\\b.pdf', 'a\u0000b.pdf']) {
      expect(() =>
        createMessage({
          ...base,
          text: 'x',
          attachments: [{ filename, content: new Uint8Array([1]) }],
        }),
      ).toThrow(/path separator or control character/u);
    }
  });

  test('a zero-byte attachment is refused: it is always a bug upstream', () => {
    expect(() =>
      createMessage({
        ...base,
        text: 'x',
        attachments: [{ filename: 'a.pdf', content: new Uint8Array() }],
      }),
    ).toThrow(/is empty/u);
  });

  test('a `contentId` only means something on an inline part', () => {
    expect(() =>
      createMessage({
        ...base,
        text: 'x',
        attachments: [{ filename: 'logo.png', content: new Uint8Array([1]), contentId: 'logo' }],
      }),
    ).toThrow(/is not inline/u);
  });
});

describe('the escaping boundary', () => {
  test('the `html` tag escapes every interpolation', () => {
    const rendered = html`<p>Hi ${'<script>alert(1)</script>'}</p>`;
    expect(String(rendered)).toBe('<p>Hi &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(isSafeHtml(rendered)).toBe(true);
  });

  test('a nested safe value is not escaped twice, and an array composes', () => {
    const name = html`<b>Ana</b>`;
    expect(String(html`<p>${name}</p>`)).toBe('<p><b>Ana</b></p>');
    // A `.map()` over a list is the ordinary way to build a body, so an array has to compose.
    // (Prettier formats an `html` template as HTML, so the indentation around the hole is real
    // text — this asserts the items are spliced in unescaped and in order, not the whitespace.)
    const items = [html`<li>a</li>`, html`<li>b</li>`];
    const list = html`<ul>
      ${items}
    </ul>`;
    const rendered = String(list);
    expect(rendered.startsWith('<ul>')).toBe(true);
    expect(rendered).toContain('<li>a</li><li>b</li>');
    expect(rendered).not.toContain('&lt;');
  });

  test('null and undefined render as nothing, not as the word "undefined"', () => {
    expect(String(html`<p>${null}${undefined}</p>`)).toBe('<p></p>');
  });

  test('only `raw` waives escaping, and it is a distinct act', () => {
    expect(String(html`${raw('<hr>')}`)).toBe('<hr>');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('templates', () => {
  const Welcome = defineTemplate<{ name: string }>({
    name: 'welcome',
    subject: (data) => `Welcome, ${data.name}`,
    text: (data) => `Hi ${data.name}`,
    html: (data) => html`<p>Hi ${data.name}</p>`,
    sample: { name: 'Ana' },
  });

  test('render uses the sample when no data is given, and escapes the HTML', () => {
    const templates = createTemplates({ welcome: Welcome as never });
    const rendered = templates.render('welcome');
    expect(rendered).toEqual({
      name: 'welcome',
      subject: 'Welcome, Ana',
      text: 'Hi Ana',
      html: '<p>Hi Ana</p>',
    });
    expect(templates.render('welcome', { name: '<b>' }).html).toBe('<p>Hi &lt;b&gt;</p>');
  });

  test('an unknown template lists the ones that exist', () => {
    const templates = createTemplates({ welcome: Welcome as never });
    expect(() => templates.render('wlecome', { name: 'A' })).toThrow(
      /unknown mail template "wlecome" \(registered: welcome\)/u,
    );
    expect(() => createTemplates({}).render('anything')).toThrow(
      /no mail templates are registered/u,
    );
  });

  test('registering under a different key than `name` is a declaration error', () => {
    expect(() => createTemplates({ other: Welcome as never })).toThrow(
      /registered under the wrong name/u,
    );
  });

  test('a template that renders an empty subject or body is refused at render time', () => {
    const templates = createTemplates({
      empty: defineTemplate<Record<string, never>>({
        name: 'empty',
        subject: () => '',
        text: () => 'x',
        sample: {},
      }) as never,
      blank: defineTemplate<Record<string, never>>({
        name: 'blank',
        subject: () => 'Hi',
        text: () => '  ',
        sample: {},
      }) as never,
    });
    expect(() => templates.render('empty')).toThrow(/empty subject/u);
    expect(() => templates.render('blank')).toThrow(/empty text body/u);
  });
});

describe('composition helpers', () => {
  test('recipientsOf is the envelope order: to, then cc, then bcc', () => {
    const message = createMessage({
      ...base,
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      text: 'x',
    });
    expect(recipientsOf(message).map((address) => address.email)).toEqual([
      'ana@example.com',
      'cc@example.com',
      'bcc@example.com',
    ]);
  });

  test('withSender replaces the sender and keeps everything else', () => {
    const message = createMessage({ ...base, text: 'x' });
    const other = withSender(message, 'Billing <billing@tsir.local>');
    expect(other.from).toEqual({ email: 'billing@tsir.local', name: 'Billing' });
    expect(other.subject).toBe('Hi');
    expect(other.to).toEqual(message.to);
  });

  test('a composed message is frozen', () => {
    const message = createMessage({ ...base, text: 'x' });
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.to)).toBe(true);
  });
});
