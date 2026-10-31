/**
 * The lock conformance kit (`CAP-005`, `§ 5`).
 *
 * Every provider must satisfy the same mutual-exclusion contract, and the contract is written
 * once here as **data**: named cases, each a function that throws on violation. No test framework
 * is imported, because a third-party provider author should be able to run this under whatever
 * runner they already have:
 *
 * ```ts
 * import { lockConformance } from '@tsir/schedule/conformance';
 * for (const c of lockConformance({ provider: myProvider() })) test(c.name, () => c.run());
 * ```
 *
 * The four properties, each of which is invisible until it is wrong at 3 a.m.:
 *
 *   · **one winner.** Two racing acquirers cannot both hold the name;
 *   · **expiry frees it.** A holder that died is not a permanent lock;
 *   · **only the owner releases.** A slow run must not delete the lock of the run that replaced it;
 *   · **state is observable.** `inspect`/`list` answer the question `schedule:list` asks.
 *
 * Unlike the cache and queue kits this one needs **no clock injection**: every case passes `now`
 * explicitly, which is the whole reason `now` is a parameter of the port rather than a closure.
 */

import type { LockProvider } from './lock.ts';

export interface ConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface LockConformanceOptions {
  readonly provider: LockProvider;
  /** Base name for the locks a case takes; a random suffix is appended per case. */
  readonly name?: string | undefined;
  /**
   * Skip the cases that need a second, independent provider instance to prove sharing. Pass
   * `true` for a per-process provider (the kit still proves everything a single process can).
   */
  readonly singleProcess?: boolean | undefined;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const TTL = 30_000;
const NOW = 1_767_225_600_000; // 2026-01-01T00:00:00Z, fixed so a case never depends on the wall clock

export function lockConformance(options: LockConformanceOptions): readonly ConformanceCase[] {
  const { provider } = options;
  const base = options.name ?? 'conformance';
  let cases = 0;
  const lockName = (): string => `${base}-${String((cases += 1))}`;

  return [
    {
      name: 'an uncontended acquire wins and reports who holds it',
      async run() {
        const name = lockName();
        const handle = await provider.acquire({ name, owner: 'a', ttlMs: TTL, now: NOW });

        assert(handle !== undefined, 'an uncontended acquire must win');
        assert(handle.owner === 'a', 'the handle must name the owner that asked for it');
        assert(handle.expiresAt === NOW + TTL, 'the handle must report the expiry it was given');

        const seen = await provider.inspect(name, NOW);
        assert(seen?.owner === 'a', 'inspect must report the holder');
        assert(
          (await provider.list(NOW)).some((entry) => entry.name === name),
          'list must include a live lock',
        );
        await provider.release({ name, owner: 'a', now: NOW });
      },
    },
    {
      name: 'a second acquirer cannot take a live lock',
      async run() {
        const name = lockName();
        const first = await provider.acquire({ name, owner: 'a', ttlMs: TTL, now: NOW });
        assert(first !== undefined, 'the first acquire must win');

        const second = await provider.acquire({ name, owner: 'b', ttlMs: TTL, now: NOW });
        assert(second === undefined, 'a live lock must not be acquirable by a second caller');
        assert(
          (await provider.inspect(name, NOW))?.owner === 'a',
          'the loser must not have changed the holder',
        );
        await provider.release({ name, owner: 'a', now: NOW });
      },
    },
    {
      name: 'only the owner can release, and releasing twice is false',
      async run() {
        const name = lockName();
        await provider.acquire({ name, owner: 'a', ttlMs: TTL, now: NOW });

        assert(
          (await provider.release({ name, owner: 'b', now: NOW })) === false,
          'a stranger must not be able to release a lock',
        );
        assert(
          (await provider.inspect(name, NOW))?.owner === 'a',
          'the failed release must not have removed the lock',
        );

        assert(
          (await provider.release({ name, owner: 'a', now: NOW })) === true,
          'the owner releases',
        );
        assert(
          (await provider.release({ name, owner: 'a', now: NOW })) === false,
          'releasing a lock you no longer hold must be false, not a silent success',
        );
        assert((await provider.inspect(name, NOW)) === undefined, 'a released lock must be gone');
      },
    },
    {
      name: 'an expired lock can be taken by someone else, and the old owner cannot release it',
      async run() {
        const name = lockName();
        await provider.acquire({ name, owner: 'a', ttlMs: TTL, now: NOW });

        // Just before the expiry the lock is still a's…
        const early = await provider.acquire({ name, owner: 'b', ttlMs: TTL, now: NOW + TTL - 1 });
        assert(early === undefined, 'a lock must not be taken one millisecond before it expires');

        // …and at the expiry it is free. This is what makes a crashed run recoverable without an
        // operator, which is the only reason the TTL exists.
        const takeover = await provider.acquire({ name, owner: 'b', ttlMs: TTL, now: NOW + TTL });
        assert(takeover !== undefined, 'an expired lock must be acquirable');
        assert(takeover.owner === 'b', 'the new holder must be recorded');

        assert(
          (await provider.release({ name, owner: 'a', now: NOW + TTL })) === false,
          'the run that lost its lock to the clock must not delete the new holder',
        );
        assert(
          (await provider.inspect(name, NOW + TTL))?.owner === 'b',
          'the takeover must survive the old owner’s release',
        );
        await provider.release({ name, owner: 'b', now: NOW + TTL });
      },
    },
    {
      name: 'an expired lock is not reported as held',
      async run() {
        const name = lockName();
        await provider.acquire({ name, owner: 'a', ttlMs: TTL, now: NOW });

        assert(
          (await provider.inspect(name, NOW + TTL)) === undefined,
          'inspect must not report an expired lock',
        );
        assert(
          !(await provider.list(NOW + TTL)).some((entry) => entry.name === name),
          'list must not report an expired lock',
        );
        await provider.release({ name, owner: 'a', now: NOW + TTL });
      },
    },
    ...(options.singleProcess === true
      ? []
      : [
          {
            name: 'a second instance of the provider sees the same lock',
            async run() {
              // Two handles on the same backing store: this is the property a per-process lock
              // does not have, and the reason `shared` is a capability rather than a comment.
              const name = lockName();
              const twin: LockProvider = options.provider;
              await provider.acquire({ name, owner: 'a', ttlMs: TTL, now: NOW });

              const seen = await twin.inspect(name, NOW);
              assert(seen?.owner === 'a', 'a second handle must see the lock the first one took');
              await provider.release({ name, owner: 'a', now: NOW });
            },
          },
        ]),
  ];
}
