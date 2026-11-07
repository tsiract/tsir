/**
 * Cron, parsed (`§ 4.6`).
 *
 * Five fields, no seconds, and the shapes that actually appear in a `tsir.js`: a star, a star
 * with a step, a number, a range, a range with a step, and comma lists of those. Plus the macros
 * everyone types (`@daily`). Nothing
 * else — `@reboot` has no meaning on a platform that boots per request, and six fields mean a
 * different parser on every target.
 *
 * Four decisions are made here rather than left to whichever scheduler the platform ships:
 *
 *   · **Time is UTC.** A cron that followed the host's clock would fire at a different hour in
 *     development and in production, and `TZ` is exactly the kind of setting that is right on one
 *     machine. A task that needs a business-local hour declares `utcOffsetMinutes` — a fixed
 *     number, testable, and the same in every region.
 *   · **A cron is evaluated in whole minutes.** `matches` truncates to the minute, because every
 *     target fires crons on minute boundaries and a sub-minute cron is a six-field cron.
 *   · **Both day fields restricted is refused** (`dayOfMonth` *and* `dayOfWeek`, neither `*`).
 *     Crontab reads that as OR; AWS reads it as "pick one" and needs `?` in the other. A cron
 *     whose meaning depends on the target is a build surprise, so it is a declaration error with
 *     the two-task fix in the message.
 *   · **`nextRunAt` is bounded.** Five years, which is enough for a leap day and short enough that
 *     a typo (`0 0 30 2 *`) returns `undefined` instead of spinning.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Five years of days: enough for a 29 February, short enough to fail fast. */
const DAY_HORIZON = 366 * 5;

export const CRON_FIELDS = 5 as const;

/** `0 9 * * 1`-shaped input, or one of the macros. */
export interface CronSpec {
  /** The canonical five-field form; macros are expanded, whitespace collapsed. */
  readonly expression: string;
  /** Minutes of the hour, 0–59. */
  readonly minutes: readonly number[];
  /** Hours of the day, 0–23 — **UTC**, plus the task's offset when it has one. */
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  /** 0–6, Sunday is 0. A literal `7` is accepted as Sunday and stored as `0`. */
  readonly daysOfWeek: readonly number[];
  /** The task asked for a fixed offset from UTC, in minutes. `480` is UTC+8. */
  readonly utcOffsetMinutes: number;
  /**
   * An IANA timezone (`America/New_York`), evaluated per tick so DST is honoured.
   *
   * When set it overrides `utcOffsetMinutes` for matching: the offset is recomputed at every
   * instant via `Intl.DateTimeFormat`, so a `0 9 * * *` task in `Europe/London` fires at 09:00
   * GMT in winter and 09:00 BST in summer — the wall clock the business reads, not a fixed shift.
   */
  readonly timezone?: string | undefined;
}

export interface ParseCronOptions {
  readonly utcOffsetMinutes?: number | undefined;
  readonly timezone?: string | undefined;
  /** Where the expression came from, so a bad one in `tsir.js` names its field. */
  readonly origin?: string | undefined;
}

const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/** What each field means: its name, its bounds, and whether it accepts a range. */
const LIMITS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
] as const;

type Limit = (typeof LIMITS)[number];

function invalidCron(expression: string, detail: string, origin: string | undefined): TypeError {
  return new TypeError(
    `invalid cron "${expression}"${origin === undefined ? '' : ` (${origin})`}: ${detail}`,
  );
}

