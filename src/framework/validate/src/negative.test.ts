import { describe, expect, test } from 'bun:test';

import { formatIssues, normalizeIssues, parse, validate, z } from './index.ts';
// HTTP-shaped schemas live on their own subpath so that importing `@tsir/validate`
// never pulls them in (see `@tsir/validate/http`).
import { DateRange, IntParam, PageQuery, SortQuery } from './http.ts';

/**
 * The negative matrix (VLD-010).
 *
 * Validation is the one place where a wrong answer is silently a security
 * answer: accept `4.2` as an id and the query runs against the wrong row; accept
 * `undefined` as a required field and a null propagates into the database. So
 * every case here asserts a *rejection*, and the interesting column is the
 * reason.
 *
 * The table is deliberately hostile input, not "wrong types". Anything that only
 * defeats a sloppy parser — leading whitespace, exponent notation, hex, unicode
 * digits, empty strings, `null` — is in scope.
 */

interface Case {
  readonly name: string;
  readonly schema: Parameters<typeof validate>[0];
  readonly input: unknown;
}

const coercionCases: readonly Case[] = [
  { name: 'decimal for an integer param', schema: IntParam, input: '4.2' },
  { name: 'exponent notation', schema: IntParam, input: '1e3' },
  { name: 'leading whitespace', schema: IntParam, input: ' 3' },
  { name: 'trailing whitespace', schema: IntParam, input: '3 ' },
  { name: 'hex literal', schema: IntParam, input: '0x10' },
  { name: 'empty string', schema: IntParam, input: '' },
  { name: 'plus sign', schema: IntParam, input: '+3' },
  { name: 'unicode digits', schema: IntParam, input: '４２' },
  { name: 'thousands separator', schema: IntParam, input: '1,000' },
  { name: 'null', schema: IntParam, input: null },
  { name: 'undefined', schema: IntParam, input: undefined },
  { name: 'boolean', schema: IntParam, input: true },
  { name: 'array', schema: IntParam, input: ['1'] },
  { name: 'object', schema: IntParam, input: { value: 1 } },
  { name: 'unsafe integer', schema: IntParam, input: '9007199254740993' },
];

const queryCases: readonly Case[] = [
  { name: 'page=0', schema: PageQuery(), input: { page: '0' } },
  {
    name: 'perPage above the cap',
    schema: PageQuery({ maxPerPage: 100 }),
    input: { perPage: '101' },
  },
  { name: 'perPage negative', schema: PageQuery(), input: { perPage: '-1' } },
  { name: 'page as a decimal', schema: PageQuery(), input: { page: '1.5' } },
  { name: 'page as text', schema: PageQuery(), input: { page: 'two' } },
];

const sortCases: readonly Case[] = [
  { name: 'unknown field', schema: SortQuery(['email', 'createdAt']), input: 'password' },
  { name: 'unknown field among known ones', schema: SortQuery(['email']), input: 'email,password' },
];

const objectCases: readonly Case[] = [
  { name: 'missing required key', schema: z.object({ a: z.string() }), input: {} },
  { name: 'wrong type for a key', schema: z.object({ a: z.string() }), input: { a: 1 } },
  { name: 'null where an object is expected', schema: z.object({ a: z.string() }), input: null },
  { name: 'array where an object is expected', schema: z.object({ a: z.string() }), input: [] },
  {
    name: 'string longer than allowed',
    schema: z.object({ a: z.string().max(3) }),
    input: { a: 'abcd' },
  },
  { name: 'number below minimum', schema: z.object({ a: z.number().min(1) }), input: { a: 0 } },
  { name: 'enum value not in the set', schema: z.enum(['a', 'b']), input: 'c' },
];

