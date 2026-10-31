/**
 * WS-Security `UsernameToken` (`LNK-019`).
 *
 * The digest is pinned against a vector computed independently with `node:crypto` — a
 * test that computes the expected value with the same function it is testing proves
 * nothing. The nonce and timestamp are the two seams that make that possible.
 */

import { describe, expect, test } from 'bun:test';

import { createCallContext } from './types.ts';
import { createSoapClient, SOAP_NAMESPACE } from './soap.ts';
import {
  DEFAULT_TOKEN_MAX_AGE_MS,
  base64Decode,
  base64Encode,
  passwordDigest,
  securityHeader,
  verifyUsernameToken,
} from './wsse.ts';
import { parseXml, serializeXml, childNamed, textOf } from './xml.ts';

const NONCE = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const CREATED = new Date('2026-10-28T00:00:00.000Z');
const PASSWORD = 'correct horse battery staple';

// openssl/node: Base64(SHA-1(nonce ‖ created ‖ password))
const DIGEST = 'PhYHn/yL9+oCTx366zPwZK38LE8=';

const ctx = (): ReturnType<typeof createCallContext> =>
  createCallContext({ traceId: 'a'.repeat(32), correlationId: 'c-1' });

describe('UsernameToken — the digest (LNK-019)', () => {
  test('matches the independent vector', async () => {
    expect(await passwordDigest(NONCE, CREATED.toISOString(), PASSWORD)).toBe(DIGEST);
  });

  test('base64 helpers round-trip arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 255, 128, 1, 7]);
    expect([...base64Decode(base64Encode(bytes))]).toEqual([...bytes]);
    expect(base64Encode(NONCE)).toBe('AAECAwQFBgcICQoLDA0ODw==');
  });
});

describe('UsernameToken — the header (LNK-019)', () => {
  test('digest mode carries a hashed password, a nonce and a timestamp', async () => {
    const header = await securityHeader(
      { username: 'svc-tax', password: PASSWORD, nonce: NONCE, created: CREATED },
      { envelopeNamespace: SOAP_NAMESPACE['1.2'] },
    );

    const parsed = parseXml(serializeXml(header));
    const token = childNamed(parsed, 'UsernameToken');
    expect(token?.localName).toBe('UsernameToken');
    expect(textOf(childNamed(token ?? parsed, 'Username') ?? parsed)).toBe('svc-tax');

    const password = childNamed(token ?? parsed, 'Password') ?? parsed;
    expect(password.attributes['Type']).toEndWith('#PasswordDigest');
    expect(textOf(password)).toBe(DIGEST);

    expect(textOf(childNamed(token ?? parsed, 'Nonce') ?? parsed)).toBe(base64Encode(NONCE));
    expect(textOf(childNamed(token ?? parsed, 'Created') ?? parsed)).toBe(CREATED.toISOString());
    // `mustUnderstand` is only legal with the prefix declared on the same element.
    expect(parsed.attributes['soap:mustUnderstand']).toBe('1');
    expect(parsed.attributes['xmlns:soap']).toBe(SOAP_NAMESPACE['1.2']);
  });

  test('text mode sends the password, and says so in the Type', async () => {
    const header = await securityHeader({ username: 'svc', password: 'p', mode: 'text' });
    const token = childNamed(parseXml(serializeXml(header)), 'UsernameToken');

    const password = childNamed(token ?? parseXml('<a/>'), 'Password');
    expect(password?.attributes['Type']).toEndWith('#PasswordText');
    expect(textOf(password ?? parseXml('<a/>'))).toBe('p');
  });
});

