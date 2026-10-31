/**
 * `@tsir/validate` tests.
 *
 * The contract that matters: any Standard Schema library works without Tsir
 * importing it, failures normalize to one shape, and an async validator is
 * never mistaken for a synchronous success.
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod'; // direct import on purpose: proves interop, not re-export

import {
  expectStandardSchema,
  formatIssues,
  isStandardSchema,
  normalizeIssues,
  parse,
  objectOf,
  unknownKeysPolicy,
  ValidationError,
  validate,
  validateSync,
  withUnknownKeys,
} from './index.ts';
import type { StandardSchemaV1 } from './standard.ts';
import type { IssueCode } from './issues.ts';

const CreateUser = z.object({
  email: z.email(),
  age: z.number().int().min(18),
  nickname: z.string().optional(),
});

/** A hand-written schema: proves nothing about Zod is required. */
function fakeSchema(
  behaviour: (input: unknown) => StandardSchemaV1.Result<unknown>,
): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'handwritten',
      validate: behaviour,
    },
  };
}

describe('validate · schema detection', () => {
  test('accepts Zod schemas without importing the Zod adapter', () => {
    expect(isStandardSchema(CreateUser)).toBe(true);
    expect(expectStandardSchema(CreateUser)['~standard'].vendor).toBe('zod');
    expect(expectStandardSchema(CreateUser)['~standard'].version).toBe(1);
  });

  test('accepts a hand-written Standard Schema', () => {
    const schema = fakeSchema((input) =>
      typeof input === 'string' ? { value: input } : { issues: [{ message: 'expected string' }] },
    );
    expect(isStandardSchema(schema)).toBe(true);
  });

  test('rejects everything that is not Standard Schema v1', () => {
    for (const candidate of [
      null,
      undefined,
      42,
      'schema',
      {},
      { '~standard': null },
      { '~standard': { version: 2, validate: () => ({ value: 1 }) } },
      { '~standard': { version: 1, validate: 'nope' } },
    ]) {
      expect(isStandardSchema(candidate)).toBe(false);
    }
  });

  test('expectStandardSchema explains the fix instead of returning undefined', () => {
    try {
      expectStandardSchema({ validate: () => true }, 'body schema');
      throw new Error('expected a throw');
    } catch (error: unknown) {
      const shaped = error as { code: string; message: string; hint?: string };
      expect(shaped.code).toBe('VLD_NOT_STANDARD_SCHEMA');
      expect(shaped.message).toContain('body schema');
      expect(shaped.hint).toContain('Zod');
    }
  });
});

