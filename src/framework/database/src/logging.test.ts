import { describe, expect, test } from 'bun:test';

import type { Clock } from '@tsir/core';

import { createDatabase } from './database.ts';
import { createD1Driver, type D1Like, type D1ResultLike, type D1StatementLike } from './d1.ts';
import { statement } from './driver.ts';
import {
  type DatabaseLogEvent,
  paramType,
  type QueryLogEvent,
  scrubSql,
  shouldLog,
} from './logging.ts';

/** A clock the test moves by hand, so `slowQueryMs` is measured, not slept. */
interface TestClock extends Clock {
  advance(ms: number): void;
}

function testClock(): TestClock {
  let monotonic = 0;
  return {
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    iso: () => '2026-01-01T00:00:00.000Z',
    monotonicMs: () => monotonic,
    advance: (ms: number) => {
      monotonic += ms;
    },
  };
}

/**
 * A D1 binding that answers with scripted rows, reports failures as data (as
 * D1 does), and can move the clock to simulate a slow statement.
 */
function fakeD1(options: { readonly onQuery?: () => void } = {}): D1Like {
  class Prepared implements D1StatementLike {
    #sql: string;

    constructor(query: string) {
      this.#sql = query;
    }

    // The logging tests never assert on bound values (that is the point), so
    // this fake only has to accept them.
    bind(): D1StatementLike {
      return this;
    }

    async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
      options.onQuery?.();
      if (/^boom\b/i.test(this.#sql)) return { success: false, error: 'syntax error near "boom"' };
      return { success: true, results: [[1]] as unknown as T[], meta: { changes: 1 } };
    }

    async run(): Promise<D1ResultLike<never>> {
      options.onQuery?.();
      return { success: true, meta: { changes: 1 } };
    }
  }

  return {
    prepare: (query: string) => new Prepared(query),
    // Atomic, like D1: the first failure aborts the whole batch.
    async batch<T = Record<string, unknown>>(statements: readonly D1StatementLike[]) {
      const results: D1ResultLike<T>[] = [];
      for (const prepared of statements) {
        const result = await prepared.all<T>();
        if (!result.success) return [result];
        results.push(result);
      }
      return results;
    },
    exec: async () => ({ count: 1, duration: 0 }),
  };
}

function capture() {
  const events: QueryLogEvent[] = [];
  return {
    events,
    // Only query events are recorded: the transaction-open warning is covered by
    // its own test, and filtering here keeps every assertion below about SQL.
    log: (event: DatabaseLogEvent) => {
      if (event.event === 'db.query') events.push(event);
    },
  };
}

describe('database · query logging with redaction (DB-009)', () => {
  test('parameter values never appear — only their types and count', async () => {
    const { events, log } = capture();
    const database = createDatabase({
      driver: createD1Driver({ binding: fakeD1() }),
      logging: 'all',
      log,
    });

    await database.query(
      statement('SELECT * FROM users WHERE email = ? AND age > ? AND active = ?', [
        'ada@example.com',
        37,
        true,
      ]),
    );

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.event).toBe('db.query');
    expect(event?.paramTypes).toEqual(['string', 'number', 'boolean']);
    expect(event?.paramCount).toBe(3);
    expect(event?.ok).toBe(true);
    // The values themselves must not be in the event, in any field. The two
    // numeric fields are dropped first: a duration of 0.37 ms would contain
    // "37" by coincidence and make this assertion flaky rather than strict.
    const serialised = JSON.stringify({ ...event, durationMs: 0, rows: 0 });
    expect(serialised).not.toContain('ada@example.com');
    expect(serialised).not.toContain('37');
  });

  test('literals in hand-written SQL are scrubbed out of the logged text', async () => {
    const { events, log } = capture();
    const database = createDatabase({
      driver: createD1Driver({ binding: fakeD1() }),
      logging: 'all',
      log,
    });

    await database.query(statement("SELECT * FROM users WHERE email = 'ada@example.com'"));

    expect(events[0]?.sql).toBe('SELECT * FROM users WHERE email = ?');
    expect(JSON.stringify(events[0])).not.toContain('ada@example.com');
  });

  test('scrubSql collapses whitespace and scrubs literals, never identifiers', () => {
    expect(scrubSql("select  *\n  from t\n where a = 'x' and b = 'y'")).toBe(
      'select * from t where a = ? and b = ?',
    );
    // Escaped quotes stay inside one literal rather than ending it early.
    expect(scrubSql("select 'it''s'")).toBe('select ?');
    // Double quotes are identifiers in SQL. Scrubbing them turned every Drizzle
    // query into `select ?, ? from ?` — a log with nothing left to read.
    expect(scrubSql('select "users"."email" from "users" where "users"."id" = $1')).toBe(
      'select "users"."email" from "users" where "users"."id" = $1',
    );
  });

  test('the slow level logs only statements at or above the threshold', async () => {
    const { events, log } = capture();
    const clock = testClock();
    const database = createDatabase({
      driver: createD1Driver({ binding: fakeD1({ onQuery: () => clock.advance(250) }) }),
      logging: 'slow',
      slowQueryMs: 200,
      log,
      clock,
    });

    await database.query(statement('SELECT 1'));
    expect(events).toHaveLength(1);
    expect(events[0]?.durationMs).toBe(250);
  });

  test('a fast query under the slow threshold is not logged', async () => {
    const { events, log } = capture();
    const clock = testClock();
    const database = createDatabase({
      driver: createD1Driver({ binding: fakeD1({ onQuery: () => clock.advance(5) }) }),
      logging: 'slow',
      slowQueryMs: 200,
      log,
      clock,
    });

    await database.query(statement('SELECT 1'));
    expect(events).toHaveLength(0);
  });

  test('off logs nothing at all, even on failure', async () => {
    const { events, log } = capture();
    const database = createDatabase({
      driver: createD1Driver({ binding: fakeD1() }),
      logging: 'off',
      log,
    });

    await database.query(statement('SELECT 1'));
    await database.query(statement('boom')).catch(() => undefined);

    expect(events).toHaveLength(0);
  });

  test('a failure is logged at every other level, however fast it was', async () => {
    const { events, log } = capture();
    const database = createDatabase({
      driver: createD1Driver({ binding: fakeD1() }),
      logging: 'slow',
      slowQueryMs: 10_000, // nothing is this slow
      log,
    });

    const error = await database.query(statement('boom')).then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );

    // The driver still throws — logging must not swallow the failure…
    expect(error?.message).toContain('syntax error');
    // …and a 3 ms error is still an error worth a line.
    expect(events).toHaveLength(1);
    expect(events[0]?.ok).toBe(false);
    expect(events[0]?.error).toContain('syntax error');
  });

  test('every statement in a batch is logged once, and no value leaks', async () => {
    const { events, log } = capture();
    const database = createDatabase({
      driver: createD1Driver({ binding: fakeD1() }),
      logging: 'all',
      log,
    });

    await database.batch([
      statement('INSERT INTO users (email) VALUES (?)', ['a@example.com']),
      statement('INSERT INTO users (email) VALUES (?)', ['b@example.com']),
    ]);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.sql)).toEqual([
      'INSERT INTO users (email) VALUES (?)',
      'INSERT INTO users (email) VALUES (?)',
    ]);
    expect(JSON.stringify(events)).not.toContain('@example.com');
  });

  test('shouldLog is total over the three levels', () => {
    expect(shouldLog('off', 10_000, 200, false)).toBe(false);
    expect(shouldLog('slow', 199, 200, true)).toBe(false);
    expect(shouldLog('slow', 200, 200, true)).toBe(true);
    expect(shouldLog('slow', 1, 200, false)).toBe(true);
    expect(shouldLog('all', 0, 200, true)).toBe(true);
  });

  test('paramType classifies a value without looking at it', () => {
    expect(paramType('a')).toBe('string');
    expect(paramType(1)).toBe('number');
    expect(paramType(1n)).toBe('bigint');
    expect(paramType(true)).toBe('boolean');
    expect(paramType(null)).toBe('null');
    expect(paramType(undefined)).toBe('undefined');
    expect(paramType(new Date())).toBe('date');
    expect(paramType(new Uint8Array([1]))).toBe('bytes');
    expect(paramType([1, 2])).toBe('array');
    expect(paramType(() => undefined)).toBe('function');
    expect(paramType({ a: 1 })).toBe('object');
  });
});
