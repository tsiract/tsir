import { describe, expect, test } from 'bun:test';

import { sha256Hex, sha256Text } from './hash.ts';
import {
  createRedactor,
  isRedacted,
  OMITTED,
  REDACTED,
  REDACTION_ERROR,
  Redacted,
  redacted,
  reveal,
} from './redact.ts';

describe('sha256', () => {
  test('the FIPS 180-4 vectors match, including the multi-block boundaries', () => {
    // Published NIST vectors: this is the only reason a hand-written hash is acceptable at all.
    expect(sha256Text('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Text('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Text('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  test('every input length around a block boundary hashes without throwing', () => {
    for (let length = 0; length < 130; length += 1) {
      expect(sha256Text('x'.repeat(length))).toMatch(/^[0-9a-f]{64}$/u);
    }
    // Distinct inputs, distinct digests: a padding bug usually collapses two lengths together.
    const digests = new Set(
      Array.from({ length: 130 }, (_unused, length) => sha256Text('x'.repeat(length))),
    );
    expect(digests.size).toBe(130);
  });

  test('bytes and text agree', () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63]);
    expect(sha256Hex(bytes)).toBe(sha256Text('abc'));
  });
});

describe('layer 1 — Redacted', () => {
  test('a redacted value cannot leak through JSON, a template literal or string concatenation', () => {
    const token = redacted('super-secret-token', 'session');
    expect(JSON.stringify({ token })).toBe('{"token":"[redacted]"}');
    // The point of the test: a template literal is a leak vector, and `Redacted` closes it.
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    expect(`${token}`).toBe(REDACTED);
    expect(String(token)).toBe(REDACTED);
    expect(JSON.stringify([token])).toBe('["[redacted]"]');
  });

  test('`reveal` is the only way out, and it reports itself', () => {
    const seen: string[] = [];
    Redacted.onReveal = (label) => seen.push(label);
    try {
      const token = redacted('super-secret-token', 'session');
      expect(token.reveal()).toBe('super-secret-token');
      expect(seen).toEqual(['session']);

      // The installed handler is global, so an unlabelled value reports `unnamed`.
      expect(redacted(1).reveal()).toBe(1);
      expect(seen).toEqual(['session', 'unnamed']);
    } finally {
      Redacted.onReveal = undefined;
    }
  });

  test('`reveal(value)` unwraps either shape', () => {
    expect(reveal(redacted('x'))).toBe('x');
    expect(reveal('plain')).toBe('plain');
    expect(isRedacted(redacted(1))).toBe(true);
    expect(isRedacted({ redacted: true })).toBe(true); // structural, for a value from another realm
    expect(isRedacted('redacted')).toBe(false);
    expect(isRedacted(null)).toBe(false);
    expect(isRedacted(undefined)).toBe(false);
    expect(redacted('x').label).toBeUndefined();
  });
});

describe('layer 3 — key and value patterns', () => {
  const redactor = createRedactor();

  test('a secret-shaped key is redacted whatever its value is', () => {
    const fields = redactor.fields({
      password: 'hunter2',
      passwordHash: 'abc',
      apiKey: 'abc',
      api_key: 'abc',
      authorization: 'Basic dXNlcjpwYXNz',
      cookie: 'a=b',
      'Set-Cookie': 'a=b',
      clientSecret: 'shh',
      privateKey: 'pem',
      credential: 'c',
      signature: 's',
      userToken: 't',
    });
    for (const value of Object.values(fields)) expect(value).toBe(REDACTED);
  });

  test('a credential-shaped value is redacted under an innocent key', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const values = redactor.fields({
      a: jwt,
      b: '-----BEGIN RSA PRIVATE KEY-----\nMIIE…',
      c: 'Bearer abcdefghijklmnop',
      d: 'tsk_abcdef012345_abcdefghijklmnop',
      e: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      f: 'a'.repeat(41) + '1',
    });
    for (const value of Object.values(values)) expect(value).toBe(REDACTED);
  });

  test('ordinary values survive untouched', () => {
    const fields = redactor.fields({
      invoiceId: 'inv_123',
      amountCents: 4200,
      ok: true,
      userId: 'user_1',
      route: 'POST /invoices',
      status: 422,
      shortHex: 'deadbeef',
      dotted: 'a.b.c',
      nothing: null,
    });
    expect(fields).toEqual({
      invoiceId: 'inv_123',
      amountCents: 4200,
      ok: true,
      userId: 'user_1',
      route: 'POST /invoices',
      status: 422,
      shortHex: 'deadbeef',
      dotted: 'a.b.c',
      nothing: null,
    });
  });

  test('the match is on the key, not the path, and case-insensitive', () => {
    expect(redactor.fields({ 'headers.Authorization': 'Bearer x' })['headers.Authorization']).toBe(
      REDACTED,
    );
    expect(createRedactor().fields({ PASSWORD: 'x' })['PASSWORD']).toBe(REDACTED);
  });

  test('extra key patterns are added, not swapped in', () => {
    const custom = createRedactor({ keys: [/iban/iu] });
    expect(custom.fields({ iban: 'DE89 3704 0044 0532 0130 00' }).iban).toBe(REDACTED);
    // The default still applies.
    expect(custom.fields({ password: 'x' }).password).toBe(REDACTED);
  });
});

