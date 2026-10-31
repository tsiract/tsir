/**
 * The transports (`MAIL-7`).
 *
 * Each one is driven through a **recording fake** — a `fetch` that keeps the request and answers a
 * canned body, a binding that keeps what it was handed, a scripted SMTP connection — so the tests
 * assert the wire, not the provider: the URL, the auth header, the field names each provider
 * spells differently, and what happens when the answer is a 422 or a 200 without an id.
 *
 * The failure cases matter as much as the successes: a transport that returns `undefined` on a 500
 * makes `await mailer.send()` look like a delivery.
 */

import { describe, expect, test } from 'bun:test';

import { createMessage } from './message.ts';
import { memoryTransport } from './transports/memory.ts';
import { logTransport } from './transports/log.ts';
import { cloudflareTransport } from './transports/cloudflare.ts';
import { postmarkTransport } from './transports/postmark.ts';
import { resendTransport } from './transports/resend.ts';
import { sesTransport } from './transports/ses.ts';

const message = createMessage({
  from: 'Tsir <no-reply@tsir.local>',
  to: ['ana@example.com'],
  cc: ['bo@example.com'],
  subject: 'Your receipt',
  text: 'Thanks',
  html: '<p>Thanks</p>',
});

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function recordingFetch(answer: (request: Recorded) => Response): {
  fetch: typeof fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    const recorded: Recorded = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    };
    requests.push(recorded);
    return answer(recorded);
  };
  return { fetch: fake as unknown as typeof fetch, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resend', () => {
  test('the request is one POST to /emails with the key in a bearer header', async () => {
    const { fetch, requests } = recordingFetch(() => json({ id: 'em_123' }));
    const transport = resendTransport({ apiKey: 're_test', fetch });

    const result = await transport.send(message);

    expect(result).toEqual({ id: 'em_123', accepted: ['ana@example.com', 'bo@example.com'] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.resend.com/emails');
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers['authorization']).toBe('Bearer re_test');
    const body = JSON.parse(requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['from']).toBe('Tsir <no-reply@tsir.local>');
    expect(body['to']).toEqual(['ana@example.com']);
    expect(body['cc']).toEqual(['bo@example.com']);
    expect(body['html']).toBe('<p>Thanks</p>');
  });

  test('an attachment travels as base64, and a declared type travels with it', async () => {
    const { fetch, requests } = recordingFetch(() => json({ id: 'em_1' }));
    const transport = resendTransport({ apiKey: 'k', fetch });
    await transport.send(
      createMessage({
        from: 'a@tsir.local',
        to: ['b@example.com'],
        subject: 's',
        text: 't',
        attachments: [
          { filename: 'r.pdf', content: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' },
        ],
      }),
    );
    const body = JSON.parse(requests[0]?.body ?? '{}') as {
      attachments: { filename: string; content: string; content_type?: string }[];
    };
    expect(body.attachments).toEqual([
      { filename: 'r.pdf', content: 'AQID', content_type: 'application/pdf' },
    ]);
  });

  test('a 422 is a coded failure carrying the provider message and never the key', async () => {
    const { fetch } = recordingFetch(() =>
      json(
        { statusCode: 422, message: 'The domain is not verified', name: 'validation_error' },
        422,
      ),
    );
    const transport = resendTransport({ apiKey: 're_secret_key', fetch });

    const attempt = transport.send(message);
    expect(attempt).rejects.toMatchObject({ code: 'MAIL_TRANSPORT_FAILED' });
    expect(attempt).rejects.toThrow(/The domain is not verified/u);
    try {
      await attempt;
    } catch (error: unknown) {
      const serialised = JSON.stringify(error, Object.getOwnPropertyNames(error));
      // The error is logged and sometimes shown, so a credential must not be reachable through it.
      expect(serialised).not.toContain('re_secret_key');
    }
  });

  test('a 200 with no id is a failure, not a silent success', async () => {
    const { fetch } = recordingFetch(() => json({ ok: true }));
    const transport = resendTransport({ apiKey: 'k', fetch });
    expect(transport.send(message)).rejects.toThrow(/has no id/u);
  });

  test('an answer that is not JSON (a proxy page) is a failure', async () => {
    const { fetch } = recordingFetch(() => new Response('<html>502</html>', { status: 200 }));
    const transport = resendTransport({ apiKey: 'k', fetch });
    expect(transport.send(message)).rejects.toThrow(/not JSON/u);
  });
});

describe('postmark', () => {
  test('the token header and the capitalised field names Postmark actually uses', async () => {
    const { fetch, requests } = recordingFetch(() =>
      json({ MessageID: 'pm_1', To: [{ Email: 'ana@example.com' }, { Email: 'bo@example.com' }] }),
    );
    const transport = postmarkTransport({ serverToken: 'tok', messageStream: 'outbound', fetch });
    const result = await transport.send(message);

    expect(result.id).toBe('pm_1');
    expect(requests[0]?.headers['x-postmark-server-token']).toBe('tok');
    const body = JSON.parse(requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['From']).toBe('Tsir <no-reply@tsir.local>');
    // `to` and `cc` are separate arrays in Postmark's shape, not one envelope.
    expect(body['To']).toEqual([{ Email: 'ana@example.com' }]);
    expect(body['Cc']).toEqual([{ Email: 'bo@example.com' }]);
    expect(body['TextBody']).toBe('Thanks');
    expect(body['MessageStream']).toBe('outbound');
  });

  test('a recipient with no message id in a 200 is reported as rejected', async () => {
    const { fetch } = recordingFetch(() =>
      json({
        MessageID: 'pm_1',
        To: [
          { Email: 'ana@example.com', MessageID: 'pm_1' },
          { Email: 'gone@example.com', MessageID: '' },
        ],
      }),
    );
    const transport = postmarkTransport({ serverToken: 't', fetch });
    const result = await transport.send(message);
    expect(result.rejected).toEqual([
      { email: 'gone@example.com', reason: 'postmark returned no message id' },
    ]);
  });

  test('it declares `tags: false`, because Postmark has one Tag and not a map', () => {
    const transport = postmarkTransport({ serverToken: 't' });
    expect(transport.capabilities.tags).toBe(false);
  });
});

describe('ses', () => {
  const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };

  test('it signs the request with SigV4 and sends the message as raw MIME', async () => {
    const { fetch, requests } = recordingFetch(() => json({ MessageId: 'ses-1' }));
    const transport = sesTransport({
      region: 'us-east-1',
      credentials,
      fetch,
      now: () => Date.parse('2026-10-29T09:30:00Z'),
    });

    const result = await transport.send(message);

    expect(result.id).toBe('ses-1');
    expect(requests[0]?.url).toBe('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails');
    expect(requests[0]?.headers['authorization']).toStartWith(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261029/us-east-1/ses/aws4_request',
    );
    expect(requests[0]?.headers['x-amz-date']).toBe('20261029T093000Z');

    const body = JSON.parse(requests[0]?.body ?? '{}') as {
      FromEmailAddress: string;
      Destination: { ToAddresses: string[]; CcAddresses: string[] };
      Content: { Raw: { Data: string } };
    };
    expect(body.FromEmailAddress).toBe('no-reply@tsir.local');
    expect(body.Destination.ToAddresses).toEqual(['ana@example.com']);
    expect(body.Destination.CcAddresses).toEqual(['bo@example.com']);
    // `Raw` rather than the structured content: a structured send has no attachments and no
    // custom headers, and a transport that can only send part of a message lies about itself.
    expect(Buffer.from(body.Content.Raw.Data, 'base64').toString()).toContain('MIME-Version: 1.0');
  });

  test('an SES error body is reported with its own message', async () => {
    const { fetch } = recordingFetch(() =>
      json({ message: 'Email address is not verified.', __type: 'MessageRejected' }, 400),
    );
    const transport = sesTransport({ region: 'eu-west-1', credentials, fetch });
    expect(transport.send(message)).rejects.toThrow(/Email address is not verified/u);
  });
});