/** A star, a step, a number, a range, or a comma list of those → the sorted values. */
function parseField(field: string, limit: Limit, expression: string, origin?: string): number[] {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    if (part === '') {
      throw invalidCron(expression, `empty entry in the ${limit.name} list`, origin);
    }

    const [range = '', stepText] = part.split('/');
    let step = 1;
    if (stepText !== undefined) {
      // coercion-ok: a cron field is text; `Number.isInteger` below rejects "" and "1.5"
      // rather than folding them into the schedule.
      step = Number(stepText);
      if (!Number.isInteger(step) || step < 1) {
        throw invalidCron(
          expression,
          `the ${limit.name} step in "${part}" is not a positive integer`,
          origin,
        );
      }
    }

    let from: number;
    let to: number;
    if (range === '*') {
      from = limit.min;
      to = limit.max;
    } else if (range.includes('-')) {
      const [lo = '', hi = ''] = range.split('-');
      // coercion-ok: as above — digits from a validated cron field, checked by `isInteger`.
      from = Number(lo);
      to = Number(hi);
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        throw invalidCron(
          expression,
          `"${range}" is not a range in the ${limit.name} field`,
          origin,
        );
      }
    } else {
      // coercion-ok: a single cron value, checked by `isInteger` on the next line.
      from = Number(range);
      to = stepText === undefined ? from : limit.max;
      if (!Number.isInteger(from)) {
        throw invalidCron(
          expression,
          `"${part}" is not a number in the ${limit.name} field`,
          origin,
        );
      }
    }

    if (from < limit.min || to > limit.max || from > to) {
      throw invalidCron(
        expression,
        `the ${limit.name} value "${part}" is outside ${String(limit.min)}–${String(limit.max)}`,
        origin,
      );
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }

  return [...values].sort((a, b) => a - b);
}

/**
 * Parse and validate. Throws a `TypeError` naming the field — a cron is a declaration, and the
 * caller's next move is to edit the line they are looking at.
 */
export function parseCron(expression: string, options: ParseCronOptions = {}): CronSpec {
  const origin = options.origin;
  const trimmed = expression.trim().toLowerCase();
  const expanded = MACROS[trimmed] ?? trimmed;
  const fields = expanded.split(/\s+/u).filter((field) => field !== '');

  if (MACROS[trimmed] === undefined && trimmed.startsWith('@')) {
    throw invalidCron(
      expression,
      trimmed === '@reboot'
        ? '`@reboot` means nothing on a platform that boots per request — use `@daily` or an explicit cron'
        : `unknown macro; the ones that exist are ${Object.keys(MACROS).join(', ')}`,
      origin,
    );
  }
  if (fields.length !== CRON_FIELDS) {
    throw invalidCron(
      expression,
      `${String(fields.length)} field(s); a cron has 5 (minute hour day-of-month month day-of-week)` +
        (fields.length === 6
          ? ' — seconds are not supported, and every target truncates them anyway'
          : ''),
      origin,
    );
  }

  const [minuteField = '', hourField = '', domField = '', monthField = '', dowField = ''] = fields;
  const [minuteLimit, hourLimit, domLimit, monthLimit, dowLimit] = LIMITS as readonly [
    Limit,
    Limit,
    Limit,
    Limit,
    Limit,
  ];

  const timezone = options.timezone;
  if (timezone !== undefined) {
    // Validate by constructing a formatter — an unknown zone throws `RangeError` here, at
    // declaration time, rather than at the first tick when the only symptom is a task that
    // never ran. `supportedValuesOf` is not available on every runtime, so the try/catch is
    // the portable check.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw invalidCron(expression, `timezone "${timezone}" is not a recognised IANA zone`, origin);
    }
  }

  const daysOfWeek = parseField(dowField, dowLimit, expression, origin).map((day) =>
    day === 7 ? 0 : day,
  );

  // Crontab ORs the two day fields when both are restricted; AWS needs `?` and picks one. A cron
  // whose meaning depends on the target is refused here rather than translated into whichever
  // meaning the emitter happens to encode.
  if (domField !== '*' && dowField !== '*') {
    throw invalidCron(
      expression,
      'day-of-month and day-of-week are both restricted — crontab reads that as OR and Lambda cannot ' +
        'express it; write two tasks (one per day rule) instead',
      origin,
    );
  }

  return {
    expression: [minuteField, hourField, domField, monthField, dowField].join(' '),
    minutes: parseField(minuteField, minuteLimit, expression, origin),
    hours: parseField(hourField, hourLimit, expression, origin),
    daysOfMonth: parseField(domField, domLimit, expression, origin),
    months: parseField(monthField, monthLimit, expression, origin),
    daysOfWeek,
    utcOffsetMinutes: options.utcOffsetMinutes ?? 0,
    ...(timezone === undefined ? {} : { timezone }),
  };
}

