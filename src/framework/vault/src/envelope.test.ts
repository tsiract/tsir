import { describe, expect, test } from 'bun:test';

import {
  associatedData,
  decodeBase64Url,
  encodeBase64Url,
  ENVELOPE_VERSION,
  joinPayload,
  parseEnvelope,
  serializeEnvelope,
  splitPayload,
} from './envelope.ts';

function codeOf(work: () => unknown): string {
  try {
    work();
    return 'none';
  } catch (reason: unknown) {
    return (reason as { code?: string }).code ?? 'no-code';
  }
}

/** A structurally valid envelope: 12-byte nonce, 4-byte ciphertext, 16-byte tag. */
const KEY_ID = 'k7f3q2ab';
const PAYLOAD = new Uint8Array([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32,
]);
const VALID = `tsir:v1:${KEY_ID}:aes-256-gcm:${encodeBase64Url(PAYLOAD)}`;

describe('the envelope format (VLT-001)', () => {
  test('round-trips through serialize and parse', () => {
    const parsed = parseEnvelope(VALID);

    expect(parsed.keyId).toBe(KEY_ID);
    expect(parsed.alg).toBe('aes-256-gcm');
    expect([...parsed.payload]).toEqual([...PAYLOAD]);
    expect(serializeEnvelope(parsed)).toBe(VALID);
  });

  test('base64url is unpadded and round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(64);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7) % 256;

    const text = encodeBase64Url(bytes);
    expect(text).not.toContain('=');
    expect(text).not.toContain('+');
    expect(text).not.toContain('/');
    expect([...decodeBase64Url(text, 'payload')]).toEqual([...bytes]);
  });

  test('seventeen malformed shapes each fail with VLT_MALFORMED_ENVELOPE', () => {
    const shapes: readonly [string, string][] = [
      ['four segments', `tsir:v1:${KEY_ID}:${encodeBase64Url(PAYLOAD)}`],
      ['six segments', `tsir:v1:${KEY_ID}:aes-256-gcm:${encodeBase64Url(PAYLOAD)}:extra`],
      ['wrong prefix', VALID.replace('tsir:', 'tsirx:')],
      ['newer version', VALID.replace('v1', 'v2')],
      ['upper-case key id', VALID.replace(KEY_ID, KEY_ID.toUpperCase())],
      ['key id too short', VALID.replace(KEY_ID, 'a')],
      ['key id with punctuation', VALID.replace(KEY_ID, 'k7f3q2a-b')],
      ['unknown algorithm', VALID.replace('aes-256-gcm', 'aes-256-cbc')],
      ['empty payload', VALID.replace(/:[^:]+$/, ':')],
      ['padded base64', `${VALID}=`],
      ['standard base64 alphabet', `${VALID.slice(0, -4)}+/==`],
      [
        'payload below minimum length',
        `tsir:v1:${KEY_ID}:aes-256-gcm:${encodeBase64Url(new Uint8Array(27))}`,
      ],
      ['not base64 at all', `tsir:v1:${KEY_ID}:aes-256-gcm:not*base64*`],
      ['empty string', ''],
      ['prefix only', 'tsir'],
      ['no algorithm', `tsir:v1:${KEY_ID}::${encodeBase64Url(PAYLOAD)}`],
      ['payload with unicode', `tsir:v1:${KEY_ID}:aes-256-gcm:abcdé`],
    ];

    expect(shapes).toHaveLength(17);
    for (const [name, value] of shapes) {
      try {
        parseEnvelope(value);
        throw new Error(`expected "${name}" to be rejected`);
      } catch (reason: unknown) {
        const error = reason as { code?: string; message?: string };
        // Deterministic: the same code for every malformed shape, with the reason
        // in the message so an operator can tell them apart.
        expect(error.code).toBe('VLT_MALFORMED_ENVELOPE');
        expect(error.message).toContain('envelope');
      }
    }
  });

  test('a version bump is reported as a version problem, not as tampering', () => {
    const error = (() => {
      try {
        parseEnvelope(VALID.replace('v1', 'v9'));
        return undefined;
      } catch (reason: unknown) {
        return reason as { message?: string };
      }
    })();

    expect(error?.message).toContain('unsupported envelope version');
  });

  test('the AAD binds key, algorithm, table and column', () => {
    const aad = new TextDecoder().decode(associatedData('aes-256-gcm', KEY_ID, 'users', 'tax_id'));
    expect(aad).toBe(`tsir:${ENVELOPE_VERSION}:${KEY_ID}:aes-256-gcm:users.tax_id`);

    // Every component changes the bytes: a ciphertext is bound to all four.
    const other = new TextDecoder().decode(associatedData('aes-256-gcm', KEY_ID, 'users', 'phone'));
    expect(other).not.toBe(aad);
  });

  test('payload splitting keeps nonce, ciphertext and tag apart', () => {
    const split = splitPayload('aes-256-gcm', PAYLOAD);

    expect(split.nonce).toHaveLength(12);
    expect(split.tag).toHaveLength(16);
    expect(split.ciphertext).toHaveLength(4);
    expect([
      ...joinPayload(split.nonce, new Uint8Array([...split.ciphertext, ...split.tag])),
    ]).toEqual([...PAYLOAD]);
  });

  test('an xchacha nonce is 24 bytes, and a 12-byte one is refused for it', () => {
    expect(codeOf(() => splitPayload('xchacha20-poly1305', new Uint8Array(28)))).toBe(
      'VLT_MALFORMED_ENVELOPE',
    );
    expect(splitPayload('xchacha20-poly1305', new Uint8Array(64)).nonce).toHaveLength(24);
  });
});
