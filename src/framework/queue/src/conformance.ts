/**
 * The driver conformance kit (`§ 5`), for queues.
 *
 * Every driver — ours and anyone else's — must satisfy the same message lifecycle, and the
 * lifecycle is written once here as **data**: named cases, each a function that throws on
 * violation. No test framework is imported, because a third-party driver author should be able
 * to run this under whatever runner they already have:
 *
 * ```ts
 * import { conformanceCases } from '@tsir/queue/conformance';
 * for (const c of conformanceCases({ driver: myDriver() })) test(c.name, () => c.run());
 * ```
 *
 * The three properties the kit exists to enforce, because each one is invisible until
 * production:
 *
 *   · **A lease is a promise.** While it holds, no second worker sees the message; when it
 *     expires, the work resumes with the attempt count that reflects the abandoned run.
 *   · **Nothing is dropped.** A message that cannot succeed lands in the dead-letter store with
 *     its error, and only a replay or a discard gets it out.
 *   · **`attempts` on a reserved message counts the attempt being started.** The worker uses it
 *     verbatim; a driver that returns `0` here makes every job run one extra time.
 */

import type { JobMessage, QueueBackend, QueueDriver } from './port.ts';

export interface ConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface ConformanceOptions<Config = unknown> {
  readonly driver: QueueDriver<Config>;
  readonly config?: Config | undefined;
  /** The connection the test messages are addressed to. Default `conformance`. */
  readonly connection?: string | undefined;
  /**
   * What the driver is, which decides which cases can be honestly asked of it:
   *
   *   · `'broker'` (default) — the driver owns the store *and* the lease: `memory`, `database`.
   *   · `'inline'` — `push` runs the work and stores nothing: `sync`.
   *   · `'platform'` — the messages live in a broker this driver does not own, and the **lease
   *     is the platform's**: `cloudflare-queues`, `sqs`. The kit still proves what the port
   *     owns (delivery, acknowledgement, dead letters, addressing, idempotency) and skips the
   *     cases that would only be testing the platform's own clock — expiry and re-lease.
   *     Those are covered where they belong: in the driver's tests, against a fake platform.
   */
  readonly behaviour?: 'broker' | 'inline' | 'platform' | undefined;
  /**
   * Push-driven drivers (`cloudflare-queues`) hand the worker nothing until the platform
   * delivers a batch. `flush` is the harness's way of saying "the platform has delivered".
   *
   * It receives the backend the **case** opened, because the kit opens a fresh one per case —
   * a flush closed over a different instance would fill an inbox nobody reads, and the case
   * would fail for a reason that has nothing to do with the driver.
   */
  readonly flush?: ((backend: QueueBackend) => Promise<void>) | undefined;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`conformance: ${message}`);
}

const LEASE = 30_000;
const START = 1_000_000;

/** A message the backend can hold. `attempts: 0` means "never run". */
function message(id: string, connection: string, overrides: Partial<JobMessage> = {}): JobMessage {
  return {
    id,
    name: 'Conformance',
    payload: '{"ok":true}',
    connection,
    attempts: 0,
    maxAttempts: 3,
    availableAt: START,
    createdAt: START,
    ...overrides,
  };
}