describe('UsernameToken — verification (LNK-019)', () => {
  const headerFor = async (password = PASSWORD): Promise<string> =>
    serializeXml(
      await securityHeader({
        username: 'svc-tax',
        password,
        nonce: NONCE,
        created: CREATED,
      }),
    );

  test('a correct token authenticates, and the username comes back', async () => {
    const header = parseXml(await headerFor());
    const result = await verifyUsernameToken(header, {
      passwordFor: (user) => (user === 'svc-tax' ? PASSWORD : undefined),
      now: () => CREATED.getTime(),
    });

    expect(result).toEqual({ ok: true, username: 'svc-tax' });
  });

  test('a wrong password and an unknown user are indistinguishable', async () => {
    const header = parseXml(await headerFor('wrong'));
    const wrongPassword = await verifyUsernameToken(header, {
      passwordFor: () => PASSWORD,
      now: () => CREATED.getTime(),
    });
    const unknownUser = await verifyUsernameToken(header, {
      passwordFor: () => undefined,
      now: () => CREATED.getTime(),
    });

    expect(wrongPassword.ok).toBe(false);
    expect(unknownUser.ok).toBe(false);
    if (wrongPassword.ok || unknownUser.ok) return;
    expect(wrongPassword.error.code).toBe('LNK_UNAUTHENTICATED');
    expect(wrongPassword.error.message).toBe(unknownUser.error.message);
  });

  test('a stale token is refused, and so is one from the future', async () => {
    const header = parseXml(await headerFor());

    const stale = await verifyUsernameToken(header, {
      passwordFor: () => PASSWORD,
      now: () => CREATED.getTime() + DEFAULT_TOKEN_MAX_AGE_MS + 1,
    });
    const future = await verifyUsernameToken(header, {
      passwordFor: () => PASSWORD,
      now: () => CREATED.getTime() - 10 * 60_000,
    });

    expect(stale.ok).toBe(false);
    expect(future.ok).toBe(false);
    if (stale.ok || future.ok) return;
    expect(stale.error.message).toContain('freshness');
    expect(future.error.message).toContain('future');
  });

  test('digest-only deployments refuse a text password', async () => {
    const header = parseXml(
      serializeXml(await securityHeader({ username: 'svc', password: 'p', mode: 'text' })),
    );

    const result = await verifyUsernameToken(header, {
      passwordFor: () => 'p',
      modes: ['digest'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('not accepted');
  });

  test('a token without Nonce or Created cannot be a digest, so it is refused', async () => {
    const header = parseXml(
      '<wsse:Security xmlns:wsse="urn:wsse"><wsse:UsernameToken><wsse:Username>svc</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">abc</wsse:Password></wsse:UsernameToken></wsse:Security>',
    );

    const result = await verifyUsernameToken(header, { passwordFor: () => 'p' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Nonce');
  });

  test('a non-base64 nonce is a refusal, not an exception', async () => {
    const header = parseXml(
      `<wsse:Security xmlns:wsse="urn:wsse"><wsse:UsernameToken><wsse:Username>svc</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">abc</wsse:Password><wsse:Nonce>***</wsse:Nonce><wsu:Created xmlns:wsu="urn:wsu">${CREATED.toISOString()}</wsu:Created></wsse:UsernameToken></wsse:Security>`,
    );

    const result = await verifyUsernameToken(header, {
      passwordFor: () => 'p',
      now: () => CREATED.getTime(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('base64');
  });
});

describe('UsernameToken — on the wire (LNK-019)', () => {
  test('the client puts the security header inside soap:Header, before the body', async () => {
    let seen = '';
    const soap = createSoapClient({
      endpoint: 'https://tax.example.com/soap',
      ctx: ctx(),
      security: {
        usernameToken: { username: 'svc-tax', password: PASSWORD, nonce: NONCE, created: CREATED },
      },
      operations: { GetTaxRate: { operation: 'GetTaxRate' } },
      deps: {
        fetch: (_input, init) => {
          seen = typeof init.body === 'string' ? init.body : '';
          return Promise.resolve(
            new Response(
              `<env:Envelope xmlns:env="${SOAP_NAMESPACE['1.2']}"><env:Body><GetTaxRateResponse><rate>7</rate></GetTaxRateResponse></env:Body></env:Envelope>`,
            ),
          );
        },
        sleep: () => Promise.resolve(),
        now: () => CREATED.getTime(),
        random: () => 0.5,
      },
    });

    await soap.call('GetTaxRate', { country: 'SG' });

    const envelope = parseXml(seen);
    const header = childNamed(envelope, 'Header');
    expect(header).toBeDefined();
    expect(childNamed(header ?? envelope, 'Security')).toBeDefined();
    expect(seen.indexOf('<soap:Header>')).toBeLessThan(seen.indexOf('<soap:Body>'));
  });
});
