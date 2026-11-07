import { describe, expect, test } from 'bun:test';
import { createFeatureManager, evaluate, memoryStore, type FeatureDefinition } from './index.ts';

const defs: FeatureDefinition[] = [
  { name: 'on', rule: { type: 'boolean', value: true } },
  { name: 'off', rule: { type: 'boolean', value: false } },
  { name: 'pct50', rule: { type: 'percentage', value: 50 } },
  { name: 'allow', rule: { type: 'allowlist', users: ['u_1', 'u_2'], segments: ['beta'] } },
];

describe('pennant', () => {
  test('boolean rules', () => {
    const on = defs[0];
    const off = defs[1];
    expect(on !== undefined && evaluate(on.rule, {})).toBe(true);
    expect(off !== undefined && evaluate(off.rule, {})).toBe(false);
  });

  test('percentage is deterministic per user', () => {
    const pct = defs[2];
    if (pct === undefined) throw new Error('missing');
    const a = evaluate(pct.rule, { userId: 'u_1' });
    const b = evaluate(pct.rule, { userId: 'u_1' });
    expect(a).toBe(b);
  });

  test('percentage returns false without a user', () => {
    const pct = defs[2];
    if (pct === undefined) throw new Error('missing');
    expect(evaluate(pct.rule, {})).toBe(false);
  });

  test('allowlist by user id', () => {
    const allow = defs[3];
    if (allow === undefined) throw new Error('missing');
    expect(evaluate(allow.rule, { userId: 'u_1' })).toBe(true);
    expect(evaluate(allow.rule, { userId: 'u_999' })).toBe(false);
  });

  test('allowlist by segment', () => {
    const allow = defs[3];
    if (allow === undefined) throw new Error('missing');
    expect(evaluate(allow.rule, { segments: ['beta'] })).toBe(true);
    expect(evaluate(allow.rule, { segments: ['alpha'] })).toBe(false);
  });

  test('manager resolves unknown flags to false', async () => {
    const m = createFeatureManager(memoryStore(defs));
    expect(await m.active('nope')).toBe(false);
  });

  test('manager resolves known flags', async () => {
    const m = createFeatureManager(memoryStore(defs));
    expect(await m.active('on')).toBe(true);
    expect(await m.active('off')).toBe(false);
  });

  test('manager can define new flags', async () => {
    const m = createFeatureManager(memoryStore());
    await m.define({ name: 'new', rule: { type: 'boolean', value: true } });
    expect(await m.active('new')).toBe(true);
  });

  test('conditional rule', () => {
    const rule = {
      type: 'conditional' as const,
      check: (ctx: { segments?: readonly string[] }) => ctx.segments?.includes('vip') ?? false,
    };
    expect(evaluate(rule, { segments: ['vip'] })).toBe(true);
    expect(evaluate(rule, {})).toBe(false);
  });
});