export function conformanceCases<Config = unknown>(
  options: ConformanceOptions<Config>,
): readonly ConformanceCase[] {
  const { driver } = options;
  const capabilities = driver.capabilities;
  const connection = options.connection ?? 'conformance';
  const inline = options.behaviour === 'inline';
  const platform = options.behaviour === 'platform';
  const name = driver.name;
  const cases: ConformanceCase[] = [];

  /** A backend per case, so one failure cannot leave another case's rows behind. */
  const open = (): QueueBackend => driver.open(options.config);

  /** Push → (the platform delivers) → reserve. A no-op for drivers that pull. */
  const settle = async (backend: QueueBackend): Promise<void> => {
    if (options.flush !== undefined) await options.flush(backend);
  };

  if (inline) {
    cases.push({
      name: `${name}: push runs the work and stores nothing`,
      async run() {
        const backend = open();
        await backend.push(message(`${name}-inline`, connection));

        // There is nothing to reserve: the work already happened inside `push`.
        const reserved = await backend.reserve({
          connection,
          limit: 10,
          now: START,
          leaseMs: LEASE,
        });
        assert(reserved.length === 0, 'an inline driver must not leave messages to reserve');
        assert((await backend.size()) === 0, 'an inline driver stores nothing');
      },
    });

    cases.push({
      name: `${name}: a dead-lettered inline failure is listed and discardable`,
      async run() {
        const backend = open();
        const id = `${name}-inline-dead`;
        await backend.fail(message(id, connection), { error: 'inline failure' });

        const dead = await backend.dead(10);
        assert(
          dead.some((entry) => entry.id === id),
          'a failed inline job lands in the dead-letter store',
        );
        assert(
          dead.find((entry) => entry.id === id)?.lastError === 'inline failure',
          'the dead letter keeps the error that produced it',
        );
        assert((await backend.discard(id)) === true, 'discard removes a dead letter');
        assert((await backend.discard(id)) === false, 'discarding twice reports nothing removed');
      },
    });

    return cases;
  }

  cases.push({
    name: `${name}: push, reserve, complete is one round trip`,
    async run() {
      const backend = open();
      const id = `${name}-round-trip`;
      await backend.push(message(id, connection));
      await settle(backend);

      const reserved = await backend.reserve({ connection, limit: 1, now: START, leaseMs: LEASE });
      assert(reserved.length === 1, 'a pushed message is reservable');
      assert(reserved[0]?.id === id, 'the reserved message is the one that was pushed');
      assert(
        reserved[0]?.attempts === 1,
        `reserve counts the attempt it is starting (got ${String(reserved[0]?.attempts)}); the worker does not increment`,
      );
      assert(
        reserved[0]?.payload === '{"ok":true}',
        'the payload survives the round trip untouched',
      );

      const message0 = reserved[0];
      assert(message0 !== undefined, 'reserved');
      await backend.complete(message0);
      assert(
        !(await backend.dead(10)).some((entry) => entry.id === id),
        'a completed message is not a dead letter',
      );
      const again = await backend.reserve({ connection, limit: 1, now: START + 1, leaseMs: LEASE });
      assert(again.length === 0, 'a completed message is gone, not merely leased');
    },
  });

  if (!platform) {
    cases.push({
      name: `${name}: a lease hides the message, and expiry returns it with the attempt counted`,
      async run() {
        const backend = open();
        const id = `${name}-lease`;
        await backend.push(message(id, connection));

        const first = await backend.reserve({ connection, limit: 1, now: START, leaseMs: LEASE });
        assert(first.length === 1, 'the first reserve takes the message');

        const during = await backend.reserve({
          connection,
          limit: 1,
          now: START + LEASE - 1,
          leaseMs: LEASE,
        });
        assert(
          during.length === 0,
          'a leased message is invisible to another worker until the lease expires',
        );

        const after = await backend.reserve({
          connection,
          limit: 1,
          now: START + LEASE,
          leaseMs: LEASE,
        });
        assert(after.length === 1, 'an expired lease returns the message');
        assert(
          after[0]?.attempts === 2,
          `the returned message reports attempt 2 (got ${String(after[0]?.attempts)})`,
        );
      },
    });
  }

  if (platform) {
    cases.push({
      name: `${name}: the queue is the address, so routing already happened`,
      async run() {
        const backend = open();
        // A broker routes by queue: the message is in *this* queue because it belongs here, and
        // whatever the payload says about connections, refusing it would strand it. That is the
        // opposite of the `database` driver, where one table holds every connection and
        // `reserve({ connection })` must filter — which is why both cases exist.
        await backend.push(message(`${name}-addressed`, `${connection}-other`));
        await settle(backend);

        const claimed = await backend.reserve({
          connection,
          limit: 10,
          now: START,
          leaseMs: LEASE,
        });
        assert(
          claimed.some((entry) => entry.id === `${name}-addressed`),
          'a message in this queue is claimed, whatever its payload claims',
        );
      },
    });
  } else {
    cases.push({
      name: `${name}: a message is only reservable on its own connection`,
      async run() {
        const backend = open();
        const id = `${name}-addressed`;
        await backend.push(message(id, connection));
        await settle(backend);

        const elsewhere = await backend.reserve({
          connection: `${connection}-other`,
          limit: 10,
          now: START,
          leaseMs: LEASE,
        });
        assert(elsewhere.length === 0, 'a message is addressed: another connection never sees it');

        const here = await backend.reserve({ connection, limit: 10, now: START, leaseMs: LEASE });
        assert(
          here.some((entry) => entry.id === id),
          'and its own connection does',
        );
      },
    });
  }

  if (capabilities.delay && !platform) {
    cases.push({
      name: `${name}: a message that is not due yet waits`,
      async run() {
        const backend = open();
        const id = `${name}-delayed`;
        await backend.push(message(id, connection, { availableAt: START + 10_000 }));

        const early = await backend.reserve({ connection, limit: 10, now: START, leaseMs: LEASE });
        assert(early.length === 0, 'a delayed message is not reservable early');

        const onTime = await backend.reserve({
          connection,
          limit: 10,
          now: START + 10_000,
          leaseMs: LEASE,
        });
        assert(
          onTime.some((entry) => entry.id === id),
          'and it is reservable when its time arrives',
        );
      },
    });
  }

  if (capabilities.deadLetter) {
    cases.push({
      name: `${name}: a failure is retried at the delay it was given`,
      async run() {
        const backend = open();
        const id = `${name}-retry`;
        await backend.push(message(id, connection));
        await settle(backend);

        const [reserved] = await backend.reserve({
          connection,
          limit: 1,
          now: START,
          leaseMs: LEASE,
        });
        assert(reserved !== undefined, 'reserved');
        await backend.fail(reserved, { error: 'try again', retryAt: START + 5_000 });

        const tooEarly = await backend.reserve({
          connection,
          limit: 1,
          now: START + 4_999,
          leaseMs: LEASE,
        });
        assert(tooEarly.length === 0, 'a retry waits for its retryAt');

        const due = await backend.reserve({
          connection,
          limit: 1,
          now: START + 5_000,
          leaseMs: LEASE,
        });
        assert(due.length === 1, 'a retry is reservable at retryAt');
        assert(due[0]?.attempts === 2, 'the retry is the second attempt');
        assert(
          due[0]?.lastError === 'try again',
          'the last error travels with the message, so the log can report it',
        );
      },
    });

    cases.push({
      name: `${name}: a failure with no retryAt becomes a dead letter, and replay resets it`,
      async run() {
        const backend = open();
        const id = `${name}-dead`;
        await backend.push(message(id, connection));
        await settle(backend);

        const [reserved] = await backend.reserve({
          connection,
          limit: 1,
          now: START,
          leaseMs: LEASE,
        });
        assert(reserved !== undefined, 'reserved');
        await backend.fail(reserved, { error: 'spent' });

        const dead = await backend.dead(10);
        const entry = dead.find((candidate) => candidate.id === id);
        assert(
          entry !== undefined,
          'an exhausted message is in the dead-letter store, never dropped',
        );
        assert(entry.lastError === 'spent', 'the dead letter keeps its error');

        const live = await backend.reserve({
          connection,
          limit: 10,
          now: START + LEASE,
          leaseMs: LEASE,
        });
        assert(!live.some((candidate) => candidate.id === id), 'a dead message is not reservable');

        assert((await backend.replay(id, START + LEASE)) === true, 'replay moves it back');
        assert(
          !(await backend.dead(10)).some((candidate) => candidate.id === id),
          'and out of the dead-letter store',
        );

        const replayed = await backend.reserve({
          connection,
          limit: 10,
          now: START + LEASE,
          leaseMs: LEASE,
        });
        const again = replayed.find((candidate) => candidate.id === id);
        assert(again !== undefined, 'a replayed message runs again');
        assert(again.attempts === 1, `with a fresh budget (got attempt ${String(again.attempts)})`);
        assert(
          (await backend.replay(`${id}-missing`, START)) === false,
          'replaying nothing reports false',
        );
      },
    });

    cases.push({
      name: `${name}: discard removes a dead message and reports whether it removed one`,
      async run() {
        const backend = open();
        const id = `${name}-discard`;
        await backend.push(message(id, connection));
        await settle(backend);
        const [reserved] = await backend.reserve({
          connection,
          limit: 1,
          now: START,
          leaseMs: LEASE,
        });
        assert(reserved !== undefined, 'reserved');
        await backend.fail(reserved, { error: 'gone' });

        assert((await backend.discard(id)) === true, 'discard reports the removal');
        assert((await backend.discard(id)) === false, 'and reports the second, empty one');
        assert(
          !(await backend.dead(10)).some((entry) => entry.id === id),
          'the dead letter is gone',
        );
      },
    });
  }

  if (capabilities.idempotency) {
    cases.push({
      name: `${name}: one idempotency key delivers once`,
      async run() {
        const backend = open();
        const key = `${name}-key-${String(Date.now())}`;
        await backend.push(message(`${name}-key-a`, connection, { idempotencyKey: key }));
        await backend.push(message(`${name}-key-b`, connection, { idempotencyKey: key }));
        await settle(backend);

        const reserved = await backend.reserve({
          connection,
          limit: 10,
          now: START,
          leaseMs: LEASE,
        });
        const keyed = reserved.filter((entry) => entry.idempotencyKey === key);
        assert(
          keyed.length === 1,
          `a duplicate key must not deliver twice (delivered ${String(keyed.length)})`,
        );
      },
    });
  } else {
    cases.push({
      name: `${name}: it does not claim idempotency it cannot enforce`,
      async run() {
        const backend = open();
        const key = `${name}-key-${String(Date.now())}`;
        await backend.push(message(`${name}-key-a`, connection, { idempotencyKey: key }));
        await backend.push(message(`${name}-key-b`, connection, { idempotencyKey: key }));
        await settle(backend);

        const reserved = await backend.reserve({
          connection,
          limit: 10,
          now: START,
          leaseMs: LEASE,
        });
        const keyed = reserved.filter((entry) => entry.idempotencyKey === key);
        // Not a failure — a *documented* limit. The one thing the kit will not allow is the
        // third option: a driver that reports `idempotency: true` and then delivers twice.
        assert(
          keyed.length <= 2,
          `an honest driver may deliver twice (delivered ${String(keyed.length)})`,
        );
      },
    });
  }

  return cases;
}
