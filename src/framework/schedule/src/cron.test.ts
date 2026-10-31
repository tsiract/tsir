/**
 * Cron (`§ 4.6`).
 *
 * The parser is the part of this package that decides *when* work happens, so the tests are
 * about the two ways that goes wrong: an expression that silently means something else (a
 * starred step read as a plain range,
 * read as `0-5`), and a next-run search that answers a minute off — which nobody notices until a
 * nightly job lands on the wrong day.
 */

import { describe, expect, test } from 'bun:test';

import { isValidCron, matchesCron, nextRunAt, nextRuns, parseCron, toUtcCron } from './cron.ts';

/** `2026-03-09T04:05:00Z`, a Monday. Handy because every field is distinct. */
const MONDAY_0405 = Date.UTC(2026, 2, 9, 4, 5, 0);

describe('parseCron', () => {
  test('a plain five-field cron parses into the values it selects', () => {
    const spec = parseCron('0 9 * * 1-5');

    expect(spec.expression).toBe('0 9 * * 1-5');
    expect(spec.minutes).toEqual([0]);
    expect(spec.hours).toEqual([9]);
    expect(spec.daysOfMonth).toHaveLength(31);
    expect(spec.months).toHaveLength(12);
    expect(spec.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  test('a starred step is every quarter hour, not the first sixteen minutes', () => {
    // The classic misreading: a starred step starts at the field's minimum and steps.
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron('10-40/10 * * * *').minutes).toEqual([10, 20, 30, 40]);
    expect(parseCron('0,30 8-10 * * *').hours).toEqual([8, 9, 10]);
  });

  test('a bare number with a step means "from there to the maximum"', () => {
    expect(parseCron('5/20 * * * *').minutes).toEqual([5, 25, 45]);
  });

  test('7 is Sunday, stored as 0 so the two spellings cannot disagree', () => {
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([0]);
    expect(parseCron('0 0 * * 0').daysOfWeek).toEqual([0]);
  });

  test('the macros expand to their crons', () => {
    expect(parseCron('@daily').expression).toBe('0 0 * * *');
    expect(parseCron('@hourly').expression).toBe('0 * * * *');
    expect(parseCron('@weekly').expression).toBe('0 0 * * 0');
    expect(parseCron('@yearly').expression).toBe('0 0 1 1 *');
  });

  test('five fields are required — seconds are refused with the reason', () => {
    const error = (): unknown => {
      try {
        parseCron('0 0 9 * * 1');
      } catch (caught: unknown) {
        return caught;
      }
      return undefined;
    };

    expect(error()).toBeInstanceOf(TypeError);
    expect((error() as Error).message).toContain('6 field(s)');
    expect((error() as Error).message).toContain('seconds are not supported');
  });

  test('an out-of-range or malformed field names the field it came from', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/minute value "60" is outside 0–59/u);
    expect(() => parseCron('* 24 * * *')).toThrow(/hour value "24" is outside 0–23/u);
    expect(() => parseCron('* * 0 * *')).toThrow(/day-of-month value "0" is outside 1–31/u);
    expect(() => parseCron('* * * 13 *')).toThrow(/month value "13" is outside 1–12/u);
    expect(() => parseCron('* * * * 8')).toThrow(/day-of-week value "8" is outside 0–7/u);
    expect(() => parseCron('* * * * mon')).toThrow(/not a number in the day-of-week field/u);
  });

  test('`@reboot` is refused, with the reason a platform gives', () => {
    expect(() => parseCron('@reboot')).toThrow(/boots per request/u);
    expect(() => parseCron('@fortnightly')).toThrow(/unknown macro/u);
  });

  test('both day fields restricted is refused — crontab ORs them, Lambda cannot', () => {
    // `0 0 1 * 1` means "the 1st, or any Monday" in crontab and one of the two on AWS. A cron
    // whose meaning depends on the target is a build surprise, so it never parses.
    expect(() => parseCron('0 0 1 * 1')).toThrow(/both restricted/u);
    expect(() => parseCron('0 0 1 * 1')).toThrow(/two tasks/u);
    // One restricted, one `*`, is the shape every target agrees on.
    expect(() => parseCron('0 0 1 * *')).not.toThrow();
    expect(() => parseCron('0 0 * * 1')).not.toThrow();
  });

  test('the origin is named, so a bad cron in configuration says where it came from', () => {
    expect(() => parseCron('0 0 * *', { origin: 'tasks.nightly' })).toThrow(/\(tasks\.nightly\)/u);
  });

  test('isValidCron is the same parser without the throw', () => {
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('*/5 * * *')).toBe(false);
    expect(isValidCron('0 0 1 * 1')).toBe(false);
  });
});

describe('matchesCron', () => {
  test('it matches the minute it names and nothing around it', () => {
    const spec = parseCron('5 4 * * *');

    expect(matchesCron(spec, MONDAY_0405)).toBe(true);
    // Seconds inside the minute do not matter: a cron fires on the minute.
    expect(matchesCron(spec, MONDAY_0405 + 30_000)).toBe(true);
    expect(matchesCron(spec, MONDAY_0405 + 60_000)).toBe(false);
    expect(matchesCron(spec, MONDAY_0405 - 60_000)).toBe(false);
  });

  test('the day of week is read in the spec’s own offset, not the host’s', () => {
    // `2026-03-08T23:30Z` is Sunday in UTC and Monday 07:30 in UTC+8.
    const sundayLateUtc = Date.UTC(2026, 2, 8, 23, 30, 0);

    expect(matchesCron(parseCron('30 23 * * 0'), sundayLateUtc)).toBe(true);
    expect(matchesCron(parseCron('30 23 * * 1'), sundayLateUtc)).toBe(false);

    const manila = parseCron('30 7 * * 1', { utcOffsetMinutes: 480 });
    expect(matchesCron(manila, sundayLateUtc)).toBe(true);
  });
});