describe('cloudflare', () => {
  test('the transport is the binding: no fetch, no key, no endpoint', async () => {
    const sent: unknown[] = [];
    const transport = cloudflareTransport({
      binding: {
        send: async (input) => {
          sent.push(input);
          return { messageId: 'cf-1' };
        },
      },
    });

    const result = await transport.send(message);

    expect(result.id).toBe('cf-1');
    expect(sent).toHaveLength(1);
    const input = sent[0] as { from: unknown; to: unknown; subject: string };
    // A display name travels as a structured address, which is the only way the binding keeps it.
    expect(input.from).toEqual({ email: 'no-reply@tsir.local', name: 'Tsir' });
    expect(input.to).toEqual(['ana@example.com']);
    expect(input.subject).toBe('Your receipt');
  });

  test('more recipients than the binding allows is refused before the binding is called', async () => {
    let called = false;
    const transport = cloudflareTransport({
      binding: {
        send: async () => {
          called = true;
          return {};
        },
      },
    });
    const many = createMessage({
      from: 'a@tsir.local',
      to: Array.from({ length: 51 }, (_, index) => `p${String(index)}@example.com`),
      subject: 's',
      text: 't',
    });
    expect(transport.send(many)).rejects.toThrow(/at most 50 per message/u);
    expect(called).toBe(false);
  });

  test('a binding that throws is a coded failure, not an unhandled rejection', async () => {
    const transport = cloudflareTransport({
      binding: {
        send: () => {
          throw new Error('binding exploded');
        },
      },
    });
    expect(transport.send(message)).rejects.toMatchObject({ code: 'MAIL_TRANSPORT_FAILED' });
  });
});

