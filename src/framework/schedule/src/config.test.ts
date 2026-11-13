/**
 * The `schedule.lock` registry.
 *
 * The section was accepted by `@tsir/config` and by the console's schema and read by nothing, so it
 * validated and did nothing. That is worse than a missing section: it looks configured. These cases
 * pin the two ways that shows up — a lock that does not agree across instances, and a driver that
 * cannot express the acquire it needs.
 */
import { describe, expect, test } from 'bun:test';

import { TsirError } from '@tsir/container';

import { lockFromConfig, LOCK_DRIVERS, PERSISTENT_LOCK_DRIVERS } from './config.ts';
import type { LockSql } from './lock.ts';

/** The `hint` carries the actionable part; `String(error)` cannot see it. */
function rendered(error: unknown): string {
  return error instanceof TsirError ? error.format() : String(error);
}

const sql: LockSql = {
  capabilities: { engine: 'postgres', placeholder: 'dollar' },
  query: async () => ({ rows: [], changes: 0 }),
};

describe('schedule lock from config', () => {
  test('no section means no lock, rather than a memory one', () => {
    expect(lockFromConfig({ lock: undefined })).toBeUndefined();
  });

  test('the database lock is built over the app connection', () => {
    expect(lockFromConfig({ lock: { driver: 'database' }, sql })).toBeDefined();
  });

  test('memory is refused in production', () => {
    // Two instances, two maps, both see the lock as free, both run the task. The failure is a
    // duplicated job, and there is no error in it to grep for.
    const error = (() => {
      try {
        lockFromConfig({ lock: { driver: 'memory' }, production: true });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as TsirError).code).toBe('SCHED_LOCK_REFUSED');
    expect(rendered(error)).toContain('database');
  });

  test('memory is allowed outside production', () => {
    expect(lockFromConfig({ lock: { driver: 'memory' }, production: false })).toBeDefined();
  });

  test('a database lock with no connection refuses at construction', () => {
    // Without one there is nothing to hold the lock in, and a scheduler that silently does not
    // lock is worse than one that does not start.
    const error = (() => {
      try {
        lockFromConfig({ lock: { driver: 'database' } });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as TsirError).code).toBe('SCHED_LOCK_REFUSED');
    expect(rendered(error)).toContain('connection');
  });

  test('mysql is refused, because the acquire has no portable form there', () => {
    // `ON DUPLICATE KEY UPDATE` has no `WHERE`, so the same statement would take a live lock. The
    // refusal belongs here, while the config is still the thing being read.
    const mysql: LockSql = {
      capabilities: { engine: 'mysql', placeholder: 'question' },
      query: async () => ({ rows: [], changes: 0 }),
    };
    const error = (() => {
      try {
        lockFromConfig({ lock: { driver: 'database' }, sql: mysql });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as TsirError).code).toBe('SCHED_LOCK_REFUSED');
  });

  test('an unknown driver lists the ones this build ships', () => {
    const error = (() => {
      try {
        lockFromConfig({ lock: { driver: 'redis' }, sql });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as TsirError).code).toBe('SCHED_LOCK_REFUSED');
    const text = rendered(error);
    for (const driver of LOCK_DRIVERS) expect(text).toContain(driver);
  });

  test('the persistent list is the part of the shipped list that agrees across processes', () => {
    expect(PERSISTENT_LOCK_DRIVERS).toEqual(['database']);
    for (const driver of PERSISTENT_LOCK_DRIVERS) {
      expect(LOCK_DRIVERS as readonly string[]).toContain(driver);
    }
  });
});
