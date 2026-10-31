/**
 * The kit, run against every driver this package ships (`§ 5`).
 *
 * A conformance suite that nothing runs is documentation. This runs it against `memory` and
 * `null`, which are the two extremes: one supports everything, the other supports nothing and
 * must refuse loudly rather than pretend.
 */

import { describe, expect, test } from 'bun:test';

import { conformanceCases } from './conformance.ts';
import { memoryDriver } from './drivers/memory.ts';
import { nullDriver } from './drivers/null.ts';

const drivers = [
  { name: 'memory', driver: memoryDriver(), behaviour: 'store' },
  { name: 'null', driver: nullDriver(), behaviour: 'never-store' },
] as const;

for (const { name, driver, behaviour } of drivers) {
  describe(`driver conformance · ${name}`, () => {
    const cases = conformanceCases({ driver, store: name, behaviour });

    for (const conformanceCase of cases) {
      test(conformanceCase.name, () => conformanceCase.run());
    }

    test('the kit covers every capability flag this driver claims', () => {
      const names = cases.map((entry) => entry.name).join('\n');

      if (behaviour === 'never-store') {
        expect(names).toContain('every read misses');
        expect(names).toContain('counters and tags are refused');
        return;
      }

      expect(names).toContain('miss is undefined');
      expect(names).toContain('round-trip');
      expect(names).toContain(driver.capabilities.ttl ? 'zero TTL' : 'TTL is refused');
      expect(names).toContain(driver.capabilities.tags ? 'invalidating a tag' : 'tags are refused');
      expect(names).toContain(
        driver.capabilities.increment ? 'increment is atomic' : 'increment is refused',
      );
    });
  });
}
