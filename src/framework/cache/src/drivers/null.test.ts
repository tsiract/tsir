/**
 * The `null` driver against the conformance kit (`CAP-005`), in its `never-store` shape.
 *
 * This is the one driver whose *contract* is to miss: it exists so a test can ask "does this
 * code path depend on cache warmth?" and get a truthful answer. Running it through the ordinary
 * `store` cases would be asking the wrong question, and passing them would mean the driver had
 * quietly started caching.
 */

import { describe, expect, test } from 'bun:test';

import { conformanceCases } from '../conformance.ts';
import { nullDriver } from './null.ts';

describe('null driver', () => {
  test('the conformance kit passes in its never-store shape', async () => {
    for (const conformanceCase of conformanceCases({
      driver: nullDriver(),
      store: 'null',
      behaviour: 'never-store',
    })) {
      await conformanceCase.run();
    }
  });

  test('increment is refused rather than returning a counter that never moves', () => {
    // A `0` here is what makes a rate limiter pass its tests and fail in production.
    expect(nullDriver().capabilities.increment).toBe(false);
  });
});