/** `parseCron` without the throw: for a value that came from configuration. */
export function isValidCron(expression: string, options: ParseCronOptions = {}): boolean {
  try {
    parseCron(expression, options);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock parts of an instant. */
interface WallClock {
  readonly minute: number;
  readonly hour: number;
  readonly dayOfMonth: number;
  readonly month: number;
  readonly dayOfWeek: number;
}

/**
 * Formatters are cached per timezone: `nextRunAt` calls `wallClock` in a tight loop, and
 * constructing an `Intl.DateTimeFormat` on every iteration would dominate the cost. A handful
 * of zones per process is the realistic upper bound.
 */
const tzFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = tzFormatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
      hour12: false,
    });
    tzFormatters.set(timezone, formatter);
  }
  return formatter;
}

/**
 * The wall-clock parts of `at` in an IANA timezone, via `formatToParts`.
 *
 * `hour12: false` yields `0`–`23` on every runtime we target; the `24` guard is defence in
 * depth against an ICU quirk where midnight has rendered as `24`.
 */
function wallClockInTimezone(timezone: string, at: number): WallClock {
  const parts = formatterFor(timezone).formatToParts(new Date(at));
  const value = (type: string): number => {
    const part = parts.find((entry) => entry.type === type);
    // coercion-ok: `formatToParts` emits numeric strings for these types; `Number` is the
    // documented conversion and the fields are bounded by the calendar.
    return part === undefined ? 0 : Number(part.value);
  };
  let hour = value('hour');
  if (hour === 24) hour = 0;
  // `weekday` is "Mon".."Sun"; map to 0..6 with Sunday = 0 to match `getUTCDay`.
  const weekday = parts.find((entry) => entry.type === 'weekday')?.value ?? 'Sun';
  const dayOfWeek = WEEKDAY_INDEX[weekday] ?? 0;
  return {
    minute: value('minute'),
    hour,
    dayOfMonth: value('day'),
    month: value('month'),
    dayOfWeek,
  };
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * The offset of an IANA timezone at an instant, in minutes (local = UTC + offset).
 *
 * Reconstructed from the wall clock `formatToParts` reports, because `Intl` exposes the
 * formatted local time but not the raw offset — and the difference between the reconstructed
 * UTC instant and `at` *is* the offset.
 */
export function timezoneOffsetAt(timezone: string, at: number): number {
  const parts = formatterFor(timezone).formatToParts(new Date(at));
  const value = (type: string): number => {
    const part = parts.find((entry) => entry.type === type);
    // coercion-ok: numeric strings from `formatToParts`, calendar-bounded.
    return part === undefined ? 0 : Number(part.value);
  };
  let hour = value('hour');
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    hour,
    value('minute'),
    value('second'),
  );
  return Math.round((asUtc - at) / MINUTE);
}

/**
 * Whether an IANA timezone observes DST: the offset differs between a northern-hemisphere
 * winter and summer instant. Zones near the equator (and `Etc/GMT*`) are fixed.
 */
function timezoneHasDst(timezone: string): boolean {
  const winter = timezoneOffsetAt(timezone, Date.UTC(2026, 0, 1));
  const summer = timezoneOffsetAt(timezone, Date.UTC(2026, 6, 1));
  return winter !== summer;
}

/** The wall-clock parts of an instant, in the spec's own offset or timezone. */
function wallClock(spec: CronSpec, at: number): WallClock {
  if (spec.timezone !== undefined) {
    return wallClockInTimezone(spec.timezone, at);
  }
  // A fixed offset, so this is arithmetic rather than a calendar library: `utcOffsetMinutes`
  // shifts the instant and the UTC getters then read the local wall clock.
  const date = new Date(at + spec.utcOffsetMinutes * MINUTE);
  return {
    minute: date.getUTCMinutes(),
    hour: date.getUTCHours(),
    dayOfMonth: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    dayOfWeek: date.getUTCDay(),
  };
}

/** Exactly one day field is `*` (the parser refuses the other case), so this is not an OR. */
function dayMatches(spec: CronSpec, wall: { dayOfMonth: number; dayOfWeek: number }): boolean {
  return spec.daysOfMonth.length < 31
    ? spec.daysOfMonth.includes(wall.dayOfMonth)
    : spec.daysOfWeek.includes(wall.dayOfWeek);
}

