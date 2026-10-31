import { describe, expect, test } from 'bun:test';

import { parseSignature, signBody, verifySignature } from './signing.ts';

const SECRET = 'whsec_test';
const BODY = '{"event":"order.shipped","data":{"id":"ord_1"}}';
const AT = 1_700_000_000_000;

describe('webhook signatures', () => {
  test('the header is `t=<seconds>,v1=<hex>`, and the timestamp is part of the signed string', async () => {
    const header = await signBody({ secret: SECRET, body: BODY, timestamp: AT });
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/u);

    const later = await signBody({ secret: SECRET, body: BODY, timestamp: AT + 1000 });
    expect(later).not.toBe(header);

    const otherBody = await signBody({ secret: SECRET, body: `${BODY} `, timestamp: AT });
    expect(otherBody).not.toBe(header);
  });

  test('verification accepts the exact bytes and refuses everything else', async () => {
    const header = await signBody({ secret: SECRET, body: BODY, timestamp: AT });

    expect(await verifySignature({ header, body: BODY, secret: SECRET, now: AT })).toBe(true);
    expect(await verifySignature({ header, body: BODY, secret: 'other', now: AT })).toBe(false);
    expect(await verifySignature({ header, body: `${BODY}x`, secret: SECRET, now: AT })).toBe(
      false,
    );
  });

  test("an old timestamp is a replay, and the window is the receiver's to choose", async () => {
    const header = await signBody({ secret: SECRET, body: BODY, timestamp: AT });

    expect(await verifySignature({ header, body: BODY, secret: SECRET, now: AT + 299_000 })).toBe(
      true,
    );
    expect(await verifySignature({ header, body: BODY, secret: SECRET, now: AT + 301_000 })).toBe(
      false,
    );
    expect(
      await verifySignature({
        header,
        body: BODY,
        secret: SECRET,
        now: AT + 301_000,
        toleranceMs: 400_000,
      }),
    ).toBe(true);
    // A `toleranceMs` of 0 refuses everything, which is awkward on purpose rather than surprising.
    expect(
      await verifySignature({ header, body: BODY, secret: SECRET, now: AT, toleranceMs: 0 }),
    ).toBe(true);
    expect(
      await verifySignature({ header, body: BODY, secret: SECRET, now: AT + 1, toleranceMs: 0 }),
    ).toBe(false);
  });

  test('a header that is not the shape above is not a signature', async () => {
    expect(parseSignature('t=1700000000,v1=abc')).toEqual({
      timestamp: 1_700_000_000,
      signature: 'abc',
    });
    expect(parseSignature('v1=abc,t=1700000000')).toEqual({
      timestamp: 1_700_000_000,
      signature: 'abc',
    });
    expect(parseSignature('nope')).toBeUndefined();
    expect(parseSignature('t=,v1=abc')).toBeUndefined();
    expect(parseSignature('t=1700000000')).toBeUndefined();
    expect(parseSignature('t=abc,v1=def')).toBeUndefined();
    expect(parseSignature('=x,t=1')).toBeUndefined();

    expect(await verifySignature({ header: 'garbage', body: BODY, secret: SECRET })).toBe(false);
  });
});
