import { describe, expect, test } from 'bun:test';
import { TsirError } from '@tsir/container';
import { expectTsirError, fixedClock, seededIds, seededRandom } from './index.ts';
/** Awaits a promise that must reject, and returns the rejection's message. Fails if it resolves. */
async function caught(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the promise to reject');
}

describe('fixedClock (TST-005)', () => {
  test('stands still until told to move, and both readings agree', () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z');

    expect(clock.iso()).toBe('2026-01-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(clock.monotonicMs()).toBe(0);
  });

  test('advance moves both the wall clock and the monotonic clock', () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z');

    clock.advance(1500);

    expect(clock.iso()).toBe('2026-01-01T00:00:01.500Z');
    expect(clock.monotonicMs()).toBe(1500);
  });

  test('set moves the wall clock to an instant without touching the monotonic clock', () => {
    const clock = fixedClock();

    clock.set('2030-06-15T12:00:00.000Z');

    expect(clock.iso()).toBe('2030-06-15T12:00:00.000Z');
    expect(clock.monotonicMs()).toBe(0);
  });
});

describe('seededRandom (TST-005)', () => {
  test('the same seed yields the same sequence, so fixtures are identical across runs', () => {
    const first = seededRandom(42);
    const second = seededRandom(42);

    expect([first.next(), first.next(), first.next()]).toEqual([
      second.next(),
      second.next(),
      second.next(),
    ]);
    expect(first.uuid()).toBe(second.uuid());
    expect([...first.bytes(8)]).toEqual([...second.bytes(8)]);
  });

  test('a different seed yields a different sequence', () => {
    expect(seededRandom(1).next()).not.toBe(seededRandom(2).next());
  });

  test('uuid is a version 4 identifier with the RFC 4122 variant', () => {
    const id = seededRandom(7).uuid();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  test('next stays in [0, 1)', () => {
    const random = seededRandom(99);
    for (let index = 0; index < 1000; index += 1) {
      const value = random.next();
      expect(value >= 0 && value < 1).toBe(true);
    }
  });
});

describe('expectTsirError (TST-006)', () => {
  test('passes when the thrown error carries the code, and returns it', async () => {
    const error = await expectTsirError(() => {
      throw new TsirError('CFG_MISSING_KEY', 'a message that may change', { kind: 'config' });
    }, 'CFG_MISSING_KEY');

    expect(error.code).toBe('CFG_MISSING_KEY');
  });

  test('fails when the code differs, and does not depend on the message', async () => {
    expect(
      await caught(
        expectTsirError(() => {
          throw new TsirError('CFG_MISSING_KEY', 'x', { kind: 'config' });
        }, 'CFG_UNKNOWN_KEY'),
      ),
    ).toContain('received "CFG_MISSING_KEY"');
  });

  test('fails when nothing is thrown', async () => {
    expect(await caught(expectTsirError(() => 'no error', 'CFG_MISSING_KEY'))).toContain(
      'but nothing was thrown',
    );
  });
});

describe('seededIds (TST-005)', () => {
  test('the same seed and prefix give the same ids, in the same order', () => {
    const first = seededIds(7, 'user');
    const second = seededIds(7, 'user');
    expect([first.next(), first.next(), first.next()]).toEqual([
      second.next(),
      second.next(),
      second.next(),
    ]);
  });

  test('ids carry the prefix and are 32 hex digits after it', () => {
    expect(seededIds(1, 'order').next()).toMatch(/^order_[0-9a-f]{32}$/u);
    expect(seededIds(1).next()).toMatch(/^id_[0-9a-f]{32}$/u);
  });

  test('different seeds give different sequences', () => {
    expect(seededIds(1).next()).not.toBe(seededIds(2).next());
  });

  test('reset starts the sequence again, so a rebuilt fixture gets identical ids', () => {
    const ids = seededIds(9);
    const run = [ids.next(), ids.next()];
    ids.reset();
    expect([ids.next(), ids.next()]).toEqual(run);
  });
});
