/**
 * SendGrid's two shape traps, and the id that is a header.
 *
 * Every other transport here reads its message id out of a JSON body. SendGrid answers `202` with
 * an empty body and puts the id in `X-Message-Id`, so the interesting failures are: a client that
 * reads `body` and gets nothing, and a `content` array in the wrong order, which silently changes
 * how the message renders rather than throwing.
 */

import { describe, expect, test } from 'bun:test';

import type { MailMessage } from '../port.ts';
import { sendgridTransport } from './sendgrid.ts';

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function fakeFetch(reply: { status: number; headers?: Record<string, string>; body?: string }): {
  fetch: typeof fetch;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const impl = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body:
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    });
    return new Response(reply.body ?? '', {
      status: reply.status,
      headers: reply.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, sent };
}

const message: MailMessage = {
  from: { email: 'no-reply@shop.test', name: 'Shop' },
  to: [{ email: 'ada@example.com', name: 'Ada' }],
  subject: 'Your receipt',
  text: 'Thanks',
  html: '<p>Thanks</p>',
};

describe('sendgrid · the v3 send shape', () => {
  test('plain text precedes html in `content`, because that is the fallback order', async () => {
    const { fetch, sent } = fakeFetch({
      status: 202,
      headers: { 'x-message-id': 'msg_1' },
    });
    const transport = sendgridTransport({ apiKey: 'SG.key', fetch });

    await transport.send(message);

    expect(sent[0]?.url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(sent[0]?.headers['authorization']).toBe('Bearer SG.key');
    expect(sent[0]?.body['content']).toEqual([
      { type: 'text/plain', value: 'Thanks' },
      { type: 'text/html', value: '<p>Thanks</p>' },
    ]);
  });

  test('recipients live inside one personalization', async () => {
    const { fetch, sent } = fakeFetch({ status: 202, headers: { 'x-message-id': 'm' } });
    await sendgridTransport({ apiKey: 'k', fetch }).send({
      ...message,
      cc: [{ email: 'cc@example.com' }],
    });

    const personalizations = sent[0]?.body['personalizations'] as Record<string, unknown>[];
    expect(personalizations[0]?.['to']).toEqual([{ email: 'ada@example.com', name: 'Ada' }]);
    expect(personalizations[0]?.['cc']).toEqual([{ email: 'cc@example.com' }]);
    expect(sent[0]?.body['from']).toEqual({ email: 'no-reply@shop.test', name: 'Shop' });
  });

  test('the id comes from X-Message-Id, because the 202 body is empty', async () => {
    const { fetch } = fakeFetch({ status: 202, headers: { 'X-Message-Id': 'msg_abc' } });
    const result = await sendgridTransport({ apiKey: 'k', fetch }).send(message);
    expect(result.id).toBe('msg_abc');
    expect(result.accepted).toEqual(['ada@example.com']);
  });

  test('a 202 with no id is reported, not returned as an untracked success', async () => {
    // The message may well have been sent; the caller cannot track or correlate it. Saying so is
    // better than handing back an empty id that a webhook join will silently never match.
    const { fetch } = fakeFetch({ status: 202 });
    let thrown: unknown;
    try {
      await sendgridTransport({ apiKey: 'k', fetch }).send(message);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(String(thrown)).toMatch(/no X-Message-Id/u);
  });

  test('attachments are base64 with inline disposition when they carry a content id', async () => {
    const { fetch, sent } = fakeFetch({ status: 202, headers: { 'x-message-id': 'm' } });
    await sendgridTransport({ apiKey: 'k', fetch }).send({
      ...message,
      attachments: [
        {
          filename: 'logo.png',
          content: new Uint8Array([1, 2, 3]),
          contentType: 'image/png',
          contentId: 'logo',
        },
      ],
    });

    const attachments = sent[0]?.body['attachments'] as Record<string, unknown>[];
    expect(attachments[0]).toMatchObject({
      filename: 'logo.png',
      type: 'image/png',
      disposition: 'inline',
      content_id: 'logo',
    });
  });

  test('tags become categories, and are capped the way SendGrid caps them', async () => {
    const { fetch, sent } = fakeFetch({ status: 202, headers: { 'x-message-id': 'm' } });
    const tags = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`tag${String(i)}`, 'v']));
    await sendgridTransport({ apiKey: 'k', fetch }).send({ ...message, tags });
    expect((sent[0]?.body['categories'] as string[]).length).toBe(10);
  });

  test('a non-2xx is a coded failure that does not leak the key', async () => {
    const { fetch } = fakeFetch({
      status: 401,
      body: JSON.stringify({ errors: [{ message: 'invalid key' }] }),
    });
    let thrown: unknown;
    try {
      await sendgridTransport({ apiKey: 'SG.super-secret', fetch }).send(message);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(String(thrown)).toContain('401');
    expect(String(thrown)).not.toContain('SG.super-secret');
  });

  test('an EU regional account points baseUrl at api.eu.sendgrid.com', async () => {
    const { fetch, sent } = fakeFetch({ status: 202, headers: { 'x-message-id': 'm' } });
    await sendgridTransport({
      apiKey: 'k',
      baseUrl: 'https://api.eu.sendgrid.com',
      fetch,
    }).send(message);
    expect(sent[0]?.url).toBe('https://api.eu.sendgrid.com/v3/mail/send');
  });
});