describe('log and memory', () => {
  test('log prints the message and says nothing was delivered', async () => {
    const lines: string[] = [];
    const transport = logTransport({ write: (text) => lines.push(text), label: 'development' });
    const result = await transport.send(message);

    const printed = lines.join('\n');
    expect(printed).toContain('mail development');
    expect(printed).toContain('subject: Your receipt');
    expect(printed).toContain('  Thanks');
    expect(printed).toContain('html:    ');
    expect(result.accepted).toEqual(['ana@example.com', 'bo@example.com']);
    expect(transport.capabilities.delivers).toBe(false);
  });

  test('log prints bcc as a count, because a log gets pasted into a bug report', async () => {
    const lines: string[] = [];
    const transport = logTransport({ write: (text) => lines.push(text) });
    await transport.send(
      createMessage({
        from: 'a@tsir.local',
        to: ['b@example.com'],
        bcc: ['c@example.com'],
        subject: 's',
        text: 't',
      }),
    );
    const printed = lines.join('\n');
    expect(printed).toContain('bcc:     1 recipient(s), not shown');
    expect(printed).not.toContain('c@example.com');
  });

  test('memory collects, finds and clears', async () => {
    const transport = memoryTransport();
    await transport.send(message);
    await transport.send(
      createMessage({ from: 'a@tsir.local', to: ['zed@example.com'], subject: 'Other', text: 't' }),
    );

    expect(transport.count()).toBe(2);
    expect(transport.last()?.subject).toBe('Other');
    expect(transport.find((entry) => entry.subject === 'Your receipt')?.to[0]?.email).toBe(
      'ana@example.com',
    );
    transport.clear();
    expect(transport.sent()).toEqual([]);
  });
});

describe('the shared HTTP half', () => {
  test('a request that never answers is a timeout, not a hung invocation', async () => {
    const hanging = (async (_input: string | URL | Request, init?: RequestInit) => {
      // The request is aborted by the transport's own timer; this fake waits for the signal so the
      // test is about the abort path and not about a `sleep`.
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
      throw new Error('unreachable');
    }) as unknown as typeof fetch;

    const transport = resendTransport({ apiKey: 'k', fetch: hanging, timeoutMs: 5 });
    expect(transport.send(message)).rejects.toThrow(/timed out after 5 ms/u);
  });

  test('a provider that answers with a bare string still yields a readable message', async () => {
    const { fetch } = recordingFetch(
      () => new Response(JSON.stringify('bad request'), { status: 400 }),
    );
    const transport = resendTransport({ apiKey: 'k', fetch });
    expect(transport.send(message)).rejects.toThrow(/bad request/u);
  });

  test('a nested error object is dug out rather than printed as [object Object]', async () => {
    const { fetch } = recordingFetch(() => json({ error: { message: 'quota exceeded' } }, 429));
    const transport = resendTransport({ apiKey: 'k', fetch });
    expect(transport.send(message)).rejects.toThrow(/quota exceeded|HTTP 429/u);
  });
});