describe('validate · results', () => {
  test('valid input yields the parsed output, not the input', async () => {
    const result = await validate(CreateUser, {
      email: 'ADA@example.com',
      age: 36,
      nickname: 'ada',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.email).toBe('ADA@example.com');
    expect(result.value.age).toBe(36);
  });

  test('invalid input yields every issue with a string path', async () => {
    const result = await validate(CreateUser, { email: 'not-an-email', age: 12 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((issue) => issue.path.join('.'));
    expect(paths).toContain('email');
    expect(paths).toContain('age');
    expect(result.issues.every((issue) => typeof issue.message === 'string')).toBe(true);
  });

  test('nested and array paths are joined with plain string keys', async () => {
    const result = await validate(z.object({ items: z.array(z.object({ sku: z.string() })) }), {
      items: [{ sku: 1 }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toEqual(['items', '0', 'sku']);
  });

  test('invalid input never throws — the caller decides', async () => {
    const result = await validate(CreateUser, null);
    expect(result.ok).toBe(false);
  });

  test('async validators are supported by validate()', async () => {
    const Async = z.string().refine(async (value) => value !== 'taken', 'already taken');

    const accepted = await validate(Async, 'free');
    expect(accepted.ok).toBe(true);

    const rejected = await validate(Async, 'taken');
    expect(rejected.ok).toBe(false);
  });
});

describe('validate · synchronous path', () => {
  test('validateSync returns the same shape for synchronous schemas', () => {
    expect(validateSync(CreateUser, { email: 'a@b.co', age: 20 })).toMatchObject({ ok: true });
    const failure = validateSync(CreateUser, { email: 'a@b.co', age: 20, nickname: 1 });
    expect(failure.ok).toBe(false);
  });

  test('validateSync refuses an async schema rather than returning a promise', () => {
    const Async = z.string().refine(async () => true);
    try {
      validateSync(Async, 'x');
      throw new Error('expected VLD_ASYNC_SCHEMA');
    } catch (error: unknown) {
      const shaped = error as { code: string; hint?: string };
      expect(shaped.code).toBe('VLD_ASYNC_SCHEMA');
      expect(shaped.hint).toContain('validate()');
    }
  });
});

describe('validate · parse', () => {
  test('parse returns the value or throws ValidationError with issues attached', async () => {
    const parsed = await parse(CreateUser, { email: 'a@b.co', age: 20 }, 'user');
    expect(parsed.age).toBe(20);

    try {
      await parse(CreateUser, { email: 'nope', age: 1 }, 'user');
      throw new Error('expected a throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ValidationError);
      const shaped = error as ValidationError;
      expect(shaped.code).toBe('VLD_INVALID');
      expect(shaped.kind).toBe('validation');
      expect(shaped.issues.length).toBeGreaterThanOrEqual(2);
      expect(shaped.message).toBe('Invalid user');
      expect(shaped.context?.issues).toBe(shaped.issues.length);
      // The error shape is log-safe: issues carry messages, never raw values.
      expect(JSON.stringify(shaped.toLogObject())).not.toContain('nope');
    }
  });
});

describe('validate · issue normalization', () => {
  test('the same failure normalizes identically across validators', () => {
    const zodIssues = normalizeIssues([
      { message: 'Too small: expected number to be >=18', path: ['age'] },
    ]);
    const handmadeIssues = normalizeIssues([
      {
        message: 'Too small: expected number to be >=18',
        path: [{ key: 'age' }],
      },
    ]);

    expect(zodIssues).toEqual(handmadeIssues);
    expect(zodIssues[0]?.code).toBe('too_small');
  });

  test('issue codes are inferred from the message class', () => {
    const cases: readonly (readonly [string, IssueCode])[] = [
      ['Too big: expected string to have <=3 characters', 'too_big'],
      ['Invalid email address', 'invalid_format'],
      ['Invalid option: expected one of "a"|"b"', 'invalid_value'],
      ['Required', 'missing'],
      ['Invalid input: expected object, received string', 'invalid_type'],
      ['something else entirely', 'custom'],
    ];

    for (const [message, code] of cases) {
      expect(normalizeIssues([{ message }])[0]?.code).toBe(code);
    }
  });

  test('missing paths become an empty array, and symbol keys are stringified', () => {
    const issues = normalizeIssues([
      { message: 'root failure' },
      { message: 'symbol key', path: [Symbol('token')] },
    ]);

    expect(issues[0]?.path).toEqual([]);
    expect(issues[1]?.path).toEqual(['token']);
    expect(formatIssues(issues)).toBe('root failure\ntoken: symbol key');
  });

  test('absurdly long messages are truncated, not passed through', () => {
    const long = 'x'.repeat(5_000);
    const [issue] = normalizeIssues([{ message: long }]);

    expect(issue?.message).toHaveLength(501);
    expect(issue?.message.endsWith('…')).toBe(true);
  });

  test('formatIssues degrades gracefully with nothing to report', () => {
    expect(formatIssues([])).toBe('no issues');
  });
});

describe('validate · unknown-key policy (VLD-005)', () => {
  test('strip is the default: extras are dropped, not rejected', async () => {
    const schema = objectOf({ name: z.string() });
    expect(unknownKeysPolicy(schema)).toBe('strip');
    const result = await validate(schema, { name: 'ada', role: 'admin' });
    expect(result).toEqual({ ok: true, value: { name: 'ada' } });
  });

  test('strict rejects extras, and says which key', async () => {
    const schema = objectOf({ name: z.string() }, { unknownKeys: 'strict' });
    expect(unknownKeysPolicy(schema)).toBe('strict');
    const result = await validate(schema, { name: 'ada', role: 'admin' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.issues.some(
        (issue) => String(issue.path).includes('role') || issue.message.includes('role'),
      ),
    ).toBe(true);
  });

  test('passthrough keeps extras', async () => {
    const schema = objectOf({ name: z.string() }, { unknownKeys: 'passthrough' });
    expect(unknownKeysPolicy(schema)).toBe('passthrough');
    const result = await validate(schema, { name: 'ada', role: 'admin' });
    expect(result.ok).toBe(true);
    // `role` survives passthrough — the point of the policy.
    // Asserted as a record: the static type is the schema's output, which does
    // not know about the extra key the policy let through.
    expect(result.ok ? (result.value as Record<string, unknown>) : undefined).toEqual({
      name: 'ada',
      role: 'admin',
    });
  });

  test('the policy is readable for schemas built with plain Zod', () => {
    expect(unknownKeysPolicy(z.strictObject({ a: z.string() }))).toBe('strict');
    expect(unknownKeysPolicy(z.looseObject({ a: z.string() }))).toBe('passthrough');
    expect(unknownKeysPolicy(z.string())).toBeUndefined();
  });

  test('withUnknownKeys applies a policy to an existing schema', async () => {
    const schema = withUnknownKeys(z.object({ a: z.string() }), 'strict');
    expect(unknownKeysPolicy(schema)).toBe('strict');
    expect((await validate(schema, { a: 'x', b: 1 })).ok).toBe(false);
  });
});

describe('validate · no implicit coercion (VLD-007)', () => {
  // The rule: a schema that wants a number says so via an explicit transform
  // (`IntParam`). Nothing in the framework turns `"42"` into `42` behind the
  // caller's back, because that makes a typo ("4O") and a value ("40") the same
  // request.
  const explicit = z
    .string()
    .regex(/^-?\d+$/)
    .transform((value) => Number(value));

  test('a numeric string is not a number without an explicit transform', async () => {
    expect((await validate(z.number(), '42')).ok).toBe(false);
    expect((await validate(z.number(), '42')).ok ? undefined : 'rejected').toBe('rejected');
  });

  test('an explicit transform accepts only the exact shape it declares', async () => {
    for (const accepted of ['42', '-7', '0']) {
      expect((await validate(explicit, accepted)).ok).toBe(true);
    }
    for (const rejected of ['4.2', ' 3', '3 ', '1e3', '0x10', '', 'NaN', 'Infinity', '４２']) {
      expect((await validate(explicit, rejected)).ok).toBe(false);
    }
  });

  test('booleans are not parsed from strings or numbers', async () => {
    for (const value of ['true', 'false', '1', '0', 1]) {
      expect((await validate(z.boolean(), value)).ok).toBe(false);
    }
  });

  test('a string schema never receives a number, even when they look alike', async () => {
    expect((await validate(z.string(), 42)).ok).toBe(false);
    expect((await validate(z.string(), null)).ok).toBe(false);
  });

  test('dates are not coerced from strings or timestamps', async () => {
    expect((await validate(z.date(), '2024-01-01')).ok).toBe(false);
    expect((await validate(z.date(), 1_700_000_000_000)).ok).toBe(false);
  });

  test('arrays are not wrapped: a single value is not a list of one', async () => {
    expect((await validate(z.array(z.string()), 'a')).ok).toBe(false);
    expect((await validate(z.array(z.string()), 'a')).ok ? undefined : 'rejected').toBe('rejected');
  });
});
