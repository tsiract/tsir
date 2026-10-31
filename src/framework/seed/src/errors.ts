/**
 * Seed errors (`SED-008`). Codes are append-only: a rename is a deprecation, not an edit.
 */

import { TsirError } from '@tsir/core';

export type SeedErrorCode =
  | 'SED_FIXTURE_INVALID'
  | 'SED_FIXTURE_NO_INSERT'
  | 'SED_PRODUCTION_REFUSED'
  | 'SED_DUPLICATE_NAME'
  | 'SED_UNKNOWN_CLASS'
  | 'SED_ORDER_AMBIGUOUS'
  | 'SED_UNDECLARED_CONNECTION'
  | 'SED_FAILED'
  | 'SED_NOT_IDEMPOTENT'
  | 'SED_INVALID';

export function fixtureInvalid(message: string): TsirError {
  return new TsirError('SED_FIXTURE_INVALID', message, { kind: 'validation' });
}

export function fixtureNoInsert(message: string): TsirError {
  return new TsirError('SED_FIXTURE_NO_INSERT', message, {
    kind: 'validation',
    hint: 'pass `insert` to defineFixture, or use build() and insert the row yourself',
  });
}