describe('layer 2 — paths', () => {
  test('an exact path redacts a field whose name looks harmless', () => {
    const redactor = createRedactor({ paths: ['body.pin', 'user.email'] });
    const fields = redactor.fields({
      body: { pin: '1234', name: 'Ada' },
      user: { email: 'ada@example.com', id: 'user_1' },
    });
    expect(fields).toEqual({
      body: { pin: REDACTED, name: 'Ada' },
      user: { email: REDACTED, id: 'user_1' },
    });
    expect(redactor.isSensitivePath('body.pin')).toBe(true);
    expect(redactor.isSensitivePath('body.name')).toBe(false);
  });

  test('`*` matches one segment and `**` matches a suffix', () => {
    // `secrets` would be caught by the key pattern anyway; `vault` is not, so this test proves the
    // path layer is doing the work.
    const redactor = createRedactor({ paths: ['items[*].card', 'vault.**'] });
    const fields = redactor.fields({
      items: [
        { card: '4242', sku: 'a' },
        { card: '1111', sku: 'b' },
      ],
      vault: { a: 'one', b: { c: 'two' } },
      other: { card: '9999' },
    });
    expect(fields).toEqual({
      items: [
        { card: REDACTED, sku: 'a' },
        { card: REDACTED, sku: 'b' },
      ],
      // `**` matches `vault.a` and `vault.b`, so the whole value at each matched path goes. A
      // redactor that kept descending would be honouring a subtree that is already redacted.
      vault: { a: REDACTED, b: REDACTED },
      other: { card: '9999' },
    });
  });

  test('a path is matched on the object graph, not on the key alone', () => {
    const redactor = createRedactor({ paths: ['body.password'] });
    expect(redactor.fields({ body: { password: 'x' } }).body).toEqual({ password: REDACTED });
    // A different parent is not the same path.
    expect(redactor.fields({ query: { password: 'x' } }).query).toEqual({ password: REDACTED });
    expect(redactor.isSensitivePath('body')).toBe(false);
  });

  test('no paths means no path matching, without a special case at the call site', () => {
    const redactor = createRedactor();
    expect(redactor.isSensitivePath('body.password')).toBe(false);
    expect(redactor.fields({ body: { slug: 'x' } })).toEqual({ body: { slug: 'x' } });
  });
});

describe('PII', () => {
  const person = {
    email: 'ada@example.com',
    phone: '+63 900 000 0000',
    ip: '203.0.113.7',
    fullName: 'Ada L',
  };

  test('`omit` is the default, and only person-shaped keys are affected', () => {
    const fields = createRedactor().fields({ ...person, name: 'invoices' });
    expect(fields).toEqual({
      email: OMITTED,
      phone: OMITTED,
      ip: OMITTED,
      fullName: OMITTED,
      name: 'invoices', // a route, a channel or a metric — not a person
    });
  });

  test('`hash` produces a stable pseudonym that is not the value', () => {
    const redactor = createRedactor({ pii: 'hash', piiSalt: 'app-1' });
    const first = redactor.fields({ email: 'ada@example.com' }).email as string;
    const second = redactor.fields({ email: 'ada@example.com' }).email as string;
    const other = redactor.fields({ email: 'grace@example.com' }).email as string;

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^h:[0-9a-f]{16}$/u);
    expect(first).not.toContain('ada');

    // The salt is what makes the pseudonym useless anywhere else.
    const elsewhere = createRedactor({ pii: 'hash', piiSalt: 'app-2' }).fields({
      email: 'ada@example.com',
    });
    expect(elsewhere.email).not.toBe(first);
  });

  test('`hash` also handles a non-string PII value', () => {
    const redactor = createRedactor({ pii: 'hash' });
    expect(redactor.fields({ ip: 16_777_217 }).ip).toMatch(/^h:[0-9a-f]{16}$/u);
  });

  test('`allow` writes the value, which is a decision an app must make explicitly', () => {
    expect(createRedactor({ pii: 'allow' }).fields(person)).toEqual(person);
  });

  test('an unknown policy is refused at construction', () => {
    expect(() => createRedactor({ pii: 'sometimes' as 'omit' })).toThrow(/unknown policy/u);
  });
});