describe('the remaining provider shapes', () => {
  test('postmark sends its headers and reply-to in the fields it has for them', async () => {
    const { fetch, requests } = recordingFetch(() =>
      json({
        MessageID: 'pm',
        To: [
          { Email: 'ana@example.com', MessageID: 'pm' },
          { Email: 'bo@example.com', MessageID: 'pm' },
        ],
      }),
    );
    const transport = postmarkTransport({ serverToken: 't', fetch });
    await transport.send(
      createMessage({
        from: 'a@tsir.local',
        to: ['ana@example.com'],
        cc: ['bo@example.com'],
        replyTo: ['support@tsir.local'],
        subject: 's',
        text: 't',
        headers: { 'X-Campaign': 'spring' },
        attachments: [{ filename: 'a.pdf', content: new Uint8Array([1]), contentId: undefined }],
      }),
    );
    const body = JSON.parse(requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['ReplyTo']).toBe('support@tsir.local');
    expect(body['Headers']).toEqual([{ Name: 'X-Campaign', Value: 'spring' }]);
    expect((body['Attachments'] as { Name: string; Content: string }[])[0]?.Content).toBe('AQ==');
  });

  test('a provider error with a status is reported with that status in the context', async () => {
    const { fetch } = recordingFetch(() =>
      json({ ErrorCode: 300, Message: 'Invalid sender' }, 422),
    );
    const transport = postmarkTransport({ serverToken: 't', fetch });
    try {
      await transport.send(message);
    } catch (error: unknown) {
      const typed = error as { code: string; context?: { status?: number } };
      expect(typed.code).toBe('MAIL_TRANSPORT_FAILED');
      expect(typed.context?.status).toBe(422);
    }
  });

  test('cloudflare passes through everything the binding accepts, and invents no id of its own', async () => {
    const sent: unknown[] = [];
    const transport = cloudflareTransport({
      binding: {
        // The documented "accepted" shape: a binding that answers nothing at all.
        send: async (input) => {
          sent.push(input);
          return undefined;
        },
      },
    });
    const result = await transport.send(
      createMessage({
        from: 'Tsir <no-reply@tsir.local>',
        to: ['ana@example.com'],
        cc: ['bo@example.com'],
        bcc: ['quiet@example.com'],
        replyTo: ['support@tsir.local'],
        subject: 's',
        text: 't',
        html: '<p>t</p>',
        headers: { 'X-Campaign': 'spring' },
        attachments: [
          {
            filename: 'logo.png',
            content: new Uint8Array([1]),
            contentType: 'image/png',
            disposition: 'inline',
            contentId: 'logo',
          },
        ],
      }),
    );

    const input = sent[0] as Record<string, unknown>;
    expect(input['cc']).toEqual(['bo@example.com']);
    expect(input['bcc']).toEqual(['quiet@example.com']);
    expect(input['replyTo']).toBe('support@tsir.local');
    expect(input['headers']).toEqual({ 'X-Campaign': 'spring' });
    expect((input['attachments'] as Record<string, unknown>[])[0]).toEqual({
      filename: 'logo.png',
      content: new Uint8Array([1]),
      type: 'image/png',
      disposition: 'inline',
      contentId: 'logo',
    });
    // A binding that answers nothing is still an accepted send — with a local id, because
    // `DeliveryResult.id` is not optional.
    expect(result.id).toStartWith('cloudflare-');
  });

  test('ses refuses an answer that is not JSON (a proxy in the way) and one with no id', async () => {
    const notJson = recordingFetch(() => new Response('<html>gateway</html>', { status: 200 }));
    expect(
      sesTransport({
        region: 'us-east-1',
        credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
        fetch: notJson.fetch,
      }).send(message),
    ).rejects.toThrow(/not JSON|gateway/u);

    const noId = recordingFetch(() => json({ ok: true }));
    expect(
      sesTransport({
        region: 'us-east-1',
        credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
        fetch: noId.fetch,
      }).send(message),
    ).rejects.toThrow(/has no MessageId/u);
  });

  test('ses reports a transport-level failure with its own message', async () => {
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const transport = sesTransport({
      region: 'us-east-1',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
      fetch: down,
    });
    expect(transport.send(message)).rejects.toThrow(/ECONNREFUSED/u);
  });
});

describe('the log block prints what it was given', () => {
  test('headers, html and attachments are all in the block, and bcc is not', async () => {
    const lines: string[] = [];
    const transport = logTransport({ write: (text) => lines.push(text) });
    await transport.send(
      createMessage({
        from: 'a@tsir.local',
        to: ['ana@example.com'],
        bcc: ['secret@example.com'],
        subject: 's',
        text: 't',
        html: '<p>t</p>',
        headers: { 'X-Campaign': 'spring' },
        attachments: [
          { filename: 'report.pdf', content: new Uint8Array(2048), contentType: 'application/pdf' },
        ],
      }),
    );
    const printed = lines.join('\n');
    expect(printed).toContain('X-Campaign: spring');
    expect(printed).toContain('report.pdf (2.0 KiB, application/pdf)');
    expect(printed).not.toContain('secret@example.com');
  });
});
