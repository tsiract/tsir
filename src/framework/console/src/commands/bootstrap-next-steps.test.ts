/**
 * `nextSteps` (CFG-117): the commands after a bootstrap, in a fixed order.
 *
 * The order is the contract. A user copies these lines, so a reordering is a visible change
 * and the snapshot below fails on it.
 */

import { describe, expect, test } from 'bun:test';

import { nextSteps } from './bootstrap.ts';

describe('nextSteps (CFG-117)', () => {
  test('plan → build → validate, with the targets in the order given', () => {
    expect(nextSteps({ targets: ['cloudflare', 'lambda'], ract: false })).toEqual([
      'tsir deploy:plan --explain',
      'tsir deploy:build --target cloudflare,lambda',
      'tsir deploy:validate',
    ]);
  });

  test('no declared target falls back to bun', () => {
    expect(nextSteps({ targets: [], ract: false })[1]).toBe('tsir deploy:build --target bun');
  });

  test('ract is last, and only when bootstrap created it', () => {
    const steps = nextSteps({ targets: ['bun'], ract: true });
    expect(steps.at(-1)).toBe('bun ract help');
    expect(nextSteps({ targets: ['bun'], ract: false })).not.toContain('bun ract help');
  });

  test('the same input always gives the same output', () => {
    const input = { targets: ['lambda'], ract: true } as const;
    expect(nextSteps(input)).toEqual(nextSteps(input));
  });
});
