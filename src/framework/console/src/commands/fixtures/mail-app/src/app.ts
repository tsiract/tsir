// The mail fixture's entry. It exports `templates` — the one thing `tsir.js` cannot describe, since
// a template is code — and nothing else: the mailers come from `mail.mailers` in the config, which
// is the path a project without a custom transport takes.
import { defineConfig } from '@tsir/config';
import { defineApp } from '@tsir/core';
import { defineTemplate, html } from '@tsir/mail';

export const spec = defineConfig({});

export default defineApp({
  name: 'mail-app',
  config: spec,
  modules: [],
});

interface Welcome {
  readonly name: string;
  readonly link: string;
}

export const welcome = defineTemplate<Welcome>({
  name: 'welcome',
  subject: (data) => `Welcome, ${data.name}`,
  text: (data) => `Hi ${data.name}, confirm your address: ${data.link}`,
  html: (data) =>
    html`<p>Hi ${data.name},</p>
      <p><a href="${data.link}">Confirm your address</a></p>`,
  sample: { name: 'Ana', link: 'https://tsir.local/confirm/abc123' },
});

export const receipt = defineTemplate<{ readonly total: string }>({
  name: 'receipt',
  subject: (data) => `Your receipt: ${data.total}`,
  text: (data) => `You were charged ${data.total}.`,
  sample: { total: '₱1,250.00' },
});

export const templates = { welcome, receipt };