describe('nextRunAt', () => {
  test('a daily cron points at the next occurrence, not today’s', () => {
    const spec = parseCron('0 3 * * *');

    // Asking just after 03:00 gets tomorrow, not the same instant.
    expect(new Date(nextRunAt(spec, Date.UTC(2026, 2, 9, 3, 0, 0)) ?? 0).toISOString()).toBe(
      '2026-03-10T03:00:00.000Z',
    );
    expect(new Date(nextRunAt(spec, Date.UTC(2026, 2, 9, 1, 0, 0)) ?? 0).toISOString()).toBe(
      '2026-03-09T03:00:00.000Z',
    );
  });

  test('an every-minute cron steps exactly one minute', () => {
    const spec = parseCron('* * * * *');
    const from = Date.UTC(2026, 2, 9, 4, 5, 30);

    expect(nextRunAt(spec, from)).toBe(Date.UTC(2026, 2, 9, 4, 6, 0));
  });

  test('a weekday cron skips the weekend', () => {
    const spec = parseCron('0 9 * * 1-5');
    // Friday 2026-03-13 10:00 UTC → Monday the 16th.
    const next = nextRunAt(spec, Date.UTC(2026, 2, 13, 10, 0, 0)) ?? 0;

    expect(new Date(next).toISOString()).toBe('2026-03-16T09:00:00.000Z');
  });

  test('a yearly cron crosses the year boundary, and a leap day is reachable', () => {
    const yearly = parseCron('0 0 1 1 *');
    expect(new Date(nextRunAt(yearly, Date.UTC(2026, 5, 1)) ?? 0).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );

    // 2028 is a leap year; the previous leap day was 2024.
    const leap = parseCron('0 0 29 2 *');
    expect(new Date(nextRunAt(leap, Date.UTC(2026, 0, 1)) ?? 0).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  test('a calendar no year can satisfy returns undefined instead of spinning', () => {
    expect(nextRunAt(parseCron('0 0 30 2 *'), Date.UTC(2026, 0, 1))).toBeUndefined();
  });

  test('the offset moves the wall clock, so a 9am task is 9am where it says', () => {
    const manila = parseCron('0 9 * * *', { utcOffsetMinutes: 480 });

    // 09:00 in UTC+8 is 01:00 UTC.
    expect(new Date(nextRunAt(manila, Date.UTC(2026, 2, 9, 0, 30)) ?? 0).toISOString()).toBe(
      '2026-03-09T01:00:00.000Z',
    );
  });

  test('nextRuns returns the sequence, and stops when the calendar does', () => {
    const runs = nextRuns(parseCron('0 0 * * *'), Date.UTC(2026, 2, 9, 12, 0), 3);

    expect(runs.map((run) => new Date(run).toISOString())).toEqual([
      '2026-03-10T00:00:00.000Z',
      '2026-03-11T00:00:00.000Z',
      '2026-03-12T00:00:00.000Z',
    ]);
    expect(nextRuns(parseCron('0 0 30 2 *'), 0, 3)).toEqual([]);
  });
});

describe('toUtcCron (§ 4.6, deploy)', () => {
  const utc = (expression: string, offset: number): string =>
    toUtcCron(parseCron(expression, { utcOffsetMinutes: offset }));

  test('no offset is the expression as written', () => {
    expect(utc('0 3 * * *', 0)).toBe('0 3 * * *');
  });

  test('a whole-hour offset shifts the hour and keeps the rest', () => {
    expect(utc('0 11 * * *', 480)).toBe('0 3 * * *');
    expect(utc('30 3 * * *', 480)).toBe('30 19 * * *');
    expect(utc('0 3 * * *', -300)).toBe('0 8 * * *');
  });

  test('a set of hours shifts as a set, and stays readable', () => {
    expect(utc('0 17-19 * * *', 480)).toBe('0 9-11 * * *');
    expect(utc('0 17-21 * * 1-5', 480)).toBe('0 9-13 * * 1-5');
  });

  test('a shift across midnight is fine for a daily cron and refused for a dated one', () => {
    // 03:00 in Manila is 19:00 UTC the previous day. "19:00 UTC daily" is "03:00 Manila daily",
    // so the shift is exact. On the 1st it is not: the UTC fire lands on the previous month's
    // last day, and a platform cannot express "the 1st, Manila time".
    expect(utc('0 3 * * *', 480)).toBe('0 19 * * *');
    expect(() => utc('0 3 1 * *', 480)).toThrow(/names a day/u);
    expect(() => utc('0 3 * * 1', 480)).toThrow(/names a day/u);
  });

  test('a half-hour offset is refused unless the cron fires every minute anyway', () => {
    // UTC+5:30 moves the minute field by 30, which is a rotation of the minute set — fine only
    // when the set is every minute of every hour.
    expect(() => utc('0 3 * * *', 330)).toThrow(/not a whole number of hours/u);
    expect(() => utc('0 3 * * *', -210)).toThrow(/whole number of hours/u);
    expect(utc('* * * * *', 330)).toBe('* * * * *');
  });

  test('an every-hour cron is unchanged: its hour field is already `*`', () => {
    expect(utc('15 * * * *', 480)).toBe('15 * * * *');
  });
});
