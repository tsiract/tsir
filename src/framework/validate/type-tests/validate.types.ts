/**
 * Type-level tests for `@tsir/validate`.
 *
 * The guarantee: a schema's *output* type flows through, so a handler that
 * receives `body` gets `{ age: number }` and not `unknown` or the schema's
 * input type.
 */

import { z } from 'zod';

import { validate, validateSync, type InferOutput, type StandardSchemaV1 } from '../src/index.ts';

const User = z.object({
  email: z.email(),
  age: z.number(),
  nickname: z.string().optional(),
});

type User = InferOutput<typeof User>;

declare const maybeUser: Awaited<ReturnType<typeof validate<typeof User>>>;

if (maybeUser.ok) {
  const email: string = maybeUser.value.email;
  const age: number = maybeUser.value.age;

  // @ts-expect-error — nickname is optional, so it is `string | undefined`
  const nickname: string = maybeUser.value.nickname;

  void email;
  void age;
  void nickname;
} else {
  const first = maybeUser.issues[0];
  const path: readonly string[] = first?.path ?? [];
  void path;
}

const sync = validateSync(User, {});
// @ts-expect-error — sync results are not promises
void sync.then;

// A transform changes the output type; inference must follow it.
const Parsed = z.string().transform((raw) => raw.length);
type ParsedOutput = InferOutput<typeof Parsed>;
const length: ParsedOutput = 3;
void length;

// Structural check: a plain object is not a Standard Schema.
// @ts-expect-error — `{ validate: () => true }` is missing `~standard`
const notSchema: StandardSchemaV1 = { validate: () => true };
void notSchema;

declare const user: User;
void user;