describe('validate · negative matrix (VLD-010)', () => {
  test('every hostile integer input is rejected with a reason', async () => {
    for (const testCase of coercionCases) {
      const result = await validate(testCase.schema, testCase.input);
      expect({ name: testCase.name, ok: result.ok }).toEqual({ name: testCase.name, ok: false });
      if (result.ok) continue;
      expect(result.issues.length).toBeGreaterThan(0);
      // A rejection with an empty message is a bug report waiting to happen.
      expect(result.issues[0]?.message.length).toBeGreaterThan(0);
    }
  });

  test('query bounds are enforced by the schema, not the handler', async () => {
    for (const testCase of queryCases) {
      expect({
        name: testCase.name,
        ok: (await validate(testCase.schema, testCase.input)).ok,
      }).toEqual({
        name: testCase.name,
        ok: false,
      });
    }
  });

  test('sorting by a field that is not allowed is rejected', async () => {
    for (const testCase of sortCases) {
      expect({
        name: testCase.name,
        ok: (await validate(testCase.schema, testCase.input)).ok,
      }).toEqual({
        name: testCase.name,
        ok: false,
      });
    }
  });

  test('structurally wrong payloads are rejected', async () => {
    for (const testCase of objectCases) {
      expect({
        name: testCase.name,
        ok: (await validate(testCase.schema, testCase.input)).ok,
      }).toEqual({
        name: testCase.name,
        ok: false,
      });
    }
  });

  test('issues normalize to a path, a message and a code — never a throw', async () => {
    const result = await validate(
      z.object({ user: z.object({ email: z.email(), age: z.number() }) }),
      { user: { email: 'nope', age: 'old' } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const issues = normalizeIssues(result.issues);
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(Array.isArray(issue.path)).toBe(true);
      expect(issue.path[0]).toBe('user');
      expect(typeof issue.message).toBe('string');
      expect(issue.message.length).toBeGreaterThan(0);
    }
    // The path points at the field, not at "the object".
    expect(issues.map((issue) => issue.path.join('.'))).toEqual(['user.email', 'user.age']);
  });

  test('formatIssues renders a stable, greppable line per issue', async () => {
    const result = await validate(z.object({ email: z.email() }), { email: 'nope' });
    if (result.ok) throw new Error('expected a failure');
    const text = formatIssues(result.issues);
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain('email');
    expect(formatIssues([])).toBe('no issues');
  });

  test('parse throws a ValidationError carrying the same issues', async () => {
    let caught: unknown;
    try {
      await parse(z.object({ a: z.string() }), {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const issues = (caught as { issues?: readonly unknown[] }).issues;
    expect(issues?.length).toBe(1);
  });

  test('a throwing validator propagates: it is a server bug, not a 422', async () => {
    // Deliberate. If a validator throws (rather than returning issues), the fault
    // is in *our* code or in a third-party schema, and reporting it as a client
    // validation failure would hide a real bug behind a 422 the caller cannot fix.
    // The pipeline's error boundary turns it into a 500 and logs it.
    const hostile = {
      '~standard': {
        version: 1 as const,
        vendor: 'hostile',
        validate: () => {
          throw new Error('validator exploded');
        },
      },
    };

    const error = await validate(hostile, 'x').then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('validator exploded');
  });

  test('a rejecting async validator also propagates', async () => {
    const hostile = {
      '~standard': {
        version: 1 as const,
        vendor: 'hostile',
        validate: async () => {
          throw new Error('async exploded');
        },
      },
    };

    const error = await validate(hostile, 'x').then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect((error as Error).message).toBe('async exploded');
  });
});

describe('validate · DateRange (VLD-004)', () => {
  const schema = DateRange({ maxDays: 31 });

  test('a well-formed half-open range parses to dates', async () => {
    const result = await validate(schema, { from: '2024-01-01', to: '2024-01-08' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.from?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(result.value.to?.toISOString()).toBe('2024-01-08T00:00:00.000Z');
  });

  test('either end may be omitted', async () => {
    expect((await validate(schema, {})).ok).toBe(true);
    expect((await validate(schema, { from: '2024-01-01' })).ok).toBe(true);
  });

  test('impossible dates, wrong order and oversized ranges are rejected', async () => {
    for (const input of [
      { from: '2024-02-30' }, // rolls over to March if parsed by Date alone
      { from: '2024-1-1' },
      { from: '01/01/2024' },
      { from: '2024-01-08', to: '2024-01-01' },
      { from: '2024-01-01', to: '2024-03-01' }, // 60 days > 31
    ]) {
      expect({ input, ok: (await validate(schema, input)).ok }).toEqual({ input, ok: false });
    }
  });
});
