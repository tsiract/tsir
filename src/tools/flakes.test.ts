import { describe, expect, test } from 'bun:test';
import { checkFlakes, daysBetween, MAX_DAYS, validateRegistry } from './flakes.ts';

const entry = (overrides: Record<string, unknown> = {}) => ({
  test: 'queue > retries with jitter',
  owner: 'queue team',
  since: '2026-10-20',
  reason: 'timing-dependent assertion',
  ...overrides,
});

describe('flake quarantine (TST-018)', () => {
  test('an empty quarantine is clean', () => {
    expect(checkFlakes({ quarantined: [] }, '2026-10-30').problems).toEqual([]);
  });

  test('an entry within the limit is allowed', () => {
    const today = `2026-10-${String(20 + MAX_DAYS).padStart(2, '0')}`;

    expect(checkFlakes({ quarantined: [entry()] }, today).problems).toEqual([]);
  });

  test('an entry past the limit fails and names the test, owner and age', () => {
    const { problems } = checkFlakes({ quarantined: [entry()] }, '2026-10-30');

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('queue > retries with jitter');
    expect(problems[0]).toContain('queue team');
    expect(problems[0]).toContain('10 days');
  });

  test('a missing field is a problem, not a silent skip', () => {
    const { problems, entries } = validateRegistry({ quarantined: [entry({ owner: '' })] });

    expect(entries).toEqual([]);
    expect(problems).toEqual(['quarantined[0] needs a non-empty "owner"']);
  });

  test('a since that is not a date is a problem', () => {
    const { problems } = checkFlakes(
      { quarantined: [entry({ since: 'last tuesday' })] },
      '2026-10-30',
    );

    expect(problems[0]).toContain('is not a date');
  });

  test('a registry without a quarantined array is refused', () => {
    expect(validateRegistry({}).problems).toEqual(['flakes.json needs a "quarantined" array']);
    expect(validateRegistry(null).problems).toHaveLength(1);
  });

  test('daysBetween counts whole days', () => {
    expect(daysBetween('2026-10-20', '2026-10-27')).toBe(7);
    expect(daysBetween('2026-10-27', '2026-10-20')).toBe(-7);
  });
});
