/**
 * `readSetup` reads the emulator's own credential layout, so it is tested where it ships.
 *
 * The table it is printed beside has its own gate at `src/tools/emulator-check.test.ts`: the
 * selector, the derived verdicts and the completeness scan are all questions about *this
 * repository's* source and the emulator's vendored handlers, and none of them ships with
 * `@tsir/console`. Keeping the two files apart keeps that boundary visible — a test here may only
 * reach for what an application can also reach for.
 */

import { describe, expect, test } from 'bun:test';

import { readSetup } from './emulator.ts';

describe('readSetup · the emulator’s own credential layout', () => {
  test('an absent home directory is `undefined`, not a throw', () => {
    expect(readSetup('/nonexistent-home', 9297)).toBeUndefined();
  });
});