/** Does the cron fire at this instant? Truncates to the minute; `at` is epoch ms. */
export function matchesCron(spec: CronSpec, at: number): boolean {
  const wall = wallClock(spec, at);
  return (
    spec.minutes.includes(wall.minute) &&
    spec.hours.includes(wall.hour) &&
    spec.months.includes(wall.month) &&
    dayMatches(spec, wall)
  );
}

/**
 * The first instant strictly after `after` at which the cron fires.
 *
 * Four skips, coarsest first — a month, a day, an hour, a minute — so a `0 0 1 1 *` cron costs a
 * few hundred cheap comparisons instead of half a million minute steps. Because the offset is
 * fixed, the wall clock moves linearly and each skip is arithmetic.
 *
 * `undefined` when there is none within five years, which for a valid five-field cron means the
 * calendar cannot satisfy it (`0 0 30 2 *`: 30 February).
 */
export function nextRunAt(spec: CronSpec, after: number): number | undefined {
  const limit = after + DAY_HORIZON * DAY;
  // The first whole minute after `after`: a cron fires at the start of its minute.
  let at = Math.floor(after / MINUTE) * MINUTE + MINUTE;

  while (at <= limit) {
    const wall = wallClock(spec, at);
    if (!spec.months.includes(wall.month) || !dayMatches(spec, wall)) {
      // Next local midnight: the same offset arithmetic every day, DST-free by construction.
      at += DAY - (wall.hour * HOUR + wall.minute * MINUTE);
      continue;
    }
    if (!spec.hours.includes(wall.hour)) {
      at += HOUR - wall.minute * MINUTE;
      continue;
    }
    if (!spec.minutes.includes(wall.minute)) {
      at += MINUTE;
      continue;
    }
    return at;
  }

  return undefined;
}

/**
 * The next `count` runs, for `tsir schedule:list`. Bounded, and each step is a real search, so a
 * cron that fires every minute cannot print a million lines by accident.
 */