describe('bounds and failure', () => {
  test('a deep object is cut off, and the record says so', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 'too deep' } } } } } } } };
    const redactedFields = createRedactor().fields(deep) as Record<string, Record<string, unknown>>;
    expect(JSON.stringify(redactedFields)).toContain('[depth]');
  });

  test('a circular object does not hang or throw', () => {
    const cycle: Record<string, unknown> = { name: 'x' };
    cycle['self'] = cycle;
    expect(() => createRedactor().fields(cycle)).not.toThrow();
    expect(JSON.stringify(createRedactor().fields(cycle))).toContain('[circular]');
  });

  test('long strings are truncated with the length kept', () => {
    const fields = createRedactor({ maxStringLength: 10 }).fields({ note: 'x'.repeat(30) });
    expect(fields['note']).toBe('xxxxxxxxxx…[20 chars]');
  });

  test('a wide object keeps `maxEntries` and counts the rest', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 12 }, (_unused, index) => [`k${String(index)}`, index]),
    );
    const fields = createRedactor({ maxEntries: 5 }).fields(wide);
    expect(Object.keys(fields)).toHaveLength(6);
    expect(fields['…']).toBe('7 more');
  });

  test('arrays keep their head and count the tail', () => {
    const fields = createRedactor({ maxEntries: 3 }).fields({ items: [1, 2, 3, 4, 5] });
    expect(fields['items']).toEqual([1, 2, 3, '… 2 more']);
  });

  test('a value that throws when read becomes `[redaction-error]`, never a leak', () => {
    const hostile = {
      get boom(): string {
        throw new Error('getter exploded');
      },
    };
    // The getter is read by `Object.entries`, so the failure happens before a key exists to redact.
    const fields = createRedactor().fields({ safe: 1, hostile });
    expect(fields['safe']).toBe(1);
    expect(JSON.stringify(fields)).toBe(JSON.stringify({ safe: 1, hostile: REDACTION_ERROR }));
  });

  test('typed, path and pattern layers compose in one object', () => {
    const redactor = createRedactor({ paths: ['payload.pin'] });
    const fields = redactor.fields({
      payload: { pin: '1234', token: redacted('abc'), password: 'hunter2', keep: 'yes' },
      header: redacted('Bearer x'),
    });
    expect(fields).toEqual({
      payload: { pin: REDACTED, token: REDACTED, password: REDACTED, keep: 'yes' },
      header: REDACTED,
    });
  });

  test('a bare value can be redacted too, which is what a message argument uses', () => {
    expect(
      createRedactor().value(
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      ),
    ).toBe(REDACTED);
    expect(createRedactor().value('POST /invoices')).toBe('POST /invoices');
    expect(createRedactor().value(redacted('x'))).toBe(REDACTED);
  });

  test('non-JSON values get a summary rather than a crash or a wall of numbers', () => {
    const fields = createRedactor().fields({
      bytes: new Uint8Array(64),
      when: new Date('2026-10-29T00:00:00.000Z'),
      fn: function named() {
        return 1;
      },
      set: new Set([1, 2]),
      map: new Map([['a', 1]]),
      big: 10n,
      sym: Symbol('x'),
      error: new TypeError('boom'),
    });
    expect(fields['bytes']).toEqual({ type: 'bytes', bytes: 64 });
    expect(fields['when']).toBe('2026-10-29T00:00:00.000Z');
    expect(fields['fn']).toBe('[function named]');
    expect(fields['set']).toEqual([1, 2]);
    expect(fields['map']).toEqual({ a: 1 });
    expect(fields['big']).toBe('10');
    expect(fields['sym']).toBe('Symbol(x)');
    expect(fields['error']).toEqual({ type: 'TypeError', message: 'boom' });
  });
});
