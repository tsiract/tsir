import { describe, expect, test } from 'bun:test';

import { assertRuntime, atLeast, checkVersions, MINIMUM } from './runtime.ts';

describe('console · runtime floor', () => {
  test('version comparison is numeric, not lexicographic', () => {
    // The bug this guards: "1.10.0" < "1.9.0" as strings, and only Bun 1.10
    // would ever notice.
    expect(atLeast('1.10.0', '1.9.0')).toBe(true);
    expect(atLeast('1.9.0', '1.10.0')).toBe(false);
    expect(atLeast('1.2.0', '1.2.0')).toBe(true);
    expect(atLeast('1.2', '1.2.0')).toBe(true);
  });

  test('below-floor runtimes are reported per runtime, with both versions', () => {
    expect(checkVersions({ bun: '1.1.9' })).toEqual([
      { runtime: 'bun', required: MINIMUM.bun, actual: '1.1.9' },
    ]);
    expect(checkVersions({ bun: '1.2.0', node: '20.0.0' })).toEqual([
      { runtime: 'node', required: MINIMUM.node, actual: '20.0.0' },
    ]);
    expect(checkVersions({ bun: '1.4.4', node: '22.0.0' })).toEqual([]);
  });

  test('assertRuntime fails with an actionable message, not a stack trace', () => {
    expect(() => assertRuntime({ bun: '0.9.0' })).toThrow(/unsupported runtime/);
    expect(() => assertRuntime({ bun: '0.9.0' })).toThrow(/bun upgrade/);
    expect(() => assertRuntime({ bun: '1.4.4', node: '22.0.0' })).not.toThrow();
  });

  test('the running runtime clears its own floor', () => {
    expect(() => assertRuntime()).not.toThrow();
  });
});