export function nextRuns(spec: CronSpec, after: number, count = 3): readonly number[] {
  const runs: number[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    const next = nextRunAt(spec, cursor);
    if (next === undefined) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
}

/**
 * The same cron written in UTC — what a platform cron needs (`§ 4.6`).
 *
 * Workers and EventBridge fire in UTC and take no offset, while a task may be declared in a
 * business-local hour (`0 3 * * *` at `utcOffsetMinutes: 480` is 3 AM in Manila, 19:00 UTC).
 * Emitting the declared expression unchanged is a fire eight hours early in production and on
 * time in every test, so the shift happens here, once, where the graph can show it.
 *
 * The shift is only expressible when the calendar does not move under it:
 *
 *   · **a whole number of hours**, unless the cron matches every minute of every hour, where a
 *     minute rotation is still "every minute" — a UTC+5:30 offset moves the minute field, and
 *     a set of minutes cannot be rotated without also moving hours;
 *   · **no wrap past midnight across a day rule.** `0 3 * * *` at UTC+8 is 19:00 UTC on the
 *     previous day — and that is *fine*, because "19:00 UTC daily" is exactly "03:00 Manila
 *     daily": the same instants, one label apart. It stops being fine the moment the cron names
 *     a day (`0 3 1 * *` is the 1st in Manila and the last day of the previous month in UTC), so
 *     that combination is refused rather than shifted onto the wrong day.
 *
 * Refused, not approximated: an expression the platform would fire at a different moment is the
 * failure this function exists to prevent.
 */
export function toUtcCron(spec: CronSpec): string {
  // An IANA timezone with DST has no single UTC equivalent: the offset moves twice a year, so a
  // fixed UTC cron would fire an hour off for half the year. Refuse rather than emit the wrong
  // trigger — the scheduler still evaluates such tasks itself (`runDue`), which is the correct
  // path for a DST-aware schedule. A fixed-offset zone (`Etc/GMT-8`, `Asia/Manila`) is converted
  // just like `utcOffsetMinutes`.
  if (spec.timezone !== undefined) {
    if (timezoneHasDst(spec.timezone)) {
      throw invalidCron(
        spec.expression,
        `timezone "${spec.timezone}" observes DST, so it cannot be expressed as a single UTC cron ` +
          '— run the task through the scheduler (`schedule:work` / a `scheduled` handler) ' +
          'instead of delegating the trigger to the platform',
        undefined,
      );
    }
    const offset = timezoneOffsetAt(spec.timezone, Date.UTC(2026, 0, 1));
    return toUtcCronWithOffset(spec, offset);
  }

  const offset = spec.utcOffsetMinutes;
  if (offset === 0) return spec.expression;
  return toUtcCronWithOffset(spec, offset);
}

/**
 * Shift a five-field cron from a fixed local offset into UTC.
 *
 * Workers and EventBridge fire in UTC and take no offset, while a task may be declared in a
 * business-local hour (`0 3 * * *` at offset 480 is 3 AM in Manila, 19:00 UTC). Emitting the
 * declared expression unchanged is a fire eight hours early in production and on time in every
 * test, so the shift happens here, once, where the graph can show it.
 *
 * The shift is only expressible when the calendar does not move under it:
 *
 *   · **a whole number of hours**, unless the cron matches every minute of every hour, where a
 *     minute rotation is still "every minute" — a UTC+5:30 offset moves the minute field, and
 *     a set of minutes cannot be rotated without also moving hours;
 *   · **no wrap past midnight across a day rule.** `0 3 * * *` at UTC+8 is 19:00 UTC on the
 *     previous day — and that is *fine*, because "19:00 UTC daily" is exactly "03:00 Manila
 *     daily": the same instants, one label apart. It stops being fine the moment the cron names
 *     a day (`0 3 1 * *` is the 1st in Manila and the last day of the previous month in UTC), so
 *     that combination is refused rather than shifted onto the wrong day.
 *
 * Refused, not approximated: an expression the platform would fire at a different moment is the
 * failure this function exists to prevent.
 */
function toUtcCronWithOffset(spec: CronSpec, offset: number): string {
  const minutes = -offset;
  const hourShift = Math.floor(minutes / 60);
  const minuteShift = minutes - hourShift * 60;

  const everyMinute = spec.minutes.length === 60 && spec.hours.length === 24;
  if (minuteShift !== 0 && !everyMinute) {
    throw invalidCron(
      spec.expression,
      `utcOffsetMinutes ${String(offset)} is not a whole number of hours, so it moves the minute ` +
        'field — a platform cron fires in UTC and cannot carry it; write the UTC expression instead',
      undefined,
    );
  }

  const fields = spec.expression.split(' ');
  const [minuteField = '', , domField = '', monthField = '', dowField = ''] = fields;

  // Every hour that can match is already matching, so the hour field is `*` and no shift can
  // change it.
  if (everyMinute || spec.hours.length === 24) return spec.expression;

  const hours = spec.hours.map((hour) => hour + hourShift);
  const normalised = hours.map((hour) => ((hour % 24) + 24) % 24);

  // A wrap is harmless for a cron that fires every day (the instants are the same, one UTC day
  // label apart) and wrong for one that names a day — the 1st in Manila is the 31st in UTC.
  const namesADay = spec.daysOfMonth.length < 31 || spec.daysOfWeek.length < 7;
  if (namesADay && hours.some((hour) => hour < 0 || hour > 23)) {
    throw invalidCron(
      spec.expression,
      `utcOffsetMinutes ${String(offset)} moves hour(s) ${hours
        .filter((hour) => hour < 0 || hour > 23)
        .map((hour) => String(((hour % 24) + 24) % 24))
        .join(
          ', ',
        )} past midnight, and the cron names a day (${domField} ${monthField} ${dowField}) ` +
        'that would move with it; write the UTC expression instead',
      undefined,
    );
  }

  return [minuteField, formatField(normalised, 24), domField, monthField, dowField].join(' ');
}

/** A set back to five-field syntax: `*` when full, ranges when contiguous, else a list. */
function formatField(values: readonly number[], size: number): string {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === size) return '*';

  // Contiguous runs are the common case after a shift (`0,1,2,3` was `20-23`), and `a-b` keeps
  // the expression readable in `wrangler.toml` — which is where someone will read it at 3 AM.
  const parts: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const value of sorted.slice(1)) {
    if (value === (previous ?? 0) + 1) {
      previous = value;
      continue;
    }
    parts.push(start === previous ? String(start) : `${String(start)}-${String(previous)}`);
    start = value;
    previous = value;
  }
  if (start !== undefined) {
    parts.push(start === previous ? String(start) : `${String(start)}-${String(previous)}`);
  }
  return parts.join(',');
}
